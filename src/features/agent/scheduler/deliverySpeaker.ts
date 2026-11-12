/**
 * AJ 早报语音 v1：投递摘要 TTS 播报（独立 controller，不碰 VoidStage 热语音路径）。
 * 门：语音输出开关开 + 窗口可见 + 有音色；任一不满足静默跳过（系统通知已兜底）。
 * 分句用朴素切分（投递摘要短，括号伪影可忽略；整轮级韵律保护仍走 VoidStage 主路径，不复刻）。
 */

import { loadVoicePreferences } from "../../voice/voicePreferences";
import { loadVoiceRuntimeConfig } from "../../voice/voiceRuntimeConfig";
import { stripLinksForSpeech } from "../../voice/tts/speechTextSanitizer";
import { VoicePlaybackController } from "../../voice/tts/voicePlaybackController";
import { VoiceTtsOrchestrator } from "../../voice/tts/voiceTtsOrchestrator";
import type { VoiceSynthesisResult } from "../../voice/tts/voiceTtsContract";

const MAX_SPEAK_CHARS = 500;

const controller = new VoicePlaybackController();
let currentAbort: AbortController | null = null;
let speaking = false;

export function isDeliverySpeaking(): boolean {
  return speaking;
}

function sanitizeDeliveryText(rawText: string): string {
  return stripLinksForSpeech(rawText)
    .replace(/(?:\*\*|__|~~|`)/g, "")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, MAX_SPEAK_CHARS);
}

function splitNaive(text: string): string[] {
  return text
    .split(/(?<=[。！？\n])/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function releaseResult(result: VoiceSynthesisResult): void {
  if ("audioUrl" in result) {
    URL.revokeObjectURL(result.audioUrl);
    return;
  }
  void result.pcmStream.cancel();
}

function enqueueResult(result: VoiceSynthesisResult): void {
  if ("pcmStream" in result) {
    controller.enqueuePcmStream(result.pcmStream, result.sampleRate, result.sessionId);
    return;
  }
  controller.enqueue(result.audioUrl);
}

/** 播报结果：区分“能力不满足”（skipped）与“真的失败”（failed），供台账如实呈现。 */
export type DeliverySpeechOutcome =
  | { state: "sent" }
  | { state: "skipped"; reason: "VOICE_OFF" | "WINDOW_HIDDEN" | "NO_SPEAKER" | "EMPTY_TEXT" }
  | { state: "failed"; reason: "TTS_FAILED" };

/**
 * 播报投递摘要。
 * 只执行 PRO-01 已经批准的计划；这里的三道门是“能不能执行”，不是“该不该播”。
 */
export async function speakDeliveryText(rawText: string): Promise<DeliverySpeechOutcome> {
  try {
    if (!loadVoicePreferences().voiceOutputEnabled) {
      return { state: "skipped", reason: "VOICE_OFF" };
    }
    if (typeof document !== "undefined" && document.visibilityState !== "visible") {
      return { state: "skipped", reason: "WINDOW_HIDDEN" };
    }
    const text = sanitizeDeliveryText(rawText);
    if (!text) {
      return { state: "skipped", reason: "EMPTY_TEXT" };
    }
    const runtimeConfig = loadVoiceRuntimeConfig();
    if (!runtimeConfig.doubaoSpeakerId.trim()) {
      return { state: "skipped", reason: "NO_SPEAKER" };
    }
    currentAbort?.abort();
    const signal = new AbortController();
    currentAbort = signal;
    speaking = true;
    try {
      const orchestrator = new VoiceTtsOrchestrator(runtimeConfig);
      const sentences = splitNaive(text);
      if (!sentences.length) {
        return { state: "skipped", reason: "EMPTY_TEXT" };
      }
      await orchestrator.synthesizeSentences(
        sentences,
        {
          requestMode: runtimeConfig.requestMode,
          voiceMode: "default",
          preferredGender: "female",
          scene: "default"
        },
        async ({ result }) => {
          if (signal.signal.aborted) {
            releaseResult(result);
            return;
          }
          enqueueResult(result);
        },
        signal.signal
      );
      return { state: "sent" };
    } finally {
      speaking = false;
      if (currentAbort === signal) {
        currentAbort = null;
      }
    }
  } catch {
    return { state: "failed", reason: "TTS_FAILED" };
  }
}
