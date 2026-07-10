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
      // 实时预览：仅更新界面识别文字，绝不在此触发发送。
      // 定稿（发送给模型）统一走唯一的 onFinalResult 通道，避免出现第二条 final 触发源导致双发。
      onPartialResult: (result) => {
        this.onInterimTranscript(result.text);
      },
      // 唯一的定稿发送通道：由桥接的整段停顿/关麦末包判定驱动。
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
