#!/usr/bin/env python3
"""VOID Qwen3-TTS 本地语音服务。

职责边界：
- 只在本机 127.0.0.1 监听，由 Node sidecar 拉起/监督；
- 加载 Qwen3-TTS CustomVoice 模型，按 speaker/language/style 合成；
- 输出 24kHz PCM16LE，统一做响度归一化与长静音压缩；
- 不做鉴权以外的业务判断，不读取用户录音，不做声音克隆。

启动示例：
  python qwen3_tts_server.py --port 17874 --model-dir <model> --token <token>
"""

from __future__ import annotations

import argparse
import json
import os
import re
import threading
import time
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import numpy as np
import psutil
import torch

MODEL_NAME = "Qwen3-TTS-12Hz-1.7B-CustomVoice"
DEFAULT_SPEAKER = "ono_anna"
MAX_TEXT_CHARS = 500
SAMPLE_RATE_FALLBACK = 24000
TARGET_RMS = 0.052
# 停顿规范化（业界做法：silence truncation + 固定句间间隔，不把停顿交给模型）。
# - 句内停顿超过 LONG_PAUSE_THRESHOLD_S 才裁，裁到 MAX_INTERNAL_PAUSE_S；
# - 句首/句尾静音统一裁到固定预算，拼接处不会出现“空一大截”或“贴太紧”；
# - 不加长停顿：Qwen3-TTS 不解析 SSML，长停顿只会放大换气声。
MAX_INTERNAL_PAUSE_S = 0.20
LONG_PAUSE_THRESHOLD_S = 0.34
EDGE_LEAD_S = 0.06
EDGE_TAIL_S = 0.09
EDGE_FADE_S = 0.012
IDLE_UNLOAD_SECONDS = 300
MAX_CACHE_ENTRIES = 32


def _instruct_for(style: str) -> str:
    """把业务风格映射成模型可执行的 instruct。

    实测英文祈使句是最稳定的杠杆（中文/参数模板更弱）。官方与社区经验：
    要写具体声学描述、保持 1–3 句、给出明确的节奏约束；"relaxed" 这类词会
    让模型放软、加大换气，因此统一改成“稳定语速 + 短停顿”。
    """
    if style == "happy":
        return (
            "Speak in a warm, cheerful, steady tone at a steady pace. "
            "Keep pauses between sentences short."
        )
    if style == "serious":
        return (
            "Speak in a calm, serious, restrained tone at a steady pace. "
            "Keep pauses between sentences short."
        )
    return (
        "Speak in a natural conversational tone at a steady pace. "
        "Keep pauses between sentences short."
    )


def _detect_language(text: str, requested: str | None) -> str:
    if requested in ("zh", "ja"):
        return requested
    if requested and requested.lower() in ("chinese", "zh-cn", "mandarin"):
        return "zh"
    if requested and requested.lower() in ("japanese", "ja-jp"):
        return "ja"
    # 没有显式语言时，按假名/日文标点判断；只有纯汉字时按中文处理。
    return "ja" if re.search(r"[\u3040-\u30ff]", text) else "zh"


