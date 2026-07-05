/**
 * 豆包流式语音识别（STT）开发环境 WebSocket 桥接。
 *
 * 浏览器无法自定义 WebSocket 握手请求头，也不便直接组装二进制协议，
 * 因此由本桥接在服务端完成：浏览器 JSON 信封协议 ↔ 豆包 SAUC 二进制协议。
 *
 * 数据流：
 *   浏览器 --(start/audio/stop JSON)--> 桥接 --(二进制帧+鉴权头)--> 豆包
 *   豆包 --(full server response 二进制)--> 桥接 --(partial/final/error JSON)--> 浏览器
 *
 * 只处理开发环境（vite dev）。生产环境需另在正式服务端实现同等桥接。
 */
import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  decodeServerFrame,
  encodeAudioRequest,
  encodeFullClientRequest
} from "./doubaoSaucProtocol";

// 豆包大模型流式语音识别（双向流式，每包即返，最快）
const DOUBAO_SAUC_ENDPOINT = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel";
// 浏览器侧连接的桥接路径
const STT_BRIDGE_PATH = "/void-voice-proxy/stt";

/** 浏览器 → 桥接 的客户端事件 */
type BridgeClientEvent =
  | { type: "start"; appKey: string; accessKey: string; resourceId: string; sampleRate: number; format: string }
  | { type: "audio"; audioBase64: string }
  | { type: "stop" };

type StartEvent = Extract<BridgeClientEvent, { type: "start" }>;

/**
 * 把 STT 桥接挂载到 vite dev 的 HTTP server 上。
 * 仅拦截 STT_BRIDGE_PATH 的 upgrade，其余（如 vite HMR）交回原有监听器。
 */
export function attachVoiceSttBridge(httpServer: HttpServer) {
  const bridgeWss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    const pathname = (request.url ?? "").split("?")[0];
    if (pathname !== STT_BRIDGE_PATH) {
      // 非本桥接路径：不处理，交给 vite HMR 等其它 upgrade 监听器
      return;
    }

    bridgeWss.handleUpgrade(request, socket, head, (browserSocket) => {
      handleBrowserConnection(browserSocket);
    });
  });
}

/** 处理单个浏览器连接：为其建立并代理一条豆包上游连接 */
function handleBrowserConnection(browserSocket: WebSocket) {
  let upstreamSocket: WebSocket | null = null;
  let upstreamReady = false;
  let hasSentFinal = false;
  // 上游就绪前浏览器已推来的音频，先缓存，就绪后按序补发
  const pendingAudioChunks: Buffer[] = [];
  // 已定稿（definite）句子的去重键集合。豆包每帧会回传历史全部定稿句，
  // 不去重会把同一句反复当 final 发出，导致 AI 重复收到并重复回复。
  const seenDefiniteKeys = new Set<string>();

  const sendToBrowser = (event: Record<string, unknown>) => {
    if (browserSocket.readyState === WebSocket.OPEN) {
      browserSocket.send(JSON.stringify(event));
    }
  };

  const closeAll = () => {
    try {
      upstreamSocket?.close();
    } catch {
      // 忽略关闭异常
    }
    upstreamSocket = null;
    try {
      browserSocket.close();
    } catch {
      // 忽略关闭异常
    }
  };

  const flushPendingAudio = () => {
    while (pendingAudioChunks.length > 0) {
      const chunk = pendingAudioChunks.shift();
      if (chunk && upstreamSocket?.readyState === WebSocket.OPEN) {
        upstreamSocket.send(encodeAudioRequest(chunk, false));
      }
    }
  };

  const handleUpstreamFrame = (frame: Buffer) => {
    const decoded = decodeServerFrame(frame);
    if (!decoded) {
      return;
    }

    if (decoded.kind === "error") {
      sendToBrowser({ type: "error", message: `豆包语音识别错误（${decoded.code}）：${decoded.message}` });
      closeAll();
      return;
    }

    // 收到首个成功响应即视为会话就绪，通知浏览器并补发缓存音频
    if (!upstreamReady) {
      upstreamReady = true;
      sendToBrowser({ type: "ready" });
      flushPendingAudio();
    }

    const { finals, partial } = extractUtteranceResults(decoded.payload, seenDefiniteKeys);

    // 服务端 VAD 判定某句说完（definite:true）即逐句发 final，驱动前端自动发送给 AI；
    // 连接保持不关，继续听下一句，实现单连接连续多轮。
    for (const finalText of finals) {
      hasSentFinal = true;
      sendToBrowser({ type: "final", text: finalText });
    }

    // 关麦末包：把仍未定稿的尾句补发为 final，避免最后一句因未触发 VAD 而丢失。
    if (decoded.isLastPacket) {
      if (partial) {
        hasSentFinal = true;
        sendToBrowser({ type: "final", text: partial });
      }
      return;
    }

    if (partial) {
      sendToBrowser({ type: "partial", text: partial, isInterim: true });
    }
  };

  const startUpstream = (startEvent: StartEvent) => {
    const upstream = new WebSocket(DOUBAO_SAUC_ENDPOINT, {
      headers: {
        "X-Api-App-Key": startEvent.appKey,
        "X-Api-Access-Key": startEvent.accessKey,
        "X-Api-Resource-Id": startEvent.resourceId,
        "X-Api-Connect-Id": randomUUID(),
        "X-Api-Request-Id": randomUUID()
      }
    });
    upstreamSocket = upstream;

    upstream.on("open", () => {
      // 建连后先发 full client request（识别参数）
      upstream.send(encodeFullClientRequest(buildRecognitionConfig(startEvent)));
    });

    // 握手被拒（HTTP 4xx）时，豆包会在响应体和 X-Tt-Logid 里给出真实原因，
    // 默认只会抛 "Unexpected server response: 400"，这里把真实原因透出来便于定位。
    upstream.on("unexpected-response", (_request, incoming) => {
      const logId = incoming.headers["x-tt-logid"] ?? "";
      const bodyChunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => bodyChunks.push(chunk));
      incoming.on("end", () => {
        const body = Buffer.concat(bodyChunks).toString("utf-8");
        const detail = body.trim() || `HTTP ${incoming.statusCode}`;
        console.error("[void-stt-bridge] 豆包握手被拒", {
          status: incoming.statusCode,
          logId,
          body
        });
        sendToBrowser({
          type: "error",
          message: `豆包语音识别握手被拒（${incoming.statusCode}）：${detail}${logId ? `（logid=${logId}）` : ""}`
        });
        closeAll();
      });
    });

    upstream.on("message", (data) => {
      handleUpstreamFrame(toBuffer(data));
    });

    upstream.on("error", (error) => {
      sendToBrowser({ type: "error", message: `豆包语音识别连接失败：${error.message}` });
      closeAll();
    });

    upstream.on("close", () => {
      if (!hasSentFinal) {
        sendToBrowser({ type: "error", message: "豆包语音识别连接已关闭。" });
      }
      closeAll();
    });
  };

  browserSocket.on("message", (data) => {
    let event: BridgeClientEvent;
    try {
      event = JSON.parse(toBuffer(data).toString("utf-8")) as BridgeClientEvent;
    } catch {
      return;
    }

    if (event.type === "start") {
      startUpstream(event);
      return;
    }

    if (event.type === "audio") {
      const pcmChunk = Buffer.from(event.audioBase64, "base64");
      if (!upstreamReady) {
        pendingAudioChunks.push(pcmChunk);
        return;
      }
      if (upstreamSocket?.readyState === WebSocket.OPEN) {
        upstreamSocket.send(encodeAudioRequest(pcmChunk, false));
      }
      return;
    }

    if (event.type === "stop") {
      // 发送空的最后一包（负包）触发豆包输出最终结果
      if (upstreamReady && upstreamSocket?.readyState === WebSocket.OPEN) {
        upstreamSocket.send(encodeAudioRequest(Buffer.alloc(0), true));
      } else {
        closeAll();
      }
    }
  });

  browserSocket.on("close", closeAll);
  browserSocket.on("error", closeAll);
}

