// VOID 唤醒词检测 —— 纯文本匹配，不引重型 WASM 引擎
// 依据 06 号文档 §2.1：默认唤醒词 hello void / hi void / 你好 void / 你好VOID / VOID
// 决策：不集成 Porcupine/openWakeWord（需 AccessKey/ONNX/模型下发，重且与本地无密钥原则冲突），
// 直接复用已有的豆包 STT 文本结果做大小写/空白归一化匹配，零新增依赖。

export const DEFAULT_WAKE_WORDS: readonly string[] = [
  "hello void",
  "hi void",
  "你好 void",
  "你好void",
  "void"
];

function normalizeTranscript(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeWakeWord(word: string): string {
  return word.trim().toLowerCase().replace(/\s+/g, " ");
}

/** 文本是否命中任一唤醒词（归一化后包含匹配，支持句中唤醒如“你好 void 帮我记一下”）。 */
export function isWakeWordDetected(
  transcript: string,
  wakeWords: readonly string[] = DEFAULT_WAKE_WORDS
): boolean {
  const normalized = normalizeTranscript(transcript);
  if (!normalized) return false;
  for (const word of wakeWords) {
    const needle = normalizeWakeWord(word);
    if (!needle) continue;
    if (normalized === needle || normalized.includes(needle)) return true;
  }
  return false;
}

/** 判断唤醒（06 §2.2）：无唤醒词但语义明显在和 VOID 说话 */
const JUDGMENT_WAKE_KEYWORDS: readonly string[] = [
  "你帮我",
  "帮我记",
  "提醒我",
  "查一下",
  "搜一下",
  "帮我搜",
  "刚才",
  "继续说",
  "帮我写",
  "帮我想"
];

export function isJudgmentWakeDetected(transcript: string): boolean {
  const normalized = normalizeTranscript(transcript);
  if (!normalized) return false;
  return JUDGMENT_WAKE_KEYWORDS.some((kw) => normalized.includes(kw.toLowerCase()));
}

/** 综合唤醒：唤醒词或判断唤醒任一命中即视为唤醒 */
export function isVoiceWakeDetected(transcript: string): boolean {
  return isWakeWordDetected(transcript) || isJudgmentWakeDetected(transcript);
}
