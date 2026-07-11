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
// 整段停顿提交阈值（endpointing）：识别文本静默超过此时长即判定「用户说完」，把累积内容发出。
// 800ms 过短会导致长句换气/思考时 AI 抢答；与托管 Worker 对齐为 1.5s。
const UTTERANCE_COMMIT_SILENCE_MS = 1500;
// 豆包强制静音判停窗口，与应用层阈值对齐。
const DOUBAO_END_WINDOW_SIZE_MS = 1500;
const DOUBAO_FORCE_TO_SPEECH_TIME_MS = 1200;

/** 浏览器 → 桥接 的客户端事件 */
type BridgeClientEvent =
  | { type: "start"; appKey: string; accessKey: string; resourceId: string; sampleRate: number; format: string }
  | { type: "audio"; audioBase64: string }
  | { type: "stop" };

type StartEvent = Extract<BridgeClientEvent, { type: "start" }>;

/**
 * 文本归一化，用于「同一句话不同版本」的等价去重比较：剥离所有空白与标点。
 * 豆包会对同一句话先给不含标点的稿、再补含标点的定稿（如「你在干嘛呀」→「你在干嘛呀？」），
 * 若用裸字符串相等比较会判为两句、把同一句发两次 final，导致 AI「回复两遍」。
 */
