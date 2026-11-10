import type { EmotionLabel } from "../../emotion/emotionTypes";
import type { VoiceTtsStyle } from "./voiceTtsContract";

/**
 * 整轮语音语调（唯一真源）。
 *
 * Qwen3-TTS 的 instruct 只在单次合成内生效；逐块换 style 会让同一段回复出现多种情绪。
 * 因此一次回复内的所有合成块（含开场短反应）必须共用同一个 style。
 * 风格跟随「用户本轮情绪」，与 Agent 的回应语气策略保持一致。
 */
export function resolveTurnSpeechStyle(
  userEmotion: EmotionLabel,
  safetyCritical: boolean
): VoiceTtsStyle {
  if (safetyCritical) {
    return "serious";
  }

  switch (userEmotion) {
    case "happy":
      return "happy";
    case "angry":
    case "stressed":
    case "sad":
      return "serious";
    default:
      return "neutral";
  }
}
