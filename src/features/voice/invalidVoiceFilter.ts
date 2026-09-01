// VOID 无效语音过滤 —— 06 号文档 §3/§5：音量+语义完整度+上下文+唤醒综合判定
// 职责：判定一条 STT 定稿是否为无效背景音，若无效则不上屏、不进对话、不写记忆。
// 不另起 VAD 引擎，复用已有 voiceActivityLevel + STT 文本 + 唤醒检测。

import { isVoiceWakeDetected } from "./wakeWordDetector";

const FILLER_ONLY_REGEX = /^(嗯|啊|哦|呃|唉|呢|吧|呀|哈|呵)+$/;
const MIN_VALID_CHARS = 2;

export type InvalidVoiceReason =
  | "too_short"
  | "filler_only"
  | "no_wake_and_no_request"
  | "background_noise";

export type InvalidVoiceResult = {
  valid: boolean;
  reason?: InvalidVoiceReason;
};

/**
 * 判定 STT 定稿是否有效。
 * @param transcript STT 最终文本
 * @param options 辅助信号：activityLevel 已在上游 VAD，给“远处背景声”参考；hasRecentConversation 表示是否有上下文可追问
 */
export function filterInvalidVoice(
  transcript: string,
  options: {
    hasRecentConversation?: boolean;
    activityLevel?: "silent" | "active";
  } = {}
): InvalidVoiceResult {
  const text = transcript.trim();
  const normalized = text.replace(/[\s\p{P}]/gu, "");

  if (normalized.length < MIN_VALID_CHARS) {
    return { valid: false, reason: "too_short" };
  }
  if (FILLER_ONLY_REGEX.test(normalized)) {
    return { valid: false, reason: "filler_only" };
  }

  // 有唤醒词/判断唤醒 → 直接有效
  if (isVoiceWakeDetected(text)) {
    return { valid: true };
  }

  // 有最近对话上下文，追问类短句也视为有效（06 §2.2 延续前文话题）
  if (options.hasRecentConversation && normalized.length >= 2) {
    return { valid: true };
  }

  // 无唤醒、无上下文、且文本过短且无明确请求动词 → 视为背景/碎片音
  const hasRequestVerb = /帮|查|搜|记|提醒|写|翻译|总结|整理|打开|下载|保存|找/.test(text);
  if (!hasRequestVerb && normalized.length <= 4) {
    // 结合 VAD：silent 时更可能是远处背景
    if (options.activityLevel === "silent") {
      return { valid: false, reason: "background_noise" };
    }
    return { valid: false, reason: "no_wake_and_no_request" };
  }

  return { valid: true };
}