function normalizeForDedup(text: string): string {
  return text.replace(/[\s\p{P}]/gu, "");
}

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
  // —— 整段停顿提交（endpointing）——
  // 豆包的 definite 是「句子级」VAD 分句；而「用户说完了、可以发给 AI」是更高层的
  // 「整段停顿」判定。若把每个 definite 直接当作发送边界，说长句时中间的自然换气就会被
  // 切断误发。因此这里：定稿句只累积与实时预览，直到识别文本静默超过阈值（用户真正停顿）
  // 才把累积内容合并成一条 final 发出。
  //
  // 【定稿去重的权威结构】committedSentences 与豆包累积返回的「定稿句序列」按下标一一对齐：
  // 豆包每帧回传历史全部定稿句且顺序稳定，故第 i 个定稿永远对应第 i 句。由此：
  //   - 同一句的「无标点稿 → 带标点定稿」再次回传时下标不变 → 只更新该下标的文本，绝不新增；
  //   - 用户真正重复同一短语（如两次「好的」）是新的下标 → 正常追加、不误删。
  // 该对齐不依赖 start_time，从结构上杜绝「同一句被 push 两次」的双发根因。
  const committedSentences: string[] = [];
  // committedSentences 中已作为 final 发出的句子数（水位线）
  let flushedCount = 0;
  // 当前未定稿尾句，仅用于实时预览
  let lastPartial = "";
  // 上一次的实时全文，用于变化检测（用户还在说＝文本在变）
  let lastLiveText = "";
  // 极端兜底：停顿时豆包尚未把尾句定稿，用尾句兜底发出后记下该文本，
  // 防止其稍后被豆包补判定稿导致重复发送。
  let skipOnceDefiniteText = "";
  let commitTimer: ReturnType<typeof setTimeout> | null = null;

  const clearCommitTimer = () => {
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = null;
    }
  };

  const sendToBrowser = (event: Record<string, unknown>) => {
    if (browserSocket.readyState === WebSocket.OPEN) {
      browserSocket.send(JSON.stringify(event));
    }
  };

  const closeAll = () => {
    clearCommitTimer();
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

  // 停顿到阈值：把本段累积但尚未发送的定稿句合并为一条 final 发出，驱动前端发送给 AI。
  const commitUtterance = () => {
    let pending = committedSentences.slice(flushedCount).join("").trim();
    let usedPartialFallback = false;

    // 正常停顿时尾句已被豆包定稿、已在 committedSentences 中；仅当此刻无任何已定稿待发、
    // 却仍有未定稿尾句时，才用尾句兜底，避免最后一句丢失。
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
    // 强制下一帧重新评估剩余内容，避免残留尾句被漏发
    lastLiveText = "";
    hasSentFinal = true;
    sendToBrowser({ type: "final", text: pending });
  };

  const scheduleCommit = () => {
    clearCommitTimer();
    commitTimer = setTimeout(commitUtterance, UTTERANCE_COMMIT_SILENCE_MS);
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

    const { definites, partial } = extractUtteranceResults(decoded.payload);
    // 按下标把本帧定稿句序列对齐进 committedSentences：
    //   - 已存在且尚未发送的下标：用最新文本覆盖（吸收后补的标点/纠错），已发送的下标不动；
    //   - 超出现有长度的下标：是新句，追加。
    for (let index = 0; index < definites.length; index += 1) {
      const definiteText = definites[index];
      if (index < committedSentences.length) {
        if (index >= flushedCount) {
          committedSentences[index] = definiteText;
        }
        continue;
      }

      committedSentences.push(definiteText);
      // 兜底跳过：该新定稿句此前已作为未定稿尾句兜底发出过（停顿时它尚未定稿）。
      // 归一化比较（兜底稿无标点、定稿带标点），命中则把水位线推过它，使其不再被二次发送。
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

    // 本段尚未发送的实时全文 = 未发送的定稿句 + 未定稿尾句
    const liveText = committedSentences.slice(flushedCount).join("") + lastPartial;
    if (liveText !== lastLiveText) {
      lastLiveText = liveText;
      if (liveText.trim()) {
        sendToBrowser({ type: "partial", text: liveText, isInterim: true });
      }
      // 文本仍在变化＝用户还在说：把「停顿提交」计时推后；静默满阈值才真正发送
      scheduleCommit();
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
      result_type: "full",
      end_window_size: DOUBAO_END_WINDOW_SIZE_MS,
      force_to_speech_time: DOUBAO_FORCE_TO_SPEECH_TIME_MS
    }
  };
}

/** 单帧解析结果：本帧全部定稿句（按序）+ 当前未定稿的尾句 */
type UtteranceExtraction = {
  /**
   * 本帧全部 definite 定稿句，按豆包返回的原始顺序排列（累积、含历史句）。
   * 调用方按下标与 committedSentences 对齐，从而区分「同句补标点」与「真正新句」。
   */
  definites: string[];
  /** 当前仍在累积、未定稿的尾句，作为 partial 实时预览；无则为 null */
  partial: string | null;
};

/**
 * 从 full server response 的 payload 中解析定稿句序列与未定稿尾句。
 *
 * 官方结构：`{ result: { text: "累积文本", utterances: [{ definite, start_time, end_time, text, words }] } }`。
 * `definite:true` 表示服务端 VAD 判定该句已说完（正道分句信号）。
 * result 既可能是对象也可能是数组，两种都兼容；无 utterances 时回退用累积 text 作为 partial。
 *
 * 去重不在此处做：本函数只忠实返回「当前定稿句序列」，由调用方按下标对齐 committedSentences
 * 完成「同句补标点＝更新、新句＝追加」的判定（见 handleUpstreamFrame）。
 */
function extractUtteranceResults(
  payload: Record<string, unknown>
): UtteranceExtraction {
  const result = payload.result;
  const resultRecord = Array.isArray(result)
    ? (result[0] as Record<string, unknown> | undefined)
    : (result as Record<string, unknown> | undefined);

  if (!resultRecord) {
    return { definites: [], partial: null };
  }

  const utterances = resultRecord.utterances;
  if (!Array.isArray(utterances)) {
    // 兜底：无分句信息时，用累积 text 作为 partial 预览（不作为 final，避免整段误发）
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
      // 忠实按序收集定稿句，去重交由调用方的下标对齐完成。
      definites.push(text);
    } else {
      // 未定稿尾句：只保留最后一个作为当前预览
      partial = text;
    }
  }

  return { definites, partial };
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
