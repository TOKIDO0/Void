type VoicePlaybackLifecycle = {
  onStart?: () => void;
  onEnd?: () => void;
  onError?: () => void;
  /** 阶段 2 挂账项：PCM 主路径的真实播放电平（RMS 归一化 0-1，约 10Hz）；Blob fallback 不产生该信号。 */
  onLevel?: (level: number) => void;
};

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

  setLifecycle(lifecycle: VoicePlaybackLifecycle = {}) {
    this.lifecycle = lifecycle;
  }

  enqueue(audioSourceUrl: string) {
    this.queue.push(audioSourceUrl);
    if (!this.currentAudio) {
      this.playNext();
    }
  }

  enqueuePcmStream(stream: ReadableStream<Uint8Array>, sampleRate: number, sessionId: string) {
    const generation = this.pcmGeneration + 1;
    this.pcmGeneration = generation;
    void this.playPcmStream(stream, sampleRate, sessionId, generation);
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
    // 打断/停止时同步归零播放电平
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
    return !this.currentAudio && this.queue.length === 0 && !this.pcmAudioContext;
  }

  private async playPcmStream(
    stream: ReadableStream<Uint8Array>,
    sampleRate: number,
    sessionId: string,
    generation: number
  ) {
    const startedAt = performance.now();
    const audioContext = new AudioContext({ sampleRate });
    this.pcmAudioContext = audioContext;
    try {
      await audioContext.audioWorklet.addModule(
        new URL("./voicePcmPlaybackProcessor.js", import.meta.url)
      );
      if (generation !== this.pcmGeneration) {
        await audioContext.close();
        return;
      }
      const workletNode = new AudioWorkletNode(audioContext, "void-pcm-playback-processor", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1]
      });
      this.pcmWorkletNode = workletNode;
      workletNode.connect(audioContext.destination);
      workletNode.port.postMessage({ type: "configure", sampleRate });
      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }

      const drained = new Promise<void>((resolve) => {
        workletNode.port.onmessage = (event) => {
          if (event.data?.type === "started" && !this.hasStartedCurrentSession) {
            this.hasStartedCurrentSession = true;
            this.lifecycle.onStart?.();
            if (import.meta.env.DEV) {
              console.info("[VOID TTS latency] playback_started", {
                sessionId,
                elapsedMs: Math.round(performance.now() - startedAt)
              });
            }
          }
          if (event.data?.type === "level" && typeof event.data.value === "number") {
            this.lifecycle.onLevel?.(event.data.value);
          }
          if (event.data?.type === "drained") resolve();
        };
      });

      const reader = stream.getReader();
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
      if (generation !== this.pcmGeneration) return;
      workletNode.port.postMessage({ type: "finish" });
      await drained;
      if (generation !== this.pcmGeneration) return;
      this.finishPcmPlayback(audioContext, workletNode, true);
    } catch (error) {
      if (generation !== this.pcmGeneration) return;
      console.warn("[VOID TTS] PCM playback failed", error);
      this.finishPcmPlayback(audioContext, this.pcmWorkletNode, false);
    }
  }

  private finishPcmPlayback(
    audioContext: AudioContext,
    workletNode: AudioWorkletNode | null,
    succeeded: boolean
  ) {
    workletNode?.disconnect();
    if (this.pcmWorkletNode === workletNode) this.pcmWorkletNode = null;
    this.pcmReader = null;
    if (this.pcmAudioContext === audioContext) this.pcmAudioContext = null;
    if (audioContext.state !== "closed") void audioContext.close();
    this.hasStartedCurrentSession = false;
    // 播放结束立即归零电平，避免视觉残留到状态机切回 idle
    this.lifecycle.onLevel?.(0);
    if (succeeded) this.lifecycle.onEnd?.();
    else this.lifecycle.onError?.();
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

    // 幂等保护：同一段音频可能同时触发多个终止信号（ended / error 事件 + play() reject）。
    // 若不加锁，finalizePlayback 会被重复调用，导致 playNext 重复推进、同时启动多段音频，
    // 进而级联裂变成“多条语音同时播放”。此处保证每段音频只结算一次。
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

      // 清理 src 会触发 WebView 的 MediaError；先解绑监听，避免把正常收尾误报为空地址错误。
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

    // 先挂 src 再 play；部分 WebView 对「构造时带 src + 立刻 play」更挑剔。
    audio.src = nextAudioUrl;
    void audio.play().catch((error) => {
      console.warn("[VOID TTS] audio.play() rejected", error);
      finalizePlayback(this.lifecycle.onError);
    });
  }
}
