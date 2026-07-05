type VoicePlaybackLifecycle = {
  onStart?: () => void;
  onEnd?: () => void;
  onError?: () => void;
};

export class VoicePlaybackController {
  private currentAudio: HTMLAudioElement | null = null;

  stop() {
    if (!this.currentAudio) {
      return;
    }

    this.currentAudio.pause();
    this.currentAudio.src = "";
    this.currentAudio = null;
  }

  play(audioSourceUrl: string, lifecycle: VoicePlaybackLifecycle = {}) {
    this.stop();

    const audio = new Audio(audioSourceUrl);
    this.currentAudio = audio;

    const clearCurrentAudio = () => {
      if (this.currentAudio === audio) {
        this.currentAudio = null;
      }
    };

    audio.addEventListener("play", () => {
      lifecycle.onStart?.();
    }, { once: true });

    audio.addEventListener("ended", () => {
      clearCurrentAudio();
      lifecycle.onEnd?.();
    }, { once: true });

    audio.addEventListener("error", () => {
      clearCurrentAudio();
      lifecycle.onError?.();
    }, { once: true });

    void audio.play().catch(() => {
      clearCurrentAudio();
      lifecycle.onError?.();
    });
  }
}
