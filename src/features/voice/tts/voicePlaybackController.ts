type VoicePlaybackLifecycle = {
  onStart?: () => void;
  onEnd?: () => void;
  onError?: () => void;
  /** 真实播放电平（RMS 归一化 0-1，约 10Hz）；Blob fallback 不产生。 */
  onLevel?: (level: number) => void;
};

type PcmStreamItem = {
  stream: ReadableStream<Uint8Array>;
  sampleRate: number;
  sessionId: string;
};

/**
 * 语音播放控制器。
 *
 * PCM 路径按「一轮 = 一个 AudioContext + 一个 AudioWorklet」处理：
 * - 同一轮的多个句子/短块按入队顺序写入同一个 worklet 队列，避免每句新建
 *   AudioContext 造成重叠、爆音和句间空洞；
 * - worklet 自带 200ms 启动缓冲，首块到齐即开口；
 * - 句子流仍在后台读取，读取顺序与播放顺序一致。
 */
/** 平滑优先时先攒几个合成块再开口。2 块约等于 3–4 秒音频缓冲。 */
const SMOOTH_START_STREAMS = 2;

export class VoicePlaybackController {
  private currentAudio: HTMLAudioElement | null = null;
  private currentAudioUrl = "";
  private queue: string[] = [];
  private lifecycle: VoicePlaybackLifecycle = {};
  private hasStartedCurrentSession = false;

  private pcmGeneration = 0;
  private pcmReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private pcmAudioContext: AudioContext | null = null;
  private pcmWorkletNode: AudioWorkletNode | null = null;
  private pcmTurnActive = false;
  private pcmTurnEndRequested = false;
  private pcmFinishPosted = false;
  private pcmSampleRate = 24000;
  private pcmStreamQueue: PcmStreamItem[] = [];
  /** 开口前需要攒够的合成块数；1 = 首块即播，2 = 平滑优先。 */
  private pcmSmoothStartStreams = 1;
  private pcmPumpRunning = false;
  private pcmDrainedPromise: Promise<void> | null = null;
  private pcmDrainedResolver: (() => void) | null = null;

  setLifecycle(lifecycle: VoicePlaybackLifecycle = {}) {
    this.lifecycle = lifecycle;
  }

  /**
   * 平滑优先：等攒够 2 个合成块再开口，减少句间空洞。
   * 只影响本地模式；云端流式本身就是连续的，不需要这个缓冲。
   */
  setSmoothStart(enabled: boolean) {
    this.pcmSmoothStartStreams = enabled ? SMOOTH_START_STREAMS : 1;
  }

  enqueue(audioSourceUrl: string) {
    this.queue.push(audioSourceUrl);
    if (!this.currentAudio) {
      this.playNext();
    }
  }

  /** 开始一轮 PCM 播放；同一轮内后续句子复用同一个 worklet。 */
  beginPcmTurn(sampleRate = 24000) {
    if (this.pcmTurnActive) {
      return;
    }
    this.pcmTurnActive = true;
    this.pcmTurnEndRequested = false;
    this.pcmFinishPosted = false;
    this.pcmSampleRate = sampleRate;
    this.pcmStreamQueue = [];
    this.pcmPumpRunning = false;
  }

  enqueuePcmStream(stream: ReadableStream<Uint8Array>, sampleRate: number, sessionId: string) {
    if (this.pcmTurnActive && this.pcmSampleRate !== sampleRate) {
      // 引擎/sample rate 切换：结束旧轮，避免 worklet 以错误采样率播放。
      this.stop();
    }
    if (!this.pcmTurnActive) {
      this.beginPcmTurn(sampleRate);
    }
    this.pcmStreamQueue.push({ stream, sampleRate, sessionId });
    // 平滑优先：不足 2 块时先不读，等下一块到齐再一起送 worklet。
    if (this.pcmStreamQueue.length >= this.pcmSmoothStartStreams) {
      void this.pumpPcmQueue();
    }
  }

  /** 本轮所有句子都已入队；等队列读完后给 worklet 发 finish。 */
  endPcmTurn() {
    if (!this.pcmTurnActive) {
      return;
    }
    this.pcmTurnEndRequested = true;
    if (this.pcmPumpRunning) {
      return;
    }
    // 本轮只有 1 块时不能再等第 2 块，直接开播并收尾。
    if (this.pcmStreamQueue.length > 0) {
      void this.pumpPcmQueue();
      return;
    }
    void this.finishPcmTurnIfReady();
  }

