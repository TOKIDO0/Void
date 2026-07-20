import { ProviderRequestError } from "../../../lib/model-providers/providerErrors";
import type { VoiceRuntimeConfig } from "../voiceRuntimeConfig";
import { openBidirectionalStreamSession } from "./doubaoBidirectional/doubaoBidirectionalSession";
import { toDoubaoAudioRate } from "./doubaoTtsProvider";
import type {
  VoiceSynthesisExpression,
  VoiceSynthesisRequest,
  VoiceSynthesisResult,
  VoiceTtsProvider
} from "./voiceTtsContract";

// 双向流式回吐 pcm_s16le；与 doubaoBidirectionalSession / StartSession audio_params.format 一致。
// PCM + AudioWorklet 边收边播，避免 mp3+HTMLAudio/MSE 在 Tauri 上假有声与整段等待。
const DOUBAO_BIDIRECTIONAL_AUDIO_FORMAT = "pcm";
const DOUBAO_BIDIRECTIONAL_SAMPLE_RATE = 24000;

type VoiceTtsProviderRegistration = {
  kind: VoiceSynthesisResult["provider"];
  timeoutMs: number;
  createProvider: () => VoiceTtsProvider | null;
};

type VoiceSentenceSynthesisResult = {
  index: number;
  result: VoiceSynthesisResult;
};

/**
 * 流式合成会话：整轮语音输出共享的“单一队列 + 单一 worker 池”。
 * 用于替代“每批次各开一个 worker 池”的做法，从根上限制并发，避免打爆供应商速率导致 429。
 */
export type VoiceStreamingSynthesisSession = {
  /** 追加待合成句子；句子按全局递增 index 顺序合成并回调 */
  push(sentences: string[]): void;
  /** 等待当前已入队的全部句子合成完成（best-effort，不因单句失败而 reject） */
  complete(): Promise<void>;
};

// 主供应商（豆包，国内直连零 VPN）给宽松超时；回退供应商短超时快速降级。
// 全局句子级合成并发上限：FishAudio 免费档实测支持 5 并发，这里压到 2 留足安全边际，防 429
const STREAMING_SENTENCE_CONCURRENCY = 2;
// 命中 429（Too Many Requests）时的退避重试次数与基准间隔
const MAX_RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BACKOFF_BASE_MS = 500;

export class VoiceTtsOrchestrator {
  private readonly providerRegistrations: VoiceTtsProviderRegistration[];

  constructor(private readonly runtimeConfig: VoiceRuntimeConfig) {
    // 供应商尝试顺序 = 数组顺序。豆包（openspeech.bytedance.com，国内直连、单价极低、无需 VPN）
    // 作为主供应商置于首位；FishAudio（国内需 VPN）、MiniMax 依次作为回退。
    // 主供应商未配置/合成失败时自动向下回退，行为对旧默认只增不减。
    // 豆包语音已改为托管 Worker 双向流式服务，不再从客户端构造带密钥的 HTTP 供应商。
    this.providerRegistrations = [];
  }

  /**
   * 单段整段合成：按 Doubao → FishAudio → MiniMax 顺序逐个尝试，命中 429 时对同一供应商退避重试。
   * @param parentSignal 外部中断信号（打断/关闭语音输出时透传）
   */
  async synthesize(
    request: Omit<VoiceSynthesisRequest, "signal">,
    parentSignal?: AbortSignal
  ) {
    const availableProviders = this.resolveAvailableProviders();
    if (!availableProviders.length) {
      return null;
    }

    const errors: string[] = [];

    for (const { provider, registration } of availableProviders) {
      if (parentSignal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }

      try {
        return await this.attemptProviderWithRetry(provider, registration, request, parentSignal);
      } catch (error) {
        // 外部主动中断：直接向上传播，不再尝试其他供应商
        if (parentSignal?.aborted) {
          throw error;
        }
        errors.push(resolveOrchestratorErrorMessage(error, registration.kind, registration.timeoutMs));
      }
    }

    throw new Error(errors.join("；") || "语音合成失败，请检查语音供应商配置。");
  }