/** 构造识别参数：音频为 16k/16bit/单声道 raw PCM，开启标点与分句信息 */
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
      result_type: "full"
    }
  };
}

/** 单帧解析结果：本帧新定稿的完整句 + 当前未定稿的尾句 */
type UtteranceExtraction = {
  /** 本帧新出现（去重后）的 definite 定稿句，逐句作为 final */
  finals: string[];
  /** 当前仍在累积、未定稿的尾句，作为 partial 实时预览；无则为 null */
  partial: string | null;
};

/**
 * 从 full server response 的 payload 中解析定稿句与未定稿尾句。
 *
 * 官方结构：`{ result: { text: "累积文本", utterances: [{ definite, start_time, end_time, text, words }] } }`。
 * `definite:true` 表示服务端 VAD 判定该句已说完（正道分句信号）。
 * result 既可能是对象也可能是数组，两种都兼容；无 utterances 时回退用累积 text 作为 partial。
 *
 * @param seenDefiniteKeys 跨帧去重集合（豆包每帧回传历史全部定稿句，须去重）
 */
function extractUtteranceResults(
  payload: Record<string, unknown>,
  seenDefiniteKeys: Set<string>
): UtteranceExtraction {
  const result = payload.result;
  const resultRecord = Array.isArray(result)
    ? (result[0] as Record<string, unknown> | undefined)
    : (result as Record<string, unknown> | undefined);

  if (!resultRecord) {
    return { finals: [], partial: null };
  }

  const utterances = resultRecord.utterances;
  if (!Array.isArray(utterances)) {
    // 兜底：无分句信息时，用累积 text 作为 partial 预览（不作为 final，避免整段误发）
    const text = resultRecord.text;
    return { finals: [], partial: typeof text === "string" && text.trim() ? text : null };
  }

  const finals: string[] = [];
  let partial: string | null = null;

  for (const item of utterances) {
    const utterance = item as Record<string, unknown>;
    const text = typeof utterance.text === "string" ? utterance.text.trim() : "";
    if (!text) {
      continue;
    }

    if (utterance.definite === true) {
      const deduplicationKey = `${utterance.start_time ?? ""}-${utterance.end_time ?? ""}-${text}`;
      if (!seenDefiniteKeys.has(deduplicationKey)) {
        seenDefiniteKeys.add(deduplicationKey);
        finals.push(text);
      }
    } else {
      // 未定稿尾句：只保留最后一个作为当前预览
      partial = text;
    }
  }

  return { finals, partial };
}

/** 兼容 ws message 可能给出的 Buffer / ArrayBuffer / 分片数组 */
function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((part) => toBuffer(part)));
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  return Buffer.from(String(data), "utf-8");
}
