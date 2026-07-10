/**
 * 豆包（火山引擎）双向流式 TTS 开发环境 WebSocket 桥接。
 *
 * 与 STT 桥接（voiceSttBridge.ts）同构：浏览器无法给原生 WebSocket 设自定义鉴权头，
 * 且不便手写二进制帧，故由本桥接在 Node 侧完成：浏览器 JSON 信封 ↔ 豆包双向流式二进制帧。
 *
 * 数据流：
 *   浏览器 --(start/text/finish JSON)--> 桥接 --(帧+鉴权头)--> 豆包
 *   豆包 --(AudioOnlyServer 音频帧 / 会话事件)--> 桥接 --(ready/audio/done/error JSON)--> 浏览器
 *
 * 握手序列（对照官方 protocols_.py 与「WebSocket 双向流式-V3」文档）：
 *   StartConnection(1) → 等 ConnectionStarted(50)
 *   → StartSession(100, req_params) → 等 SessionStarted(150)
 *   → TaskRequest(200, {text}) × N   （同一 session 内连续喂多句，豆包维持整段韵律）
 *   ← TTSResponse(352, 音频字节) 连续回吐
 *   → FinishSession(102) → 等 SessionFinished(152)
 *   → FinishConnection(2) → 等 ConnectionFinished(52)
 *
 * 只处理开发环境（vite dev）。生产环境需另在正式服务端实现同等桥接。
 */
import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  MsgType,
  MsgTypeFlag,
  EventType,
  encodeFrame,
  decodeFrame,
  encodeJsonPayload
} from "../src/features/voice/tts/doubaoBidirectional/frameCodec";

// 豆包双向流式 TTS 端点（官方「WebSocket 双向流式-V3」文档确认；与 STT sauc 同域）
const DOUBAO_TTS_BIDIRECTIONAL_ENDPOINT = "wss://openspeech.bytedance.com/api/v3/tts/bidirection";
// 浏览器侧连接的桥接路径（挂在 vite dev 同源上）
const TTS_BRIDGE_PATH = "/void-voice-proxy/tts";
// 请求方法命名空间（官方 StartSession payload 固定值）
const DOUBAO_TTS_NAMESPACE = "BidirectionalTTS";

/** 送入 StartSession 的音频参数（豆包 audio_params 子集） */
type BridgeAudioParams = {
  format: string;
  sampleRate: number;
  speechRate?: number;
  loudnessRate?: number;
};

/** 浏览器 → 桥接 的客户端事件（与 doubaoBidirectionalProtocol.ts 对应） */
type TtsBridgeClientEvent =
  | {
      type: "start";
      appId: string;
      accessKey: string;
      resourceId: string;
      speaker: string;
      audioParams: BridgeAudioParams;
    }
  | { type: "text"; text: string }
  | { type: "finish" };

type StartEvent = Extract<TtsBridgeClientEvent, { type: "start" }>;

/**
 * 把 TTS 桥接挂载到 vite dev 的 HTTP server 上。
 * 仅拦截 TTS_BRIDGE_PATH 的 upgrade，其余（vite HMR、STT 桥接）交回原有监听器。
 */
