export type TtsExpressionActionId =
  | "tts_aside_complaint"
  | "tts_boundary_line"
  | "tts_refuse";

/** P4.a 仅支持 TTS 短插句；后续桌面动作不得塞进该类型。 */
export type TtsExpressionAction = {
  actionId: TtsExpressionActionId;
  variantId: string;
  text: string;
};