  /**
   * 创建整轮共享的流式合成会话。整轮只维护一个队列与一个 worker 池，
   * 无论上层 push 多少批次，全局并发都不会超过 STREAMING_SENTENCE_CONCURRENCY。
   */
  createStreamingSession(
    request: Omit<VoiceSynthesisRequest, "signal" | "text">,
    onSentenceReady: (sentenceResult: VoiceSentenceSynthesisResult) => Promise<void> | void,
    signal?: AbortSignal
  ): VoiceStreamingSynthesisSession {
    // 双向流式分支：主供应商豆包 + 开关开启 + 凭据齐全时，整轮走单一 WS session 连续合成（消灭句界）。
    // 不满足则落入下方现有逐句 HTTP 路径（Fish/MiniMax 及豆包 HTTP 原样保留）。
    if (this.shouldUseBidirectional()) {
      return this.createBidirectionalStreamingSession(request, onSentenceReady, signal);
    }

    const pendingTasks: { index: number; text: string }[] = [];
    // 按 index 记录每句净化文本，供 worker 取「上一句」作为 contextText（滑动窗口=1 句）。
    const taskTextByIndex = new Map<number, string>();
    const completedResults = new Map<number, VoiceSynthesisResult>();
    const drainWaiters: Array<() => void> = [];
    let nextTaskIndex = 0;
    let nextReadyIndex = 0;
    let activeWorkerCount = 0;
    let sessionError: unknown = null;

    const notifyDrainWaiters = () => {
      if (pendingTasks.length > 0 || activeWorkerCount > 0) {
        return;
      }
      while (drainWaiters.length) {
        drainWaiters.shift()?.();
      }
    };

    // 严格按全局 index 顺序回调，保证播放不乱序、不丢句
    const flushReadyResults = async () => {
      while (completedResults.has(nextReadyIndex)) {
        const result = completedResults.get(nextReadyIndex);
        completedResults.delete(nextReadyIndex);
        const readyIndex = nextReadyIndex;
        nextReadyIndex += 1;
        if (result) {
          await onSentenceReady({ index: readyIndex, result });
        }
      }
    };

    const runWorker = async () => {
      activeWorkerCount += 1;
      try {
        while (pendingTasks.length > 0) {
          if (signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
          }

          const currentTask = pendingTasks.shift();
          if (!currentTask) {
            break;
          }

          // 上一句净化文本作为本句 context_texts，承接跨句语气；首句无上文则不带。
          const previousText = taskTextByIndex.get(currentTask.index - 1);
          const result = await this.synthesize(
            { ...request, text: currentTask.text, contextText: previousText },
            signal
          );
          if (!result) {
            throw new Error("语音合成失败，请检查语音供应商配置。");
          }

          completedResults.set(currentTask.index, result);
          await flushReadyResults();
        }
      } catch (error) {
        // best-effort：记录首个错误但不中断整轮（文字为主，语音为辅）
        sessionError = sessionError ?? error;
      } finally {
        activeWorkerCount -= 1;
        notifyDrainWaiters();
      }
    };

    const ensureWorkers = () => {
      if (signal?.aborted) {
        return;
      }
      while (activeWorkerCount < STREAMING_SENTENCE_CONCURRENCY && pendingTasks.length > 0) {
        void runWorker();
      }
    };

    return {
      push(sentences: string[]) {
        for (const rawSentence of sentences) {
          const text = rawSentence.trim();
          if (!text) {
            continue;
          }
          pendingTasks.push({ index: nextTaskIndex, text });
          taskTextByIndex.set(nextTaskIndex, text);
          nextTaskIndex += 1;
        }
        ensureWorkers();
      },
      complete() {
        return new Promise<void>((resolve) => {
          if (pendingTasks.length === 0 && activeWorkerCount === 0) {
            if (import.meta.env.DEV && sessionError) {
              console.warn("[VOID TTS streaming session]", sessionError);
            }
            resolve();
            return;
          }
          drainWaiters.push(() => {
            if (import.meta.env.DEV && sessionError) {
              console.warn("[VOID TTS streaming session]", sessionError);
            }
            resolve();
          });
        });
      }
    };
  }

