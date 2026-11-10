import type { EmotionLabel } from "../../emotion/emotionTypes";

/** 本轮语音开场短反应（只进 TTS，不写入聊天文本与历史）。 */
export type TurnReaction = {
  text: string;
};

/** 打招呼句式：命中即给一句中性开场反应。 */
const GREETING_PATTERN = /^(?:void[\s,，]*)?(你好|您好|嗨|哈喽|hello|hi|早上好|晚上好|在吗|好久不见)/i;

/**
 * 短反应句长上限：超过视为正式指令或任务，不再插开场反应，
 * 避免「说任务时先来一句情绪话」的答非所问。
 */
const MAX_REACTION_TRIGGER_CHARS = 20;

export function isGreetingMessage(text: string): boolean {
  return GREETING_PATTERN.test(text.trim());
}

/**
 * 选择本轮语音开场短反应。
 *
 * 与旧实现的关键差异：
 * - 只看「用户本轮情绪」，不看 Agent 的持久情绪标签，避免常驻标签导致每轮都插反应；
 * - 一律使用中文短句，语调交给整轮统一的 style 决定，不再单独下发 happy/日语参数，
 *   从根上消除「首句笑一声、下一句换情绪」的断点；
 * - 生气/难过/压力一律不使用，安全场景由调用方按 serious 处理。
 */
export function selectTurnReaction(
  userEmotion: EmotionLabel,
  userMessage: string
): TurnReaction | null {
  if (userEmotion === "angry" || userEmotion === "sad" || userEmotion === "stressed") {
    return null;
  }
  if (userMessage.trim().length > MAX_REACTION_TRIGGER_CHARS) {
    return null;
  }
  if (userEmotion === "happy") {
    return { text: "听着不错。" };
  }
  return isGreetingMessage(userMessage) ? { text: "在呢，你说。" } : null;
}
