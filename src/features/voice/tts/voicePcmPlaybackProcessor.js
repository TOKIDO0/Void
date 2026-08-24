const START_BUFFER_MS = 200;
// 真实播放电平上报节流间隔（秒）。AudioWorkletGlobalScope 没有 performance/performance.now，
// 用 Worklet 全局 currentTime（AudioContext 时间轴，单位秒）驱动节流。
const LEVEL_EMIT_INTERVAL_SEC = 0.1;

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
    this.levelAccumulatedSquares = 0;
    this.levelSampleCount = 0;
    this.levelLastEmitTime = 0;

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
        this.levelAccumulatedSquares = 0;
        this.levelSampleCount = 0;
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
      let outputValue = 0;
      if (sample === null) {
        output[index] = 0;
      } else {
        outputValue = sample / 32768;
        output[index] = outputValue;
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
      // 真实播放电平：对实际写入的样本累计 RMS（静音段也计入，让主体在语句间隙收缩）
      this.levelAccumulatedSquares += outputValue * outputValue;
      this.levelSampleCount += 1;
    }

    this.emitLevelIfNeeded();
    this.emitDrainedIfNeeded();
    return true;
  }

  emitLevelIfNeeded() {
    if (this.levelSampleCount === 0) {
      return;
    }
    const elapsed = currentTime - this.levelLastEmitTime;
    if (elapsed < LEVEL_EMIT_INTERVAL_SEC) {
      return;
    }
    this.levelLastEmitTime = currentTime;
    const rms = Math.sqrt(this.levelAccumulatedSquares / this.levelSampleCount);
    this.levelAccumulatedSquares = 0;
    this.levelSampleCount = 0;
    // 语音 RMS 常态远低于 1；做轻度增益并 clamp，让视觉起伏可感知且不溢出。
    const normalizedLevel = Math.min(1, rms * 4);
    this.port.postMessage({ type: "level", value: normalizedLevel });
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
