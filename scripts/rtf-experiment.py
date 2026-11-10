#!/usr/bin/env python3
"""Qwen3-TTS RTF 可行性实验（只读，不改生产代码）。

问题：当前单句串行生成的 RTF ≈ 1.83，生成速度追不上播放，口播必然累积空洞。
本实验只验证一个事实：同一进程内，批量生成 / 并发生成能否把有效吞吐拉过实时。

测量三组：
  1. sequential：逐句串行（现状），两段；
  2. batched：把两段放进同一个 generate 调用（利用 GPU 批处理）；
  3. concurrent：两个线程同时调用 generate（模拟去掉 _generate_lock 后）。

输出每组的生成耗时、音频时长、RTF，以及相对串行的加速比。
不写入模型缓存，不修改服务端脚本。

用法（必须用引擎自带 venv 的 Python）：
  D:\\AI\\void-runtime\\voice-engines\\qwen3-tts\\venv\\Scripts\\python.exe scripts\\rtf-experiment.py
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from pathlib import Path

import numpy as np
import torch

RUNTIME_ROOT = Path(os.environ.get("VOID_RUNTIME_ROOT", r"D:\AI\void-runtime"))
ENGINE_ROOT = Path(os.environ.get("VOID_QWEN_TTS_ENGINE_ROOT", RUNTIME_ROOT / "voice-engines" / "qwen3-tts"))
MANIFEST_PATH = ENGINE_ROOT / "engine.json"
DEVICE = os.environ.get("VOID_QWEN_TTS_DEVICE", "cuda:0")
SPEAKER = "ono_anna"

# 与 qwen3_tts_server.py 的 neutral instruct 保持一致。
NEUTRAL_INSTRUCT = (
    "Speak in a natural conversational tone at a steady pace. "
    "Keep pauses between sentences short."
)

TEXTS = [
    "今天天气不错，出去走走吧。",
    "我刚看完你发来的那封邮件，里面提到的两个问题都可以处理。",
    "这个问题需要分两步解决，先把数据补齐，再看具体是哪一环出了问题。",
    "我今天下午去了趟医院，医生说没什么大问题，就是最近休息不够。",
]


def load_model_dir() -> Path:
    # 允许指向另一个模型目录（例如 0.6B 对比测试），默认用已安装的 1.7B。
    override = os.environ.get("VOID_RTF_MODEL_DIR", "").strip()
    if override:
        return Path(override)
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    return Path(manifest["modelDir"])


def max_tokens_for(text: str) -> int:
    # 与生产服务端相同的硬上限公式。
    return min(380, max(150, round(len(text) * 6 + 50)))


def synth(model, texts: list[str]) -> tuple[float, float]:
    """返回 (生成耗时秒, 音频总时长秒)。"""
    # 复现服务端 qwen3_tts_server.py 的固定种子，避免采样跑飞污染对比。
    torch.manual_seed(42)
    started = time.perf_counter()
    wavs, sample_rate = model.generate_custom_voice(
        text=texts,
        speaker=[SPEAKER] * len(texts),
        language=["Chinese"] * len(texts),
        instruct=[NEUTRAL_INSTRUCT] * len(texts),
        temperature=0.7,
        top_p=0.9,
        max_new_tokens=max_tokens_for("".join(texts)),
    )
    elapsed = time.perf_counter() - started
    audio_seconds = sum(len(np.asarray(wav).reshape(-1)) / float(sample_rate) for wav in wavs)
    return elapsed, audio_seconds


def breakdown(model, text: str) -> tuple[float, float, int]:
    """拆开一次合成：语义 token 生成 vs 波形解码。返回 (生成秒, 解码秒, token 数)。"""
    input_ids = model._tokenize_texts([model._build_assistant_text(text)])
    instruct_ids = [model._tokenize_texts([model._build_instruct_text(NEUTRAL_INSTRUCT)])[0]]
    gen_kwargs = model._merge_generate_kwargs(
        temperature=0.7,
        top_p=0.9,
        max_new_tokens=max_tokens_for(text),
    )

    torch.manual_seed(42)
    started = time.perf_counter()
    codes, _ = model.model.generate(
        input_ids=input_ids,
        instruct_ids=instruct_ids,
        languages=["Chinese"],
        speakers=[SPEAKER],
        non_streaming_mode=True,
        **gen_kwargs,
    )
    generate_seconds = time.perf_counter() - started

    decode_started = time.perf_counter()
    model.model.speech_tokenizer.decode([{"audio_codes": code} for code in codes])
    decode_seconds = time.perf_counter() - decode_started
    # codes[0] 的真实形状由模型决定，先打印出来，避免再按错误维度统计。
    shape = getattr(codes[0], "shape", None)
    token_count = int(shape[-1]) if shape is not None and len(shape) > 0 else -1
    print(f"    [debug] codes[0].shape={tuple(shape) if shape is not None else type(codes[0])}")
    return generate_seconds, decode_seconds, token_count


def main() -> None:
    model_dir = load_model_dir()
    print(f"[rtf] model = {model_dir}")
    print(f"[rtf] device = {DEVICE}")

    from qwen_tts import Qwen3TTSModel

    load_started = time.perf_counter()
    model = Qwen3TTSModel.from_pretrained(
        str(model_dir),
        device_map=DEVICE,
        dtype=torch.bfloat16 if DEVICE.startswith("cuda") else torch.float32,
    )
    print(f"[rtf] model loaded in {time.perf_counter() - load_started:.2f}s")

    # 预热：吃掉首句编译/显存分配成本。
    synth(model, ["你好。"])
    print("[rtf] warmup done\n")

    pair = TEXTS[:2]
    print(f"[rtf] 测试句 A({len(pair[0])}字): {pair[0]}")
    print(f"[rtf] 测试句 B({len(pair[1])}字): {pair[1]}\n")

    # 1) 串行：先单独跑一遍，再跑第二遍取稳定值。
    synth(model, [pair[0]])
    synth(model, [pair[1]])
    started = time.perf_counter()
    seq_a = synth(model, [pair[0]])
    seq_b = synth(model, [pair[1]])
    sequential_wall = time.perf_counter() - started
    sequential_audio = seq_a[1] + seq_b[1]
    print(
        f"[1] sequential  A {seq_a[0]:.2f}s (RTF {seq_a[0] / seq_a[1]:.2f})  "
        f"B {seq_b[0]:.2f}s (RTF {seq_b[0] / seq_b[1]:.2f})  "
        f"wall {sequential_wall:.2f}s / audio {sequential_audio:.2f}s "
        f"→ 有效 RTF {sequential_wall / sequential_audio:.2f}"
    )

    # 2) 批量：两段放进同一次调用。
    synth(model, pair)  # 预热 batch 形状
    batch_elapsed, batch_audio = synth(model, pair)
    print(
        f"[2] batched     wall {batch_elapsed:.2f}s / audio {batch_audio:.2f}s "
        f"→ 有效 RTF {batch_elapsed / batch_audio:.2f}  "
        f"加速比 {sequential_wall / batch_elapsed:.2f}x"
    )

    # 3) 并发：两个线程同时调用（模拟去掉 _generate_lock）。
    synth(model, [pair[0]])
    synth(model, [pair[1]])
    results: list[tuple[float, float]] = []
    errors: list[str] = []
    lock = threading.Lock()

    def worker(text: str) -> None:
        try:
            result = synth(model, [text])
            with lock:
                results.append(result)
        except Exception as error:  # noqa: BLE001 - 实验脚本需要看到真实失败
            with lock:
                errors.append(repr(error))

    started = time.perf_counter()
    threads = [threading.Thread(target=worker, args=(text,)) for text in pair]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    concurrent_wall = time.perf_counter() - started
    concurrent_audio = sum(item[1] for item in results)
    if errors:
        print(f"[3] concurrent  失败：{errors[0]}")
    else:
        print(
            f"[3] concurrent  wall {concurrent_wall:.2f}s / audio {concurrent_audio:.2f}s "
            f"→ 有效 RTF {concurrent_wall / concurrent_audio:.2f}  "
            f"加速比 {sequential_wall / concurrent_wall:.2f}x"
        )

    # 4) 批量 4 段的极端情况：看 GPU 批处理上限。
    four = TEXTS[:4]
    synth(model, four)
    four_elapsed, four_audio = synth(model, four)
    print(
        f"[4] batched x4  wall {four_elapsed:.2f}s / audio {four_audio:.2f}s "
        f"→ 有效 RTF {four_elapsed / four_audio:.2f}"
    )

    # 5) 拆解：首块 3.3s 里，多少是自回归生成，多少是波形解码。
    print("\n[5] 耗时拆解（生成 vs 解码）")
    for label, text in (("13字", TEXTS[0]), ("48字", TEXTS[1] + TEXTS[3])):
        breakdown(model, text)  # 预热
        generate_seconds, decode_seconds, token_count = breakdown(model, text)
        total = generate_seconds + decode_seconds
        print(
            f"    {label}: token {token_count:3d}  "
            f"生成 {generate_seconds:5.2f}s / 解码 {decode_seconds:5.2f}s  "
            f"→ 解码占 {decode_seconds / total * 100:4.1f}%"
        )

    if DEVICE.startswith("cuda"):
        print(f"\n[rtf] peak VRAM = {torch.cuda.max_memory_allocated() / 1024**3:.2f} GB")

    print("\n判据：有效 RTF < 1 才算真正解决连续播放；>= 1 意味着播放会持续饥饿。")


if __name__ == "__main__":
    sys.exit(main())
