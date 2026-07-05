export type VoiceSynthesisRequest = {
  text: string;
  requestMode: "development-proxy" | "production-proxy";
  voiceMode?: "default" | "scene";
  preferredGender?: "female" | "male";
  scene?: "default" | "story" | "horror" | "companion";
};

export type VoiceSynthesisResult = {
  audioUrl: string;
  mimeType?: string;
  provider: "doubao" | "minimax" | "fishaudio";
};

export interface VoiceTtsProvider {
  synthesize(request: VoiceSynthesisRequest): Promise<VoiceSynthesisResult>;
}