def _normalize_pauses(samples: np.ndarray, sample_rate: int) -> np.ndarray:
    """停顿规范化：裁句首/句尾静音 + 裁掉过长的句内停顿。

    业界（Auto-Editor / VoiceStudio / 播客后期链）的通用做法是：
    每段渲染自带前后静音，拼接时先裁边、再插入固定间隔，而不是让模型自由换气。
    这里按同一原则处理，避免“动不动大喘气”。
    """
    if samples.size == 0:
        return samples
    frame = max(1, int(sample_rate * 0.01))
    pad = np.pad(samples * samples, (0, frame), mode="constant")
    energy = np.sqrt(np.convolve(pad, np.ones(frame) / frame, mode="valid"))[: samples.size]
    threshold = max(0.008, float(np.percentile(energy, 60) * 0.15))
    voiced = energy > threshold
    if not voiced.any():
        return samples

    # energy / voiced 都是逐采样点长度，下面的下标一律按采样点计（不要再乘 frame）。
    first_voiced = int(np.argmax(voiced))
    last_voiced = int(len(voiced) - np.argmax(voiced[::-1]))
    lead_budget = int(sample_rate * EDGE_LEAD_S)
    tail_budget = int(sample_rate * EDGE_TAIL_S)
    max_pause = int(sample_rate * MAX_INTERNAL_PAUSE_S)
    min_cut = int(sample_rate * LONG_PAUSE_THRESHOLD_S)

    pieces: list[np.ndarray] = []
    cursor = max(0, first_voiced - lead_budget)
    index = first_voiced
    while index < last_voiced:
        if voiced[index]:
            index += 1
            continue
        end = index
        while end < last_voiced and not voiced[end]:
            end += 1
        pieces.append(samples[cursor:index])
        pause = end - index
        if pause <= min_cut:
            # 正常句读停顿：原样保留
            pieces.append(samples[index:end])
        else:
            # 超长停顿/换气：只保留前后边缘，总长压到 max_pause
            head = min(max_pause // 2, pause)
            tail = min(max_pause - head, pause - head)
            pieces.append(samples[index:index + head])
            pieces.append(samples[end - tail:end])
        cursor = end
        index = end

    end_sample = min(samples.size, last_voiced + tail_budget)
    pieces.append(samples[cursor:end_sample])
    trimmed = np.concatenate([piece for piece in pieces if piece.size > 0])
    return _apply_edge_fades(trimmed, sample_rate)


def _apply_edge_fades(samples: np.ndarray, sample_rate: int) -> np.ndarray:
    """给块首/块尾加极短淡入淡出，拼接时不爆音、不出现突兀起音。"""
    fade = min(int(sample_rate * EDGE_FADE_S), samples.size // 2)
    if fade <= 0:
        return samples
    ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)
    result = samples.copy()
    result[:fade] *= ramp
    result[-fade:] *= ramp[::-1]
    return result


def _normalize_loudness(samples: np.ndarray) -> np.ndarray:
    """按 voiced 帧 RMS 归一化，修正模型偶发低电平导致的“发闷”。"""
    if samples.size == 0:
        return samples
    frame = 480
    values: list[float] = []
    for index in range(0, samples.size - frame, frame):
        chunk = samples[index:index + frame]
        rms = float(np.sqrt(np.mean(chunk * chunk)))
        # 只统计明显有声的帧（≈ -34 dBFS 以上），把换气/底噪排除在增益计算外，
        # 否则轻微气声会被当成语音主体，反而被放大。
        if rms > 0.02:
            values.append(rms)
    # 取偏上分位而不是均值：更接近“语音主体电平”，对个别极响帧不敏感。
    current = float(np.percentile(values, 70)) if values else 0.0
    if current <= 1e-6:
        return samples
    gain = TARGET_RMS / current
    gain = min(gain, 6.0)
    peak = float(np.max(np.abs(samples)))
    if peak > 0:
        gain = min(gain, 0.95 / peak)
    return np.clip(samples * gain, -1.0, 1.0)


class QwenTtsRuntime:
    def __init__(self, model_dir: str, device: str, idle_unload_seconds: int) -> None:
        self.model_dir = model_dir
        self.device = device
        self.idle_unload_seconds = idle_unload_seconds
        self._model = None
        self._load_lock = threading.Lock()
        self._generate_lock = threading.Lock()
        self._cache_lock = threading.Lock()
        self._cache: OrderedDict[tuple[str, str, str, str], tuple[np.ndarray, int]] = OrderedDict()
        self._idle_timer: threading.Timer | None = None
        self._last_request_at = 0.0

    def _cancel_idle_timer(self) -> None:
        if self._idle_timer is not None:
            self._idle_timer.cancel()
            self._idle_timer = None

    def _schedule_idle_unload(self) -> None:
        self._cancel_idle_timer()
        if self.idle_unload_seconds <= 0:
            return
        self._idle_timer = threading.Timer(self.idle_unload_seconds, self._unload)
        self._idle_timer.daemon = True
        self._idle_timer.start()

    def _unload(self) -> None:
        with self._load_lock:
            self._model = None
            if self.device.startswith("cuda"):
                torch.cuda.empty_cache()
        print("[qwen3-tts] idle unloaded", flush=True)

    def _device_map(self) -> str:
        return self.device

    def _dtype(self):
        if self.device.startswith("cuda"):
            return torch.bfloat16
        return torch.float32

    def is_loaded(self) -> bool:
        return self._model is not None

    def get_model(self):
        with self._load_lock:
            if self._model is not None:
                return self._model
            from qwen_tts import Qwen3TTSModel

            started = time.time()
            self._model = Qwen3TTSModel.from_pretrained(
                self.model_dir,
                device_map=self._device_map(),
                dtype=self._dtype(),
            )
            print(
                f"[qwen3-tts] model loaded in {time.time() - started:.2f}s device={self.device}",
                flush=True,
            )
            return self._model

    def warmup(self) -> None:
        """启动后台预热：只付一次模型加载/首句编译成本，避免第一句真人回复超时。"""
        try:
            self.get_model()
            # 一次中文短句预热即可承担首句编译成本；不再预合成固定短语，
            # 避免把用不到的历史文案留在 LRU 里。
            self.synth("你好。", DEFAULT_SPEAKER, "zh", "neutral")
            print("[qwen3-tts] warmup done", flush=True)
        except Exception as error:  # noqa: BLE001 - 预热失败不杀服务，真实请求会给明确错误
            print(f"[qwen3-tts] warmup failed: {error}", flush=True)

    def _cache_get(self, key: tuple[str, str, str, str]) -> tuple[np.ndarray, int] | None:
        with self._cache_lock:
            cached = self._cache.get(key)
            if cached is None:
                return None
            self._cache.move_to_end(key)
            return cached

    def _cache_put(self, key: tuple[str, str, str, str], value: tuple[np.ndarray, int]) -> None:
        with self._cache_lock:
            self._cache[key] = value
            self._cache.move_to_end(key)
            while len(self._cache) > MAX_CACHE_ENTRIES:
                self._cache.popitem(last=False)

    def synth(self, text: str, speaker: str, language: str, style: str) -> tuple[np.ndarray, int, bool]:
        model = self.get_model()
        if speaker not in model.get_supported_speakers():
            raise ValueError(f"unknown speaker: {speaker}")
        self._last_request_at = time.time()
        cache_key = (text, speaker, language, style)
        cached = self._cache_get(cache_key)
        if cached is not None:
            return cached[0], cached[1], True
        instruct = _instruct_for(style)
        with self._generate_lock:
            self._cancel_idle_timer()
            # 硬上限防止模型偶发重复/空转。12Hz 下约 2.7 token/字；
            # 块已回到 20–60 字，这里给 ~1.8 倍余量即可，越长越容易在尾部加速/换气。
            max_new_tokens = min(380, max(150, round(len(text) * 6 + 50)))
            # 全风格统一：采样 + 固定种子 + 硬上限。实测 20 句 P50 2.7s / P95 6.3s，
            # 比 greedy（偶发 14–57s）稳定，也比无上限采样（偶发 15.8s）可控。
            torch.manual_seed(42)
            generate_kwargs = {
                "temperature": 0.7,
                "top_p": 0.9,
                "max_new_tokens": max_new_tokens
            }
            wavs, sample_rate = model.generate_custom_voice(
                text=text,
                speaker=speaker,
                language="Japanese" if language == "ja" else "Chinese",
                instruct=instruct,
                **generate_kwargs
            )
            samples = np.asarray(wavs[0], dtype=np.float32).reshape(-1)
            samples = _normalize_pauses(samples, int(sample_rate))
            samples = _normalize_loudness(samples)
            result = (samples, int(sample_rate))
            self._cache_put(cache_key, result)
            self._schedule_idle_unload()
            return result[0], result[1], False


class QwenTtsHandler(BaseHTTPRequestHandler):
    runtime: QwenTtsRuntime | None = None
    token: str = ""
    semaphore: threading.BoundedSemaphore | None = None

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[qwen3-tts] {fmt % args}", flush=True)

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionAbortedError):
            # 健康探测超时/客户端主动断开是正常路径，不刷 traceback。
            pass

    def _authorized(self) -> bool:
        if not self.token:
            return True
        return self.headers.get("X-VOID-Qwen-Token") == self.token

    def do_GET(self) -> None:
        if self.path != "/health":
            self._send_json(404, {"ok": False, "error": "not found"})
            return
        speakers: list[str] = []
        loaded = False
        if self.runtime is not None:
            loaded = self.runtime.is_loaded()
            if loaded:
                speakers = list(self.runtime.get_model().get_supported_speakers())
        self._send_json(200, {
            "ok": True,
            "model": MODEL_NAME,
            "device": self.runtime.device if self.runtime else "",
            "loaded": loaded,
            "speakers": speakers,
        })

    def do_POST(self) -> None:
        if self.path != "/tts":
            self._send_json(404, {"ok": False, "error": "not found"})
            return
        if not self._authorized():
            self._send_json(403, {"ok": False, "error": "forbidden"})
            return
        if self.runtime is None or self.semaphore is None:
            self._send_json(503, {"ok": False, "error": "runtime not ready"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self._send_json(400, {"ok": False, "error": "invalid json"})
            return

        text = str(payload.get("text", "")).strip()
        speaker = str(payload.get("speaker", DEFAULT_SPEAKER)).strip() or DEFAULT_SPEAKER
        style = str(payload.get("style", "neutral")).strip() or "neutral"
        language = _detect_language(text, payload.get("language"))
        if not text:
            self._send_json(400, {"ok": False, "error": "empty text"})
            return
        if len(text) > MAX_TEXT_CHARS:
            self._send_json(400, {"ok": False, "error": "text too long"})
            return
        if not self.semaphore.acquire(blocking=False):
            self._send_json(429, {"ok": False, "error": "tts queue full"})
            return
        try:
            samples, sample_rate, cached = self.runtime.synth(text, speaker, language, style)
            pcm = np.clip(samples, -1.0, 1.0)
            pcm = (pcm * 32767.0).astype("<i2").tobytes()
            self.send_response(200)
            self.send_header("Content-Type", f"audio/L16; rate={sample_rate}; channels=1")
            self.send_header("X-VOID-TTS-Sample-Rate", str(sample_rate))
            self.send_header("X-VOID-TTS-Provider", "qwen3")
            self.send_header("X-VOID-TTS-Speaker", speaker)
            self.send_header("X-VOID-TTS-Cached", "1" if cached else "0")
            self.send_header("Content-Length", str(len(pcm)))
            self.end_headers()
            try:
                self.wfile.write(pcm)
            except (BrokenPipeError, ConnectionAbortedError):
                pass
        except ValueError as error:
            self._send_json(400, {"ok": False, "error": str(error)})
        except Exception as error:  # noqa: BLE001 - return honest engine error
            self._send_json(500, {"ok": False, "error": str(error)})
        finally:
            self.semaphore.release()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--token", default="")
    parser.add_argument("--idle-unload", type=int, default=IDLE_UNLOAD_SECONDS)
    parser.add_argument("--max-pending", type=int, default=4)
    parser.add_argument("--parent-pid", type=int, default=0)
    args = parser.parse_args()

    if args.parent_pid:
        def watch_parent() -> None:
            while True:
                if not psutil.pid_exists(args.parent_pid):
                    print("[qwen3-tts] parent exited, stopping", flush=True)
                    os._exit(0)
                time.sleep(5)

        threading.Thread(target=watch_parent, daemon=True).start()

    QwenTtsHandler.runtime = QwenTtsRuntime(args.model_dir, args.device, args.idle_unload)
    QwenTtsHandler.token = args.token
    QwenTtsHandler.semaphore = threading.BoundedSemaphore(args.max_pending)
    server = ThreadingHTTPServer((args.host, args.port), QwenTtsHandler)
    print(f"[qwen3-tts] listening on http://{args.host}:{args.port} model={args.model_dir}", flush=True)
    # 服务只在选中 Qwen3 时拉起；后台预加载 + 预热，避免第一个 /tts 请求承担全部加载/编译时间。
    threading.Thread(target=QwenTtsHandler.runtime.warmup, daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
