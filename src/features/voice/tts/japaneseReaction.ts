import type { EmotionLabel } from "../../emotion/emotionTypes";

export type JapaneseReactionStyle = "greeting" | "happy";

export type JapaneseReaction = {
  text: string;
  style: JapaneseReactionStyle;
};

const GREETING_PATTERN = /^(?:void[\s,，]*)?(你好|您好|嗨|哈喽|hello|hi|早上好|晚上好|在吗|好久不见)/i;

export function isGreetingMessage(text: string): boolean {
  return GREETING_PATTERN.test(text.trim());
}

/**
 * 选择本轮日语短反应（只进 TTS，不写入聊天文本）。
 * - 开心：固定短反应；
 * - 平静/中性且用户打招呼：日语问候；
 * - 生气/难过/压力：不使用日语（用户明确要求被惹生气时不要开心日语）。
 */
export function selectJapaneseReaction(
  agentEmotion: EmotionLabel,
  userMessage: string
): JapaneseReaction | null {
  if (agentEmotion === "happy") {
    return { text: "えへへ、うれしい！", style: "happy" };
  }
  if (agentEmotion === "angry" || agentEmotion === "sad" || agentEmotion === "stressed") {
    return null;
  }
  return isGreetingMessage(userMessage)
    ? { text: "こんにちは！VOIDだよ。", style: "greeting" }
    : null;
}
