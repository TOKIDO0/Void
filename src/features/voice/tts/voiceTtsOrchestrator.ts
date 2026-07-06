import { ProviderRequestError } from "../../../lib/model-providers/providerErrors";
import type { VoiceRuntimeConfig } from "../voiceRuntimeConfig";
import { DoubaoTtsProvider } from "./doubaoTtsProvider";
import { FishAudioTtsProvider } from "./fishAudioTtsProvider";
import { MiniMaxTtsProvider } from "./minimaxTtsProvider";
import type { VoiceSynthesisRequest, VoiceSynthesisResult, VoiceTtsProvider } from "./voiceTtsContract";

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
const PRIMARY_PROVIDER_TIMEOUT_MS = 12000;
const FALLBACK_PROVIDER_TIMEOUT_MS = 7000;
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
    this.providerRegistrations = [
      {
        kind: "doubao",
        timeoutMs: PRIMARY_PROVIDER_TIMEOUT_MS,
        createProvider: () => this.runtimeConfig.doubaoApiKey
          ? new DoubaoTtsProvider({
            appId: this.runtimeConfig.doubaoAppId,
            apiKey: this.runtimeConfig.doubaoApiKey,
            speakerId: this.runtimeConfig.doubaoSpeakerId,
            resourceId: this.runtimeConfig.doubaoResourceId
          })
          : null
      },
      {
        kind: "fishaudio",
        timeoutMs: FALLBACK_PROVIDER_TIMEOUT_MS,
        createProvider: () => this.runtimeConfig.fishAudioApiKey
          ? new FishAudioTtsProvider({
            apiKey: this.runtimeConfig.fishAudioApiKey,
            voiceId: this.runtimeConfig.fishAudioVoiceId,
            model: this.runtimeConfig.fishAudioModel
          })
          : null
      },
      {
        kind: "minimax",
        timeoutMs: FALLBACK_PROVIDER_TIMEOUT_MS,
        createProvider: () => this.runtimeConfig.minimaxApiKey
          ? new MiniMaxTtsProvider({
            apiKey: this.runtimeConfig.minimaxApiKey,
            groupId: this.runtimeConfig.minimaxGroupId
          })
          : null
      }
    ];
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
    const pendingTasks: { index: number; text: string }[] = [];
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

          const result = await this.synthesize(
            { ...request, text: currentTask.text },
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