  stop() {
    this.pcmGeneration += 1;
    void this.pcmReader?.cancel();
    this.pcmReader = null;
    this.pcmWorkletNode?.port.postMessage({ type: "reset" });
    this.pcmWorkletNode?.disconnect();
    this.pcmWorkletNode = null;
    const pcmAudioContext = this.pcmAudioContext;
    this.pcmAudioContext = null;
    if (pcmAudioContext && pcmAudioContext.state !== "closed") {
      void pcmAudioContext.close();
    }
    // 平滑优先会短暂扣留未读取的流；打断时必须主动 cancel，避免 HTTP body 悬挂。
    for (const item of this.pcmStreamQueue) {
      void item.stream.cancel().catch(() => undefined);
    }
    this.pcmStreamQueue = [];
    this.pcmTurnActive = false;
    this.pcmTurnEndRequested = false;
    this.pcmFinishPosted = false;
    this.pcmPumpRunning = false;
    this.pcmDrainedPromise = null;
    this.pcmDrainedResolver = null;
    this.lifecycle.onLevel?.(0);

    for (const audioUrl of this.queue) {
      URL.revokeObjectURL(audioUrl);
    }
    this.queue = [];

    if (this.currentAudio) {
      const audio = this.currentAudio;
      const currentAudioUrl = this.currentAudioUrl;
      this.currentAudio = null;
      this.currentAudioUrl = "";
      audio.pause();
      audio.src = "";
      if (currentAudioUrl) {
        URL.revokeObjectURL(currentAudioUrl);
      }
    }

    this.hasStartedCurrentSession = false;
  }

  isIdle() {
    return (
      !this.currentAudio
      && this.queue.length === 0
      && !this.pcmAudioContext
      && !this.pcmTurnActive
      && !this.pcmPumpRunning
      && this.pcmStreamQueue.length === 0
    );
  }

