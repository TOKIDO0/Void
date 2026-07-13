type VoicePlaybackLifecycle = {
  onStart?: () => void;
  onEnd?: () => void;
  onError?: () => void;
};

export class VoicePlaybackController {
  private currentAudio: HTMLAudioElement | null = null;
  private currentAudioUrl = "";
  private queue: string[] = [];
  private lifecycle: VoicePlaybackLifecycle = {};
  private hasStartedCurrentSession = false;

  setLifecycle(lifecycle: VoicePlaybackLifecycle = {}) {
    this.lifecycle = lifecycle;
  }

  enqueue(audioSourceUrl: string) {
    this.queue.push(audioSourceUrl);
    if (!this.currentAudio) {
      this.playNext();
    }
  }

  stop() {
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
    return !this.currentAudio && this.queue.length === 0;
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
    const finalizePlayback = (callback?: () => void) => {
      if (hasFinalized) {
        return;
      }
      hasFinalized = true;

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

    audio.addEventListener("play", () => {
      if (!this.hasStartedCurrentSession) {
        this.hasStartedCurrentSession = true;
        this.lifecycle.onStart?.();
      }
    }, { once: true });

    audio.addEventListener("ended", () => {
      finalizePlayback();
    }, { once: true });

    audio.addEventListener("error", () => {
      console.warn("[VOID TTS] audio element error", audio.error);
      finalizePlayback(this.lifecycle.onError);
    }, { once: true });

    // 先挂 src 再 play；部分 WebView 对「构造时带 src + 立刻 play」更挑剔。
    audio.src = nextAudioUrl;
    void audio.play().catch((error) => {
      console.warn("[VOID TTS] audio.play() rejected", error);
      finalizePlayback(this.lifecycle.onError);
    });
  }
}
