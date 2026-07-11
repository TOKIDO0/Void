const TARGET_SAMPLE_RATE = 16000;

export type EncodedVoiceChunk = {
  audioBase64: string;
  sampleRate: number;
};

/**
 * 麦克风 PCM 采集与 16k/s16le 编码。
 *
 * 约束：
 * - 只在 STT 会话 ready 后创建，避免空推音频。
 * - 创建后立即 resume AudioContext，防止「用户手势 → 异步握手」后 context 处于 suspended，
 *   导致 onaudioprocess 不触发、表现为完全不识别。
 * - ScriptProcessor 必须挂到可运行图上才会回调；经 0 增益节点接到 destination，
 *   满足浏览器要求且不把麦克风直通到扬声器。
 */
export class VoicePcmEncoder {
  private readonly audioContext: AudioContext;
  private readonly mediaStream: MediaStream;
  private readonly sourceNode: MediaStreamAudioSourceNode;
  private readonly processorNode: ScriptProcessorNode;
  private readonly silentGainNode: GainNode;
  private readonly onChunk: (chunk: EncodedVoiceChunk) => void;

  constructor(mediaStream: MediaStream, onChunk: (chunk: EncodedVoiceChunk) => void) {
    this.mediaStream = mediaStream;
    this.onChunk = onChunk;
    this.audioContext = new AudioContext();
    this.sourceNode = this.audioContext.createMediaStreamSource(mediaStream);
    this.processorNode = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.silentGainNode = this.audioContext.createGain();
    this.silentGainNode.gain.value = 0;

    this.processorNode.onaudioprocess = (event) => {
      const inputChannel = event.inputBuffer.getChannelData(0);
      const downsampledBuffer = downsampleBuffer(inputChannel, this.audioContext.sampleRate, TARGET_SAMPLE_RATE);
      if (!downsampledBuffer.length) {
        return;
      }

      this.onChunk({
        audioBase64: encodePcm16ToBase64(downsampledBuffer),
        sampleRate: TARGET_SAMPLE_RATE
      });
    };

    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.silentGainNode);
    this.silentGainNode.connect(this.audioContext.destination);
  }

  /**
   * 确保 AudioContext 处于 running。
   * 必须在 STT ready 后、开始依赖 PCM 前 await；否则 suspended 时完全无识别。
   */
  async ensureRunning() {
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
  }

  async stop() {
    this.processorNode.disconnect();
    this.sourceNode.disconnect();
    this.silentGainNode.disconnect();
    this.mediaStream.getTracks().forEach((track) => track.stop());
    await this.audioContext.close();
  }
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
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }

  return window.btoa(binary);
}
