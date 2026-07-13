/**
 * 语音回合组装器。
 *
 * 职责边界：
 * - Worker 侧负责「用户是否说完」的主判停（当前 1.5s 静音）。
 * - 本模块不再叠加第二段静音等待，避免总延迟变成 3 秒。
 * - 本模块只做：草稿预览、最短长度过滤、相邻 final 合并、关麦强制 flush。
 *
 * 为什么还需要前端组装：
 * 1. 豆包可能对同一句先发无标点稿、再发带标点稿，短间隔内出现两条 final。
 * 2. 关麦时要立刻提交当前草稿，不能再等 Worker 静音计时。
 * 3. 把「何时真正交给 AI」收敛到唯一出口，便于后续继续调参。
 *
 * 关键修复：final 进入合并窗后，麦克风仍在推静音/残余音频，上游会继续吐 partial。
 * 旧逻辑一律清空 pendingFinal，导致「只见预览、不进入思考，关麦才发送」。
 * 合并窗内 partial 只能：忽略噪声、续说接管、或新句抢先提交旧 final。
 */

/** 相邻 final 合并窗口：只合并标点修订/抖动重发，不拉长正常回合。 */
const FINAL_COALESCE_MS = 400;

/** 提交后短静默：挡住同一句的尾音/残余 partial 再次回调，避免误 barge-in。 */
const POST_COMMIT_SUPPRESS_MS = 1200;

/** 过短噪声不提交（语气词/误触），正常短指令如「你好」仍可通过。 */
const MIN_COMMIT_CHARS = 1;

export type VoiceTurnAssemblerOptions = {
  /** 实时预览（partial 或合并中的草稿） */
  onPreview: (text: string) => void;
  /** 唯一的「用户回合完成」出口，才会触发模型请求 */
  onCommit: (text: string) => void;
};

export class VoiceTurnAssembler {
  private readonly onPreview: (text: string) => void;
  private readonly onCommit: (text: string) => void;

  private draftText = "";
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFinalText = "";
  private disposed = false;
  /** 最近一次成功提交的归一化文本 + 时间，用于 residual partial 抑制。 */
  private lastCommittedNormalized = "";
  private lastCommittedAt = 0;

  constructor(options: VoiceTurnAssemblerOptions) {
    this.onPreview = options.onPreview;
    this.onCommit = options.onCommit;
  }

  /**
   * 识别中间结果：只更新预览与草稿，绝不提交。
   * 若已有 pending final，禁止无脑清空，否则会把已判停的回合永远卡在预览态。
   */
  handlePartial(text: string) {
    if (this.disposed) {
      return;
    }

    const normalized = text.trim();
    if (!normalized) {
      return;
    }

    // 刚提交过：同一句的尾音/补标点 residual 直接丢弃，避免上层误判为新的用户打断。
    if (this.shouldSuppressPostCommitPartial(normalized)) {
      return;
    }

    // 合并窗打开期间：final 已判停，partial 只允许三种处理，禁止直接抹掉 pendingFinal。
    if (this.coalesceTimer && this.pendingFinalText) {
      if (!normalized) {
        return;
      }

      const pendingKey = normalizeForCompare(this.pendingFinalText);
      const partialKey = normalizeForCompare(normalized);

      // 同一句的残余/标点抖动：忽略，让合并窗正常提交。
      if (
        !partialKey
        || partialKey === pendingKey
        || pendingKey.startsWith(partialKey)
        || this.pendingFinalText.includes(normalized)
      ) {
        return;
      }

      // 用户其实还在续说：pending 只是中间定稿，取消提交，回到草稿跟读。
      if (partialKey.startsWith(pendingKey) || normalized.includes(this.pendingFinalText)) {
        this.clearCoalesceTimer();
        this.pendingFinalText = "";
        this.draftText = normalized;
        this.onPreview(normalized);
        return;
      }

      // 明显是下一句：立刻提交上一句，再开始新草稿。
      this.commitPendingFinal();
      this.draftText = normalized;
      this.onPreview(normalized);
      return;
    }

    this.draftText = normalized;
    this.onPreview(normalized);
  }

