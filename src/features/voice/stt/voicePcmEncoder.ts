import type { VoiceActivityLevel } from "../voiceState";

const TARGET_SAMPLE_RATE = 16000;
const SPEECH_START_RMS = 0.045;
const SPEECH_END_RMS = 0.022;
const SPEECH_END_SILENCE_MS = 1500;
const PCM_PROCESSOR_NAME = "void-voice-pcm-processor";

export type EncodedVoiceChunk = {
  audioBase64: string;
  sampleRate: number;
};

type VoicePcmEncoderOptions = {
  onChunk: (chunk: EncodedVoiceChunk) => void;
  onSpeechEnd?: () => void;
  onActivityLevelChange?: (activityLevel: VoiceActivityLevel) => void;
  onRuntimeStateChange?: (state: AudioContextState) => void;
};

/**
 * 单一麦克风 PCM owner。
 * 同一条 MediaStream 同时负责 16k/s16le 编码、speech-end 和本地音量活动，
 * 避免旧实现为 VAD 与 STT 各开一条麦克风流。
 */
export class VoicePcmEncoder {
  private readonly audioContext: AudioContext;
  private readonly mediaStream: MediaStream;
  private readonly options: VoicePcmEncoderOptions;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: AudioWorkletNode | null = null;
  private silentGainNode: GainNode | null = null;
  private speechActive = false;
  private lastSpeechAt = 0;
  private lastChunkAt = 0;
  private stopped = false;

  constructor(mediaStream: MediaStream, options: VoicePcmEncoderOptions) {
    this.mediaStream = mediaStream;
    this.options = options;
    this.audioContext = new AudioContext();
    this.audioContext.addEventListener("statechange", this.handleAudioContextStateChange);
  }

  get contextState() {
    return this.audioContext.state;
  }

  get lastPcmChunkAt() {
    return this.lastChunkAt;
  }

  async start() {
    await this.audioContext.audioWorklet.addModule(
      new URL("./voicePcmWorkletProcessor.js", import.meta.url)
    );
    if (this.stopped) {
      return;
    }

    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.processorNode = new AudioWorkletNode(this.audioContext, PCM_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1]
    });
    this.silentGainNode = this.audioContext.createGain();
    this.silentGainNode.gain.value = 0;
    this.processorNode.port.onmessage = this.handleWorkletMessage;

    // AudioWorklet 必须位于可运行音频图中；零增益输出不会把麦克风回放到扬声器。
    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.silentGainNode);
    this.silentGainNode.connect(this.audioContext.destination);
    await this.ensureRunning();
    this.lastChunkAt = Date.now();
  }

  async ensureRunning() {
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
    if (this.audioContext.state !== "running") {
      throw new Error(`麦克风 AudioContext 未运行（state=${this.audioContext.state}）。`);
    }
  }

  async stop() {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.audioContext.removeEventListener("statechange", this.handleAudioContextStateChange);
    if (this.processorNode) {
      this.processorNode.port.onmessage = null;
      this.processorNode.disconnect();
      this.processorNode = null;
    }
    this.sourceNode?.disconnect();
    this.sourceNode = null;
    this.silentGainNode?.disconnect();
    this.silentGainNode = null;
    this.mediaStream.getTracks().forEach((track) => track.stop());
    if (this.audioContext.state !== "closed") {
      await this.audioContext.close();
    }
    this.updateActivityLevel(false);
  }

  private readonly handleAudioContextStateChange = () => {
    this.options.onRuntimeStateChange?.(this.audioContext.state);
  };

  private readonly handleWorkletMessage = (event: MessageEvent<Float32Array>) => {
    if (this.stopped) {
      return;
    }
    const inputChannel = event.data;
    if (!(inputChannel instanceof Float32Array) || inputChannel.length === 0) {
      return;
    }

    this.lastChunkAt = Date.now();
    this.updateSpeechActivity(inputChannel);
    const downsampledBuffer = downsampleBuffer(
      inputChannel,
      this.audioContext.sampleRate,
      TARGET_SAMPLE_RATE
    );
    if (!downsampledBuffer.length) {
      return;
    }
    this.options.onChunk({
      audioBase64: encodePcm16ToBase64(downsampledBuffer),
      sampleRate: TARGET_SAMPLE_RATE
    });
  };

  private updateSpeechActivity(inputChannel: Float32Array) {
    const rms = calculateRms(inputChannel);
    const now = performance.now();
    if (rms >= SPEECH_START_RMS) {
      this.lastSpeechAt = now;
      if (!this.speechActive) {
        this.speechActive = true;
        this.updateActivityLevel(true);
      }
      return;
    }

    if (
      this.speechActive
      && rms <= SPEECH_END_RMS
      && now - this.lastSpeechAt >= SPEECH_END_SILENCE_MS
    ) {
      this.speechActive = false;
      this.updateActivityLevel(false);
      this.options.onSpeechEnd?.();
    }
  }

  private updateActivityLevel(active: boolean) {
    this.options.onActivityLevelChange?.(active ? "active" : "silent");
  }
}

function calculateRms(samples: Float32Array) {
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

function downsampleBuffer(inputBuffer: Float32Array, sourceSampleRate: number, targetSampleRate: number) {
  if (sourceSampleRate === targetSampleRate) {
    return inputBuffer;
  }

  const sampleRateRatio = sourceSampleRate / targetSampleRate;
  const outputLength = Math.round(inputBuffer.length / sampleRateRatio);
  const outputBuffer = new Float32Array(outputLength);
  let outputIndex = 0;
  let inputIndex = 0;

  while (outputIndex < outputLength) {
    const nextInputIndex = Math.round((outputIndex + 1) * sampleRateRatio);
    let accumulated = 0;
    let sampleCount = 0;
    for (let readIndex = inputIndex; readIndex < nextInputIndex && readIndex < inputBuffer.length; readIndex += 1) {
      accumulated += inputBuffer[readIndex];
      sampleCount += 1;
    }
    outputBuffer[outputIndex] = sampleCount > 0 ? accumulated / sampleCount : 0;
    outputIndex += 1;
    inputIndex = nextInputIndex;
  }

  return outputBuffer;
}

function encodePcm16ToBase64(floatBuffer: Float32Array) {
  const pcmBuffer = new Int16Array(floatBuffer.length);
  for (let index = 0; index < floatBuffer.length; index += 1) {
    const clampedSample = Math.max(-1, Math.min(1, floatBuffer[index]));
    pcmBuffer[index] = clampedSample < 0 ? clampedSample * 0x8000 : clampedSample * 0x7fff;
  }

  const bytes = new Uint8Array(pcmBuffer.buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return window.btoa(binary);
}