export function attachVoiceTtsBridge(httpServer: HttpServer) {
  const bridgeWss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    const pathname = (request.url ?? "").split("?")[0];
    if (pathname !== TTS_BRIDGE_PATH) {
      // 非本桥接路径：不处理，交给其它 upgrade 监听器（STT 桥接 / vite HMR）
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
  // 本会话的 session_id：StartSession 起在所有会话级帧上携带（连接级帧不带，由 frameCodec 内建跳过）。
  const sessionId = randomUUID();
  // 握手阶段推进：connecting → session-starting → ready。ready 前浏览器发来的文本先缓存。
  let handshakeState: "idle" | "connecting" | "session-starting" | "ready" | "closed" = "idle";
  // ready 前浏览器已推来的待合成文本，就绪后按序补发
  const pendingTexts: string[] = [];
  // 浏览器已发过 finish 但握手/合成尚未走到可收尾的时点，置位后在合适阶段补发 FinishSession
  let finishRequested = false;
  let startEvent: StartEvent | null = null;

  const sendToBrowser = (event: Record<string, unknown>) => {
    if (browserSocket.readyState === WebSocket.OPEN) {
      browserSocket.send(JSON.stringify(event));
    }
  };

  const closeAll = () => {
    handshakeState = "closed";
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

  const failAndClose = (message: string) => {
    sendToBrowser({ type: "error", message });
    closeAll();
  };

  // —— 上行帧发送封装 ——
  const sendUpstream = (frame: Uint8Array) => {
    if (upstreamSocket?.readyState === WebSocket.OPEN) {
      upstreamSocket.send(frame);
    }
  };

  const sendStartConnection = () => {
    sendUpstream(
      encodeFrame({
        type: MsgType.FullClientRequest,
        flag: MsgTypeFlag.WithEvent,
        event: EventType.StartConnection,
        payload: encodeJsonPayload({})
      })
    );
  };

  const sendStartSession = (start: StartEvent) => {
    // 官方 StartSession payload：{user, event, namespace, req_params:{text, speaker, audio_params}}。
    // text 在 StartSession 可为空串（参数在此定，文本随后逐句由 TaskRequest 发）。
    const audioParams: Record<string, unknown> = {
      format: start.audioParams.format,
      sample_rate: start.audioParams.sampleRate
    };
    if (typeof start.audioParams.speechRate === "number") {
      audioParams.speech_rate = start.audioParams.speechRate;
    }
    if (typeof start.audioParams.loudnessRate === "number") {
      audioParams.loudness_rate = start.audioParams.loudnessRate;
    }

    sendUpstream(
      encodeFrame({
        type: MsgType.FullClientRequest,
        flag: MsgTypeFlag.WithEvent,
        event: EventType.StartSession,
        sessionId,
        payload: encodeJsonPayload({
          user: { uid: "void-web-mvp" },
          event: EventType.StartSession,
          namespace: DOUBAO_TTS_NAMESPACE,
          req_params: {
            text: "",
            speaker: start.speaker,
            audio_params: audioParams
          }
        })
      })
    );
  };

  const sendTaskRequest = (text: string) => {
    // TaskRequest：官方明示「参数设 StartSession 生效，文本在 TaskRequest 生效」→ 载荷带待合成文本。
    // ⚠️ 阶段 2 联调需 DevTools 坐实此 payload 结构（官方仅逐字给了 StartSession）；
    //    此处按 req_params.text 组装，与 StartSession 同构，便于联调时一行调整。
    sendUpstream(
      encodeFrame({
        type: MsgType.FullClientRequest,
        flag: MsgTypeFlag.WithEvent,
        event: EventType.TaskRequest,
        sessionId,
        payload: encodeJsonPayload({
          user: { uid: "void-web-mvp" },
          event: EventType.TaskRequest,
          namespace: DOUBAO_TTS_NAMESPACE,
          req_params: {
            text,
            speaker: startEvent?.speaker ?? ""
          }
        })
      })
    );
  };

  const sendFinishSession = () => {
    sendUpstream(
      encodeFrame({
        type: MsgType.FullClientRequest,
        flag: MsgTypeFlag.WithEvent,
        event: EventType.FinishSession,
        sessionId,
        payload: encodeJsonPayload({})
      })
    );
  };

  const sendFinishConnection = () => {
    sendUpstream(
      encodeFrame({
        type: MsgType.FullClientRequest,
        flag: MsgTypeFlag.WithEvent,
        event: EventType.FinishConnection,
        payload: encodeJsonPayload({})
      })
    );
  };

  // ready 后把缓存文本按序补发，并在需要时补发 finish
  const flushPendingTexts = () => {
    while (pendingTexts.length > 0) {
      const text = pendingTexts.shift();
      if (typeof text === "string" && text) {
        sendTaskRequest(text);
      }
    }
    if (finishRequested) {
      sendFinishSession();
    }
  };

  // —— 下行帧处理 ——
  const handleUpstreamFrame = (frame: Buffer) => {
    let decoded;
    try {
      decoded = decodeFrame(new Uint8Array(frame));
    } catch (error) {
      failAndClose(`豆包 TTS 帧解析失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    // 错误帧：读 errorCode 并透出
    if (decoded.type === MsgType.Error) {
      failAndClose(`豆包 TTS 服务错误（code=${decoded.errorCode}）。`);
      return;
    }

    // 音频数据帧：payload 即音频字节，base64 回吐浏览器
    if (decoded.type === MsgType.AudioOnlyServer) {
      if (decoded.payload.length > 0) {
        sendToBrowser({
          type: "audio",
          audioBase64: Buffer.from(decoded.payload).toString("base64")
        });
      }
      return;
    }

    // 会话/连接事件帧（FullServerResponse）：按 event 推进握手
    if (decoded.type === MsgType.FullServerResponse) {
      switch (decoded.event) {
        case EventType.ConnectionStarted: {
          // 连接就绪 → 发 StartSession
          if (handshakeState === "connecting" && startEvent) {
            handshakeState = "session-starting";
            sendStartSession(startEvent);
          }
          return;
        }
        case EventType.ConnectionFailed: {
          failAndClose("豆包 TTS 连接失败（鉴权或资源不可用）。");
          return;
        }
        case EventType.SessionStarted: {
          // 会话就绪 → 通知浏览器可发文本，补发缓存
          handshakeState = "ready";
          sendToBrowser({ type: "ready" });
          flushPendingTexts();
          return;
        }
        case EventType.SessionFailed: {
          failAndClose("豆包 TTS 会话启动失败。");
          return;
        }
        case EventType.TTSSentenceStart:
        case EventType.TTSSentenceEnd:
        case EventType.TTSResponse: {
          // 句级事件：音频走 AudioOnlyServer 帧，这里无需额外处理
          return;
        }
        case EventType.TTSEnded: {
          // 整段音频合成结束
          sendToBrowser({ type: "done" });
          return;
        }
        case EventType.SessionFinished: {
          // 会话收尾 → 关闭连接
          sendFinishConnection();
          return;
        }
        case EventType.ConnectionFinished: {
          closeAll();
          return;
        }
        default:
          return;
      }
    }
  };

  // —— 建立上游连接 ——
  const startUpstream = (start: StartEvent) => {
    startEvent = start;
    handshakeState = "connecting";

    const upstream = new WebSocket(DOUBAO_TTS_BIDIRECTIONAL_ENDPOINT, {
      headers: {
        // 豆包 openspeech v3 鉴权：与 STT/HTTP 同一套三件套。App-Key 是项目已验证可用的头名
        // （见 18 号：STT/TTS 必须同一套鉴权），App-Id 是官方双向流式文档头名——二者为同一 appId
        // 的别名，同发两者以防头名分叉导致 401（与 vite.config buildForwardedHeaders 放行策略一致）。
        "X-Api-App-Key": start.appId,
        "X-Api-App-Id": start.appId,
        "X-Api-Access-Key": start.accessKey,
        "X-Api-Resource-Id": start.resourceId,
        "X-Api-Connect-Id": randomUUID()
      }
    });
    upstreamSocket = upstream;
    upstream.binaryType = "nodebuffer";

    upstream.on("open", () => {
      // 建连后先发 StartConnection，等 ConnectionStarted 再发 StartSession
      sendStartConnection();
    });

    // 握手被拒（HTTP 4xx）时豆包在响应体与 X-Tt-Logid 给出真实原因，透出便于定位
    upstream.on("unexpected-response", (_request, incoming) => {
      const logId = incoming.headers["x-tt-logid"] ?? "";
      const bodyChunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => bodyChunks.push(chunk));
      incoming.on("end", () => {
        const body = Buffer.concat(bodyChunks).toString("utf-8");
        const detail = body.trim() || `HTTP ${incoming.statusCode}`;
        console.error("[void-tts-bridge] 豆包握手被拒", { status: incoming.statusCode, logId, body });
        failAndClose(
          `豆包 TTS 握手被拒（${incoming.statusCode}）：${detail}${logId ? `（logid=${logId}）` : ""}`
        );
      });
    });

    upstream.on("message", (data) => {
      handleUpstreamFrame(toBuffer(data));
    });

    upstream.on("error", (error) => {
      failAndClose(`豆包 TTS 连接失败：${error.message}`);
    });

    upstream.on("close", () => {
      if (handshakeState !== "closed") {
        closeAll();
      }
    });
  };

  // —— 浏览器侧事件 ——
  browserSocket.on("message", (data) => {
    let event: TtsBridgeClientEvent;
    try {
      event = JSON.parse(toBuffer(data).toString("utf-8")) as TtsBridgeClientEvent;
    } catch {
      return;
    }

    if (event.type === "start") {
      if (handshakeState === "idle") {
        startUpstream(event);
      }
      return;
    }

    if (event.type === "text") {
      const text = event.text.trim();
      if (!text) {
        return;
      }
      if (handshakeState === "ready") {
        sendTaskRequest(text);
      } else {
        pendingTexts.push(text);
      }
      return;
    }

    if (event.type === "finish") {
      // ready 后所有文本都已同步直发（pendingTexts 恒空），可立即收尾；
      // 未 ready 时置位，待 flushPendingTexts 补发完缓存文本后收尾。
      if (handshakeState === "ready") {
        sendFinishSession();
      } else {
        finishRequested = true;
      }
    }
  });

  browserSocket.on("close", closeAll);
  browserSocket.on("error", closeAll);
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
