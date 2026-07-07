// 情绪 → TTS 表达参数（豆包 seed-tts audio_params 子集）。供应商不支持时静默忽略。
export type VoiceSynthesisExpression = {
  speechRate?: number;
  loudnessRate?: number;
  pitch?: number;
};

export type VoiceSynthesisRequest = {
  text: string;
  requestMode: "development-proxy" | "production-proxy";
  voiceMode?: "default" | "scene";
  preferredGender?: "female" | "male";
  scene?: "default" | "story" | "horror" | "companion";
  // 上一句已合成文本，作为豆包 context_texts 语境喂给本句，承接跨句语气（滑动窗口≤2句）。
  contextText?: string;
  // 本轮情绪派生的表达参数，整轮一致，不逐句变（防自造忽高忽低）。
  expression?: VoiceSynthesisExpression;
  signal?: AbortSignal;
};

export type VoiceSynthesisResult = {
  audioUrl: string;
  mimeType?: string;
  provider: "doubao" | "minimax" | "fishaudio";
};

export interface VoiceTtsProvider {
  synthesize(request: VoiceSynthesisRequest): Promise<VoiceSynthesisResult>;
}
