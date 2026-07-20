const START_BUFFER_MS = 200;

class VoidPcmPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.currentChunk = null;
    this.currentOffset = 0;
    this.queuedSamples = 0;
    this.inputSampleRate = 24000;
    this.playing = false;
    this.finishRequested = false;
    this.startedEmitted = false;
    this.drainedEmitted = false;
    this.sourcePhase = 0;

    this.port.onmessage = (event) => {
      const message = event.data;
      if (message?.type === "configure") {
        this.inputSampleRate = message.sampleRate;
        return;
      }
      if (message?.type === "audio" && message.samples instanceof ArrayBuffer) {
        const samples = new Int16Array(message.samples);
        if (samples.length) {
          this.queue.push(samples);
          this.queuedSamples += samples.length;
        }
        return;
      }
      if (message?.type === "finish") {
        this.finishRequested = true;
        return;
      }
      if (message?.type === "reset") {
        this.queue = [];
        this.currentChunk = null;
        this.currentOffset = 0;
        this.queuedSamples = 0;
        this.playing = false;
        this.finishRequested = true;
        this.sourcePhase = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) {
      return true;
    }

    const startThreshold = Math.max(1, Math.round(this.inputSampleRate * START_BUFFER_MS / 1000));
    if (!this.playing && (this.queuedSamples >= startThreshold || (this.finishRequested && this.queuedSamples > 0))) {
      this.playing = true;
    }

    if (!this.playing) {
      output.fill(0);
      this.emitDrainedIfNeeded();
      return true;
    }

    // AudioContext 按 24kHz 创建；若宿主实际采用其它采样率，使用线性读取步长完成轻量重采样。
    const step = this.inputSampleRate / sampleRate;
    for (let index = 0; index < output.length; index += 1) {
      const sample = this.peekSample(Math.floor(this.sourcePhase));
      if (sample === null) {
        output[index] = 0;
        continue;
      }
      output[index] = sample / 32768;
      this.sourcePhase += step;
      const consumed = Math.floor(this.sourcePhase);
      if (consumed > 0) {
        this.consumeSamples(consumed);
        this.sourcePhase -= consumed;
      }
      if (!this.startedEmitted) {
        this.startedEmitted = true;
        this.port.postMessage({ type: "started" });
      }
    }

    this.emitDrainedIfNeeded();
    return true;
  }

  peekSample(relativeIndex) {
    let remaining = relativeIndex;
    let chunk = this.currentChunk;
    let offset = this.currentOffset;
    let queueIndex = 0;
    if (!chunk) {
      chunk = this.queue[0] ?? null;
      offset = 0;
      queueIndex = 1;
    }
    while (chunk) {
      const available = chunk.length - offset;
      if (remaining < available) {
        return chunk[offset + remaining];
      }
      remaining -= available;
      chunk = this.queue[queueIndex] ?? null;
      offset = 0;
      queueIndex += 1;
    }
    return null;
  }

  consumeSamples(count) {
    let remaining = count;
    while (remaining > 0) {
      if (!this.currentChunk) {
        this.currentChunk = this.queue.shift() ?? null;
        this.currentOffset = 0;
      }
      if (!this.currentChunk) {
        return;
      }
      const available = this.currentChunk.length - this.currentOffset;
      const consumed = Math.min(available, remaining);
      this.currentOffset += consumed;
      this.queuedSamples = Math.max(0, this.queuedSamples - consumed);
      remaining -= consumed;
      if (this.currentOffset >= this.currentChunk.length) {
        this.currentChunk = null;
        this.currentOffset = 0;
      }
    }
  }

  emitDrainedIfNeeded() {
    if (this.finishRequested && this.queuedSamples === 0 && !this.drainedEmitted) {
      this.drainedEmitted = true;
      this.playing = false;
      this.port.postMessage({ type: "drained" });
    }
  }
}

registerProcessor("void-pcm-playback-processor", VoidPcmPlaybackProcessor);
