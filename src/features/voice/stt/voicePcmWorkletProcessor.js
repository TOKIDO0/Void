const OUTPUT_CHUNK_SAMPLES = 2048;

class VoidVoicePcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.outputBuffer = new Float32Array(OUTPUT_CHUNK_SAMPLES);
    this.outputOffset = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input?.length) {
      return true;
    }

    let inputOffset = 0;
    while (inputOffset < input.length) {
      const writable = Math.min(
        input.length - inputOffset,
        this.outputBuffer.length - this.outputOffset
      );
      this.outputBuffer.set(input.subarray(inputOffset, inputOffset + writable), this.outputOffset);
      this.outputOffset += writable;
      inputOffset += writable;

      if (this.outputOffset === this.outputBuffer.length) {
        const samples = this.outputBuffer;
        this.port.postMessage(samples, [samples.buffer]);
        this.outputBuffer = new Float32Array(OUTPUT_CHUNK_SAMPLES);
        this.outputOffset = 0;
      }
    }

    return true;
  }
}

registerProcessor("void-voice-pcm-processor", VoidVoicePcmProcessor);