  /**
   * Worker 已判停后的 final。
   * 这里只做短窗合并与最短长度过滤，不再二次等待 1.5s。
   */
  handleFinal(text: string, commitImmediately = false) {
    if (this.disposed) {
      return;
    }

    const normalized = text.trim();
    if (!normalized) {
      return;
    }

    // 与草稿合并：final 优先；若草稿明显更长且以 final 为前缀，保留草稿后缀（续说抖动保护）。
    const merged = mergeUtteranceText(this.pendingFinalText || this.draftText, normalized);
    this.pendingFinalText = merged;
    this.draftText = merged;
    this.onPreview(merged);

    this.clearCoalesceTimer();
    if (commitImmediately) {
      this.commitPendingFinal();
      return;
    }
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      this.commitPendingFinal();
    }, FINAL_COALESCE_MS);
  }

  /**
   * 关麦 / 停止会话时强制提交。
   * 用户主动结束说话，应立即把当前草稿交给 AI，不再等合并窗。
   */
  flush() {
    if (this.disposed) {
      return;
    }

    this.clearCoalesceTimer();
    const text = (this.pendingFinalText || this.draftText).trim();
    this.pendingFinalText = "";
    this.draftText = "";
    if (text && countCommitChars(text) >= MIN_COMMIT_CHARS) {
      this.lastCommittedNormalized = normalizeForCompare(text);
      this.lastCommittedAt = Date.now();
      this.onCommit(text);
    }
    this.onPreview("");
  }

  /** 释放定时器，停止后续回调。 */
  dispose() {
    this.disposed = true;
    this.clearCoalesceTimer();
    this.pendingFinalText = "";
    this.draftText = "";
  }

  private commitPendingFinal() {
    this.clearCoalesceTimer();
    const text = this.pendingFinalText.trim();
    this.pendingFinalText = "";
    this.draftText = "";
    this.onPreview("");

    if (!text || countCommitChars(text) < MIN_COMMIT_CHARS) {
      return;
    }

    this.lastCommittedNormalized = normalizeForCompare(text);
    this.lastCommittedAt = Date.now();
    this.onCommit(text);
  }

  /**
   * 提交后短窗内，若 partial 与上一句相同或互为前缀，视为 residual，不向 UI 冒泡。
   * 真正的新句子（归一化后既不相等也不互为前缀）仍放行。
   */
  private shouldSuppressPostCommitPartial(text: string) {
    if (!this.lastCommittedNormalized) {
      return false;
    }
    if (Date.now() - this.lastCommittedAt > POST_COMMIT_SUPPRESS_MS) {
      return false;
    }

    const partialKey = normalizeForCompare(text);
    if (!partialKey) {
      return true;
    }

    return (
      partialKey === this.lastCommittedNormalized
      || this.lastCommittedNormalized.startsWith(partialKey)
      || partialKey.startsWith(this.lastCommittedNormalized)
    );
  }

  private clearCoalesceTimer() {
    if (this.coalesceTimer) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
  }
}

/**
 * 合并两段识别文本：
 * - 相同或一方为空：取非空
 * - 新文本包含旧文本：取新文本（补标点/扩写）
 * - 旧文本以新文本为前缀：保留旧文本（避免回退）
 * - 否则：拼接（相邻 final 续说）
 */
function mergeUtteranceText(previousText: string, nextText: string) {
  const previous = previousText.trim();
  const next = nextText.trim();

  if (!previous) {
    return next;
  }
  if (!next) {
    return previous;
  }
  if (previous === next) {
    return next;
  }

  const previousKey = normalizeForCompare(previous);
  const nextKey = normalizeForCompare(next);
  if (!previousKey) {
    return next;
  }
  if (!nextKey) {
    return previous;
  }
  if (nextKey.includes(previousKey) || next.includes(previous)) {
    return next;
  }
  if (previousKey.includes(nextKey) || previous.includes(next)) {
    return previous;
  }

  // 相邻 final 续说：中间补空格仅在两侧都不是中日韩字符时，避免中文被插空格。
  const needsSpace = /[A-Za-z0-9]$/.test(previous) && /^[A-Za-z0-9]/.test(next);
  return `${previous}${needsSpace ? " " : ""}${next}`;
}

function normalizeForCompare(text: string) {
  return text.replace(/[\s\p{P}]/gu, "");
}

function countCommitChars(text: string) {
  return normalizeForCompare(text).length;
}
