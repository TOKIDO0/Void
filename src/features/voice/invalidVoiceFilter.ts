// VOID 无效语音过滤 —— 06 号文档 §3/§5：音量+语义完整度+上下文+唤醒综合判定
// 职责：判定一条 STT 定稿是否为无效背景音，若无效则不上屏、不进对话、不写记忆。
// 2026-11 噪音修复：默认只在「唤醒词」或「Agent 刚说完的追问窗口」内接收语音；
// 家人通话/电视等背景说话即使被 ASR 转成完整句子，也不进入对话。

import { isWakeWordDetected } from "./wakeWordDetector";

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
 * @param options.followUpWindow 是否处于 Agent 说完后的追问窗口
 * @param options.activityLevel 上游 VAD 状态（保留给日志/后续 VAD 模型）
 */
export function filterInvalidVoice(
  transcript: string,
  options: {
    followUpWindow?: boolean;
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

  // 明确说了唤醒词：接收。
  if (isWakeWordDetected(text)) {
    return { valid: true };
  }

  // Agent 刚说完，用户可以不喊唤醒词直接追问。
  if (options.followUpWindow === true) {
    return { valid: true };
  }

  // 没有唤醒词、也不在追问窗口：无论句子多长，都视为背景声，不进入对话。
  return {
    valid: false,
    reason: options.activityLevel === "silent" ? "background_noise" : "no_wake_and_no_request"
  };
}
