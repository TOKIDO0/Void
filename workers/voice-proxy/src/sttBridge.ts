/**
 * 豆包大模型流式 STT —— Cloudflare Worker 侧翻译桥接。
 *
 * 逐行移植自 server/voiceSttBridge.ts 的 handleBrowserConnection：整段停顿提交（endpointing）、
 * 定稿句下标对齐去重、兜底跳过等算法一字不改。复用 server/doubaoSaucProtocol.ts 的编解码
 * （Buffer + node:zlib，靠 Worker 的 nodejs_compat 支持）。
 *
 * 与 sidecar 版的唯一差异（仅"连接层"）：
 *   - WS 收发从 Node `ws` 适配为 Workers WebSocket API（出站用 fetch + https:// scheme）；
 *   - 豆包鉴权密钥来自 Worker Secret（env），客户端 start 事件不再携带；
 *   - 豆包二进制帧以 Blob 到达，统一转 Uint8Array，并按到达顺序串行处理（保序）。
 */
import {
  decodeServerFrame,
  encodeAudioRequest,
  encodeFullClientRequest
} from "../../../server/doubaoSaucProtocol";
import { toBytes } from "./wsBytes";
import type { Env } from "./index";

// 逻辑上是 wss，Workers fetch 出站 WS 用 https:// scheme。
const DOUBAO_SAUC_ENDPOINT = "https://openspeech.bytedance.com/api/v3/sauc/bigmodel";
// 整段停顿提交阈值（endpointing）。
// 800ms 过短：用户长句换气/思考会被当成说完，AI 抢答并截断历史。
// 1.5s 兼顾自然停顿与响应速度（OpenAI server_vad / 火山 end_window 同量级可调）。
const UTTERANCE_COMMIT_SILENCE_MS = 1500;
// 豆包强制静音判停窗口，与上面应用层阈值对齐，减少过早 definite。
const DOUBAO_END_WINDOW_SIZE_MS = 1500;
// 过短音频不急着判停，避免气口/语气词被切成独立回合。
const DOUBAO_FORCE_TO_SPEECH_TIME_MS = 1200;

type SttClientEvent =
  | { type: "start"; sampleRate: number; format: string }
  | { type: "audio"; audioBase64: string }
  | { type: "stop" };

type StartEvent = Extract<SttClientEvent, { type: "start" }>;

/**
 * 文本归一化，用于「同一句话不同版本」的等价去重比较：剥离所有空白与标点。
 */
function normalizeForDedup(text: string): string {
  return text.replace(/[\s\p{P}]/gu, "");
}