  /**
   * 托管豆包双向流式恒开；客户端仅需非敏感音色 ID。
   * 缺音色时不应静默走空供应商列表，否则上层只会“有文字、无声音、无报错”。
   */
  private shouldUseBidirectional(): boolean {
    const speakerId = this.runtimeConfig.doubaoSpeakerId.trim();
    if (!speakerId) {
      console.warn("[VOID TTS] 缺少 doubaoSpeakerId，已跳过语音合成。请在设置中填写音色 ID。");
      return false;
    }
    return true;
  }

  /**
   * 双向流式合成会话（低延迟主线）：
   * - 会话创建时立即预连接 Worker，不必等首句才握手；
   * - 首句 push 后边喂文本边收 PCM；
   * - 首块 PCM 以 ReadableStream 交给 AudioWorklet 边收边播；
   * - 同一 WS session 连续合成，保持整段韵律，播放层只收到一次 onSentenceReady。
   */
  private createBidirectionalStreamingSession(
    request: Omit<VoiceSynthesisRequest, "signal" | "text">,
    onSentenceReady: (sentenceResult: VoiceSentenceSynthesisResult) => Promise<void> | void,
    signal?: AbortSignal
  ): VoiceStreamingSynthesisSession {
    let playbackNotified = false;

    // 预连接：创建即握手，与首句文本并行，降低 TTFA。
    const streamSession = openBidirectionalStreamSession(
      {
        speaker: this.runtimeConfig.doubaoSpeakerId.trim(),
        audioParams: buildBidirectionalAudioParams(request.expression)
      },
      {
        onPcmStreamReady: async (pcmStream, sampleRate, sessionId) => {
          if (signal?.aborted) {
            void pcmStream.cancel();
            return;
          }
          if (playbackNotified) {
            void pcmStream.cancel();
            return;
          }
          playbackNotified = true;
          await onSentenceReady({
            index: 0,
            result: {
              pcmStream,
              sampleRate,
              sessionId,
              provider: "doubao"
            }
          });
        },
        onError: (error) => {
          // best-effort：语音失败不阻断文字回合。
          // AbortError 是用户打断/新回合替换的正常路径，不刷黄字；其它错误才告警。
          if (error instanceof DOMException && error.name === "AbortError") {
            return;
          }
          console.warn("[VOID TTS bidirectional session]", error);
        }
      },
      signal
    );

    return {
      push: (sentences: string[]) => {
        if (signal?.aborted) {
          return;
        }
        for (const rawSentence of sentences) {
          const text = rawSentence.trim();
          if (!text) {
            continue;
          }
          streamSession.pushText(text);
        }
      },
      complete: async () => {
        if (signal?.aborted) {
          return;
        }
        // 预连接后若本轮无任何可读文本，仍要 complete 收口，避免悬挂 WebSocket。
        // 会话内部对「零文本」会直接 settle，不会空等豆包音频。
        await streamSession.complete();
      }
    };
  }

  /**
   * 句子级批量合成（非流式整段兜底路径使用）。内部同样走单一会话，全局并发受控。
   */
  async synthesizeSentences(
    sentences: string[],
    request: Omit<VoiceSynthesisRequest, "signal" | "text">,
    onSentenceReady: (sentenceResult: VoiceSentenceSynthesisResult) => Promise<void> | void,
    signal?: AbortSignal
  ) {
    const session = this.createStreamingSession(request, onSentenceReady, signal);
    session.push(sentences);
    await session.complete();
  }

