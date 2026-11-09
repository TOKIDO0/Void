/**
 * 本地 TTS 主线程 / worker 线程的共享合同。
 *
 * owner：本文件只放常量、错误类型与 worker 消息结构；
 * 引擎加载与合成在 voiceTtsWorker，HTTP 队列/取消在 voiceTtsEngine。
 */

export const DEFAULT_VOICE_ID = 47; // zf_xiaoxiao
export const MAX_TEXT_CHARS = 500;
export const IDLE_UNLOAD_MS = 60_000;
export const SAMPLE_RATE_FALLBACK = 24000;

export type GeneratedAudio = { samples: Float32Array; sampleRate: number };

export type OfflineTts = {
  generate(request: { text: string; sid: number; speed: number; enableExternalBuffer?: boolean }): GeneratedAudio;
  sampleRate: number;
  numSpeakers: number;
};

export type VoiceTtsEngineErrorCode =
  | "LOCAL_TTS_MODEL_MISSING"
  | "LOCAL_TTS_MODEL_INVALID"
  | "LOCAL_TTS_ENGINE_INIT_FAILED"
  | "LOCAL_TTS_TEXT_INVALID"
  | "LOCAL_TTS_GENERATE_FAILED"
  | "LOCAL_TTS_BUSY"
  | "LOCAL_TTS_ABORTED";

export class VoiceTtsEngineError extends Error {
  constructor(readonly code: VoiceTtsEngineErrorCode, message: string) {
    super(message);
    this.name = "VoiceTtsEngineError";
  }
}

export type VoiceTtsWorkerRequest = {
  type: "synthesize";
  id: number;
  text: string;
  voiceId?: number;
};

export type VoiceTtsWorkerResult = {
  type: "result";
  id: number;
  pcm: Uint8Array;
  sampleRate: number;
};

export type VoiceTtsWorkerError = {
  type: "error";
  id: number;
  code: VoiceTtsEngineErrorCode;
  message: string;
};

export type VoiceTtsWorkerResponse = VoiceTtsWorkerResult | VoiceTtsWorkerError;