  /** 懒创建本轮唯一的 AudioContext/worklet。 */
  private async ensurePcmSink(sampleRate: number): Promise<AudioWorkletNode | null> {
    if (this.pcmWorkletNode && this.pcmAudioContext && this.pcmSampleRate === sampleRate) {
      return this.pcmWorkletNode;
    }
    if (this.pcmAudioContext) {
      this.pcmWorkletNode?.disconnect();
      const old = this.pcmAudioContext;
      this.pcmAudioContext = null;
      this.pcmWorkletNode = null;
      if (old.state !== "closed") void old.close();
    }

    const audioContext = new AudioContext({ sampleRate });
    this.pcmAudioContext = audioContext;
    this.pcmDrainedPromise = new Promise<void>((resolve) => {
      this.pcmDrainedResolver = resolve;
    });
    try {
      await audioContext.audioWorklet.addModule(
        new URL("./voicePcmPlaybackProcessor.js", import.meta.url)
      );
      const workletNode = new AudioWorkletNode(audioContext, "void-pcm-playback-processor", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1]
      });
      this.pcmWorkletNode = workletNode;
      workletNode.connect(audioContext.destination);
      workletNode.port.postMessage({ type: "configure", sampleRate });
      workletNode.port.onmessage = (event) => {
        if (event.data?.type === "started" && !this.hasStartedCurrentSession) {
          this.hasStartedCurrentSession = true;
          this.lifecycle.onStart?.();
        }
        if (event.data?.type === "level" && typeof event.data.value === "number") {
          this.lifecycle.onLevel?.(event.data.value);
        }
        if (event.data?.type === "drained") {
          this.pcmDrainedResolver?.();
        }
      };
      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }
      return workletNode;
    } catch (error) {
      console.warn("[VOID TTS] PCM playback init failed", error);
      this.lifecycle.onError?.();
      this.stop();
      return null;
    }
  }

  /** 顺序读取本轮所有句子流，写入同一个 worklet 队列。 */
  private async pumpPcmQueue(): Promise<void> {
    if (this.pcmPumpRunning || !this.pcmTurnActive) {
      return;
    }
    this.pcmPumpRunning = true;
    const generation = this.pcmGeneration;
    try {
      while (this.pcmStreamQueue.length) {
        const item = this.pcmStreamQueue.shift();
        if (!item) break;
        const workletNode = await this.ensurePcmSink(item.sampleRate);
        if (!workletNode || generation !== this.pcmGeneration) {
          return;
        }

        const reader = item.stream.getReader();
        this.pcmReader = reader;
        let pendingLowByte: number | null = null;
        for (;;) {
          const { done, value } = await reader.read();
          if (done || generation !== this.pcmGeneration) break;
          if (!value?.byteLength) continue;
          const byteLength = value.byteLength + (pendingLowByte === null ? 0 : 1);
          const completeByteLength = byteLength - (byteLength % Int16Array.BYTES_PER_ELEMENT);
          const pcmBytes = new Uint8Array(completeByteLength);
          let sourceOffset = 0;
          if (pendingLowByte !== null) {
            pcmBytes[0] = pendingLowByte;
            sourceOffset = 1;
            pendingLowByte = null;
          }
          pcmBytes.set(value.subarray(0, completeByteLength - sourceOffset), sourceOffset);
          if (completeByteLength < byteLength) {
            pendingLowByte = value[value.byteLength - 1];
          }
          if (pcmBytes.byteLength) {
            workletNode.port.postMessage({ type: "audio", samples: pcmBytes.buffer }, [pcmBytes.buffer]);
          }
        }
        this.pcmReader = null;
        if (generation !== this.pcmGeneration) {
          return;
        }
      }
    } catch (error) {
      if (generation === this.pcmGeneration) {
        console.warn("[VOID TTS] PCM stream failed", error);
        this.lifecycle.onError?.();
        this.stop();
      }
      return;
    } finally {
      this.pcmPumpRunning = false;
      if (generation === this.pcmGeneration) {
        if (this.pcmTurnEndRequested && this.pcmStreamQueue.length === 0) {
          void this.finishPcmTurnIfReady();
        } else if (this.pcmStreamQueue.length > 0) {
          void this.pumpPcmQueue();
        }
      }
    }
  }

  private async finishPcmTurnIfReady(): Promise<void> {
    if (!this.pcmTurnActive || !this.pcmTurnEndRequested || this.pcmPumpRunning || this.pcmFinishPosted) {
      return;
    }
    this.pcmFinishPosted = true;
    const workletNode = this.pcmWorkletNode;
    const drained = this.pcmDrainedPromise;
    if (!workletNode || !drained) {
      this.resetPcmTurn();
      this.lifecycle.onEnd?.();
      return;
    }
    workletNode.port.postMessage({ type: "finish" });
    await drained;
    this.resetPcmTurn();
    this.lifecycle.onEnd?.();
  }

  private resetPcmTurn() {
    this.pcmWorkletNode?.disconnect();
    this.pcmWorkletNode = null;
    const audioContext = this.pcmAudioContext;
    this.pcmAudioContext = null;
    if (audioContext && audioContext.state !== "closed") {
      void audioContext.close();
    }
    this.pcmStreamQueue = [];
    this.pcmTurnActive = false;
    this.pcmTurnEndRequested = false;
    this.pcmFinishPosted = false;
    this.pcmPumpRunning = false;
    this.pcmDrainedPromise = null;
    this.pcmDrainedResolver = null;
    this.hasStartedCurrentSession = false;
  }

  private playNext() {
    const nextAudioUrl = this.queue.shift();
    if (!nextAudioUrl) {
      this.currentAudio = null;
      this.currentAudioUrl = "";
      this.hasStartedCurrentSession = false;
      this.lifecycle.onEnd?.();
      return;
    }

    const audio = new Audio();
    audio.preload = "auto";
    this.currentAudio = audio;
    this.currentAudioUrl = nextAudioUrl;

    let hasFinalized = false;
    const playbackController = this;
    function handlePlay() {
      if (!playbackController.hasStartedCurrentSession) {
        playbackController.hasStartedCurrentSession = true;
        playbackController.lifecycle.onStart?.();
      }
    }
    function handleEnded() {
      finalizePlayback();
    }
    function handleError() {
      console.warn("[VOID TTS] audio element error", audio.error);
      finalizePlayback(playbackController.lifecycle.onError);
    }

    const finalizePlayback = (callback?: () => void) => {
      if (hasFinalized) {
        return;
      }
      hasFinalized = true;

      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("error", handleError);

      if (this.currentAudio === audio) {
        this.currentAudio = null;
        this.currentAudioUrl = "";
      }

      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(nextAudioUrl);
      callback?.();
      this.playNext();
    };

    audio.addEventListener("play", handlePlay, { once: true });
    audio.addEventListener("ended", handleEnded, { once: true });
    audio.addEventListener("error", handleError, { once: true });

    audio.src = nextAudioUrl;
    void audio.play().catch((error) => {
      console.warn("[VOID TTS] audio.play() rejected", error);
      finalizePlayback(this.lifecycle.onError);
    });
  }
}
