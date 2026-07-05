const TARGET_SAMPLE_RATE = 16000;

export type EncodedVoiceChunk = {
  audioBase64: string;
  sampleRate: number;
};

export class VoicePcmEncoder {
  private readonly audioContext: AudioContext;
  private readonly mediaStream: MediaStream;
  private readonly sourceNode: MediaStreamAudioSourceNode;
  private readonly processorNode: ScriptProcessorNode;
  private readonly onChunk: (chunk: EncodedVoiceChunk) => void;

  constructor(mediaStream: MediaStream, onChunk: (chunk: EncodedVoiceChunk) => void) {
    this.mediaStream = mediaStream;
    this.onChunk = onChunk;
    this.audioContext = new AudioContext();
    this.sourceNode = this.audioContext.createMediaStreamSource(mediaStream);
    this.processorNode = this.audioContext.createScriptProcessor(4096, 1, 1);
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
    this.processorNode.connect(this.audioContext.destination);
  }

  async stop() {
    this.processorNode.disconnect();
    this.sourceNode.disconnect();
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
