export type VoiceTtsLanguage = "zh" | "ja";
export type VoiceTtsStyle = "happy" | "neutral" | "serious";

/**
 * 单个合成块输入。语言/风格可逐块覆盖，但生产路径必须整轮共用同一 style：
 * Qwen3-TTS 的 instruct 只在单次合成内生效，逐块切换会让同一段回复出现多种情绪。
 */
export type VoiceSentenceInput = {
  text: string;
  language?: VoiceTtsLanguage;
  style?: VoiceTtsStyle;
};

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
  /** 单块语言/风格；语言缺省时由引擎按文本自动判定，风格缺省为 neutral。 */
  language?: VoiceTtsLanguage;
  style?: VoiceTtsStyle;
  signal?: AbortSignal;
};

export type VoiceSynthesisResult =
  | {
      audioUrl: string;
      mimeType?: string;
      provider: "doubao" | "minimax" | "fishaudio";
    }
  | {
      pcmStream: ReadableStream<Uint8Array>;
      sampleRate: number;
      sessionId: string;
      provider: "doubao" | "local" | "qwen3";
    };

export interface VoiceTtsProvider {
  synthesize(request: VoiceSynthesisRequest): Promise<VoiceSynthesisResult>;
}
