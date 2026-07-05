import type { VoiceSttProvider } from "./stt/voiceSttContract";

type VoiceSessionControllerOptions = {
  sttProvider: VoiceSttProvider;
  onInterimTranscript: (text: string) => void;
  onFinalTranscript: (text: string) => void;
  onError: (error: Error) => void;
};

export class VoiceSessionController {
  private readonly sttProvider: VoiceSttProvider;
  private readonly onInterimTranscript: (text: string) => void;
  private readonly onFinalTranscript: (text: string) => void;
  private readonly onError: (error: Error) => void;

  constructor(options: VoiceSessionControllerOptions) {
    this.sttProvider = options.sttProvider;
    this.onInterimTranscript = options.onInterimTranscript;
    this.onFinalTranscript = options.onFinalTranscript;
    this.onError = options.onError;
  }

  async start() {
    await this.sttProvider.start({
      onPartialResult: (result) => {
        this.onInterimTranscript(result.text);
        if (!result.isInterim && result.text.trim()) {
          this.onFinalTranscript(result.text.trim());
        }
      },
      onFinalResult: (text) => {
        if (text.trim()) {
          this.onFinalTranscript(text.trim());
        }
      },
      onError: this.onError
    });
  }

  async stop() {
    await this.sttProvider.stop();
  }
}