export function handleSttSession(clientSocket: WebSocket, env: Env): void {
  let upstreamSocket: WebSocket | null = null;
  let upstreamOpen = false;
  let clientOpen = true;
  let upstreamReady = false;
  let hasSentFinal = false;
  // 上游就绪前浏览器已推来的音频（PCM 原始字节），先缓存，就绪后按序补发。
  const pendingAudioChunks: Uint8Array[] = [];

  // —— 整段停顿提交（endpointing）状态（下标对齐去重，见原 sidecar 注释）——
  const committedSentences: string[] = [];
  let flushedCount = 0;
  let lastPartial = "";
  let lastLiveText = "";
  let skipOnceDefiniteText = "";
  let commitTimer: ReturnType<typeof setTimeout> | null = null;

  const clearCommitTimer = () => {
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = null;
    }
  };

  const sendToBrowser = (event: Record<string, unknown>) => {
    if (clientOpen) {
      clientSocket.send(JSON.stringify(event));
    }
  };

  const closeAll = () => {
    clearCommitTimer();
    clientOpen = false;
    upstreamOpen = false;
    try {
      upstreamSocket?.close();
    } catch {
      // 忽略关闭异常
    }
    upstreamSocket = null;
    try {
      clientSocket.close();
    } catch {
      // 忽略关闭异常
    }
  };

  const sendUpstreamBinary = (bytes: Uint8Array) => {
    // 复制成独立 Uint8Array，规避 nodejs_compat Buffer 池化带来的隐患。
    if (upstreamSocket && upstreamOpen) {
      upstreamSocket.send(new Uint8Array(bytes));
    }
  };

  const flushPendingAudio = () => {
    while (pendingAudioChunks.length > 0) {
      const chunk = pendingAudioChunks.shift();
      if (chunk && upstreamOpen) {
        sendUpstreamBinary(encodeAudioRequest(Buffer.from(chunk), false));
      }
    }
  };

  // 停顿到阈值：把本段累积但尚未发送的定稿句合并为一条 final 发出。
  const commitUtterance = () => {
    let pending = committedSentences.slice(flushedCount).join("").trim();
    let usedPartialFallback = false;

    if (!pending && lastPartial.trim()) {
      pending = lastPartial.trim();
      usedPartialFallback = true;
    }

    if (!pending) {
      return;
    }

    flushedCount = committedSentences.length;
    if (usedPartialFallback) {
      skipOnceDefiniteText = pending;
      lastPartial = "";
    }
    lastLiveText = "";
    hasSentFinal = true;
    sendToBrowser({ type: "final", text: pending });
  };

  const scheduleCommit = () => {
    clearCommitTimer();
    commitTimer = setTimeout(commitUtterance, UTTERANCE_COMMIT_SILENCE_MS);
  };

  const handleUpstreamFrame = (bytes: Uint8Array) => {
    const decoded = decodeServerFrame(Buffer.from(bytes));
    if (!decoded) {
      return;
    }

    if (decoded.kind === "error") {
      sendToBrowser({ type: "error", message: `豆包语音识别错误（${decoded.code}）：${decoded.message}` });
      closeAll();
      return;
    }

    // 收到首个成功响应即视为会话就绪，通知浏览器并补发缓存音频。
    if (!upstreamReady) {
      upstreamReady = true;
      sendToBrowser({ type: "ready" });
      flushPendingAudio();
    }

    const { definites, partial } = extractUtteranceResults(decoded.payload);
    for (let index = 0; index < definites.length; index += 1) {
      const definiteText = definites[index];
      if (index < committedSentences.length) {
        if (index >= flushedCount) {
          committedSentences[index] = definiteText;
        }
        continue;
      }

      committedSentences.push(definiteText);
      if (skipOnceDefiniteText && normalizeForDedup(definiteText) === normalizeForDedup(skipOnceDefiniteText)) {
        skipOnceDefiniteText = "";
        flushedCount = committedSentences.length;
      }
    }
    lastPartial = partial ?? "";

    // 关麦末包：立即把剩余全部（含未定稿尾句）作为 final 收尾，不再等待停顿阈值。
    if (decoded.isLastPacket) {
      clearCommitTimer();
      const finalText = (committedSentences.slice(flushedCount).join("") + lastPartial).trim();
      if (finalText) {
        flushedCount = committedSentences.length;
        hasSentFinal = true;
        sendToBrowser({ type: "final", text: finalText });
      }
      return;
    }

    const liveText = committedSentences.slice(flushedCount).join("") + lastPartial;
    if (liveText !== lastLiveText) {
      lastLiveText = liveText;
      if (liveText.trim()) {
        sendToBrowser({ type: "partial", text: liveText, isInterim: true });
      }
      scheduleCommit();
    }
  };

  const startUpstream = async (startEvent: StartEvent) => {
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(DOUBAO_SAUC_ENDPOINT, {
        headers: {
          Upgrade: "websocket",
          // 与 sidecar 完全一致的鉴权头，值来自 Worker Secret。
          "X-Api-App-Key": env.DOUBAO_APP_ID,
          "X-Api-Access-Key": env.DOUBAO_ACCESS_KEY,
          "X-Api-Resource-Id": env.DOUBAO_ASR_RESOURCE_ID,
          "X-Api-Connect-Id": crypto.randomUUID(),
          "X-Api-Request-Id": crypto.randomUUID()
        }
      });
    } catch (error) {
      sendToBrowser({ type: "error", message: `豆包语音识别连接失败：${error instanceof Error ? error.message : String(error)}` });
      closeAll();
      return;
    }

    const upstream = upstreamResponse.webSocket;
    if (!upstream) {
      const body = await upstreamResponse.text().catch(() => "");
      const logId = upstreamResponse.headers.get("x-tt-logid") ?? "";
      sendToBrowser({
        type: "error",
        message: `豆包语音识别握手被拒（${upstreamResponse.status}）：${body.trim() || `HTTP ${upstreamResponse.status}`}${logId ? `（logid=${logId}）` : ""}`
      });
      closeAll();
      return;
    }

    if (!clientOpen) {
      try {
        upstream.close();
      } catch {
        // 忽略
      }
      return;
    }

    upstream.accept();
    upstreamSocket = upstream;
    upstreamOpen = true;

    // 下行帧按到达顺序串行处理（保序，定稿句下标对齐依赖顺序）。
    let frameTail: Promise<void> = Promise.resolve();
    upstream.addEventListener("message", (event: MessageEvent) => {
      const data = event.data;
      frameTail = frameTail.then(async () => {
        handleUpstreamFrame(await toBytes(data));
      });
    });
    upstream.addEventListener("close", () => {
      upstreamOpen = false;
      if (!hasSentFinal) {
        sendToBrowser({ type: "error", message: "豆包语音识别连接已关闭。" });
      }
      closeAll();
    });
    upstream.addEventListener("error", () => {
      upstreamOpen = false;
      sendToBrowser({ type: "error", message: "豆包语音识别连接异常。" });
      closeAll();
    });

    // accept 后即 open：先发 full client request（识别参数）。
    sendUpstreamBinary(encodeFullClientRequest(buildRecognitionConfig(startEvent)));
  };

  clientSocket.addEventListener("message", (event: MessageEvent) => {
    let parsed: SttClientEvent;
    try {
      parsed = JSON.parse(typeof event.data === "string" ? event.data : "") as SttClientEvent;
    } catch {
      return;
    }

    if (parsed.type === "start") {
      void startUpstream(parsed);
      return;
    }

    if (parsed.type === "audio") {
      const pcmChunk = new Uint8Array(Buffer.from(parsed.audioBase64, "base64"));
      if (!upstreamReady) {
        pendingAudioChunks.push(pcmChunk);
        return;
      }
      sendUpstreamBinary(encodeAudioRequest(Buffer.from(pcmChunk), false));
      return;
    }

    if (parsed.type === "stop") {
      // 发送空的最后一包（负包）触发豆包输出最终结果。
      if (upstreamReady && upstreamOpen) {
        sendUpstreamBinary(encodeAudioRequest(Buffer.alloc(0), true));
      } else {
        closeAll();
      }
    }
  });

  clientSocket.addEventListener("close", () => {
    clientOpen = false;
    closeAll();
  });
  clientSocket.addEventListener("error", () => {
    clientOpen = false;
    closeAll();
  });
}