  private resolveAvailableProviders() {
    return this.providerRegistrations
      .map((registration) => ({
        registration,
        provider: registration.createProvider()
      }))
      .filter((entry): entry is { registration: VoiceTtsProviderRegistration; provider: VoiceTtsProvider } => Boolean(entry.provider));
  }

  /**
   * 对单个供应商发起合成，附带请求超时与 429 退避重试。
   * 429 表示“通了但太快”，正确处理是对同一供应商退避重试，而非立刻降级到未复验的下游。
   */
  private async attemptProviderWithRetry(
    provider: VoiceTtsProvider,
    registration: VoiceTtsProviderRegistration,
    request: Omit<VoiceSynthesisRequest, "signal">,
    parentSignal?: AbortSignal
  ): Promise<VoiceSynthesisResult> {
    let attempt = 0;

    for (;;) {
      const controller = new AbortController();
      const forwardParentAbort = () => controller.abort();
      parentSignal?.addEventListener("abort", forwardParentAbort, { once: true });
      const timeoutId = window.setTimeout(() => controller.abort(), registration.timeoutMs);

      try {
        return await provider.synthesize({
          ...request,
          signal: controller.signal
        });
      } catch (error) {
        if (parentSignal?.aborted) {
          throw error;
        }

        if (isRateLimitError(error) && attempt < MAX_RATE_LIMIT_RETRIES) {
          attempt += 1;
          await delayWithAbort(RATE_LIMIT_BACKOFF_BASE_MS * 2 ** (attempt - 1), parentSignal);
          continue;
        }

        throw error;
      } finally {
        window.clearTimeout(timeoutId);
        parentSignal?.removeEventListener("abort", forwardParentAbort);
      }
    }
  }
}

/**
 * 组装双向流式的 audio_params：基础封装恒定；情绪表达（speech_rate/loudness_rate）仅在本轮
 * 情绪派生出对应值时才写入整数增量（复用 toDoubaoAudioRate，与 HTTP 路径数值一致）。
 * 这些参数在 StartSession 时对整段生效，从而全段情绪一致（阶段 5）。
 */
function buildBidirectionalAudioParams(expression?: VoiceSynthesisExpression) {
  const audioParams = {
    format: DOUBAO_BIDIRECTIONAL_AUDIO_FORMAT,
    sampleRate: DOUBAO_BIDIRECTIONAL_SAMPLE_RATE
  } as {
    format: string;
    sampleRate: number;
    speechRate?: number;
    loudnessRate?: number;
  };

  if (expression) {
    if (typeof expression.speechRate === "number") {
      audioParams.speechRate = toDoubaoAudioRate(expression.speechRate);
    }
    if (typeof expression.loudnessRate === "number") {
      audioParams.loudnessRate = toDoubaoAudioRate(expression.loudnessRate);
    }
  }

  return audioParams;
}

function isRateLimitError(error: unknown) {
  return error instanceof ProviderRequestError && error.status === 429;
}

/** 退避等待，期间若外部中断则立即以 AbortError 结束 */
function delayWithAbort(delayMs: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }

    const timeoutId = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);

    const onAbort = () => {
      window.clearTimeout(timeoutId);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function resolveOrchestratorErrorMessage(
  error: unknown,
  providerKind: VoiceSynthesisResult["provider"],
  timeoutMs: number
) {
  if (error instanceof DOMException && error.name === "AbortError") {
    return `${resolveProviderLabel(providerKind)} 请求超时（${timeoutMs}ms），已切换下一个语音供应商。`;
  }

  if (error instanceof ProviderRequestError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return `${resolveProviderLabel(providerKind)} 语音合成失败。`;
}

function resolveProviderLabel(providerKind: VoiceSynthesisResult["provider"]) {
  if (providerKind === "fishaudio") {
    return "FishAudio TTS";
  }

  if (providerKind === "doubao") {
    return "Doubao TTS";
  }

  return "MiniMax TTS";
}