/** 构造识别参数：音频为 16k/16bit/单声道 raw PCM，开启标点与分句信息。 */
function buildRecognitionConfig(startEvent: StartEvent) {
  return {
    user: {
      uid: "void-web-mvp"
    },
    audio: {
      format: "pcm",
      codec: "raw",
      rate: startEvent.sampleRate,
      bits: 16,
      channel: 1
    },
    request: {
      model_name: "bigmodel",
      enable_punc: true,
      enable_itn: true,
      show_utterances: true,
      result_type: "full",
      // 静音强制判停：与 UTTERANCE_COMMIT_SILENCE_MS 对齐，避免上游过早 definite。
      end_window_size: DOUBAO_END_WINDOW_SIZE_MS,
      // 配合 end_window_size：前若干毫秒内不急着输出 definite。
      force_to_speech_time: DOUBAO_FORCE_TO_SPEECH_TIME_MS
    }
  };
}

/** 单帧解析结果：本帧全部定稿句（按序）+ 当前未定稿的尾句。 */
type UtteranceExtraction = {
  definites: string[];
  partial: string | null;
};

/**
 * 从 full server response 的 payload 中解析定稿句序列与未定稿尾句。
 * 去重不在此处做：只忠实返回「当前定稿句序列」，由调用方按下标对齐 committedSentences。
 */
function extractUtteranceResults(payload: Record<string, unknown>): UtteranceExtraction {
  const result = payload.result;
  const resultRecord = Array.isArray(result)
    ? (result[0] as Record<string, unknown> | undefined)
    : (result as Record<string, unknown> | undefined);

  if (!resultRecord) {
    return { definites: [], partial: null };
  }

  const utterances = resultRecord.utterances;
  if (!Array.isArray(utterances)) {
    const text = resultRecord.text;
    return { definites: [], partial: typeof text === "string" && text.trim() ? text : null };
  }

  const definites: string[] = [];
  let partial: string | null = null;

  for (const item of utterances) {
    const utterance = item as Record<string, unknown>;
    const text = typeof utterance.text === "string" ? utterance.text.trim() : "";
    if (!text) {
      continue;
    }

    if (utterance.definite === true) {
      definites.push(text);
    } else {
      partial = text;
    }
  }

  return { definites, partial };
}
