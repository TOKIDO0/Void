import type { VoiceSttProvider } from "./stt/voiceSttContract";
import { VoiceTurnAssembler } from "./stt/voiceTurnAssembler";

type VoiceSessionControllerOptions = {
  sttProvider: VoiceSttProvider;
  onInterimTranscript: (text: string) => void;
  onFinalTranscript: (text: string) => void;
  onError: (error: Error) => void;
};

/**
 * 语音会话控制器。
 *
 * 识别供应商只负责 partial/final 事件；
 * 「何时把一句话说完并交给 AI」由 VoiceTurnAssembler 统一出口，
 * 避免 partial 误发、相邻 final 双发。
 */
export class VoiceSessionController {
  private readonly sttProvider: VoiceSttProvider;
  private readonly onError: (error: Error) => void;
  private readonly turnAssembler: VoiceTurnAssembler;

  constructor(options: VoiceSessionControllerOptions) {
    this.sttProvider = options.sttProvider;
    this.onError = options.onError;
    this.turnAssembler = new VoiceTurnAssembler({
      onPreview: options.onInterimTranscript,
      onCommit: options.onFinalTranscript
    });
  }

  async start() {
    try {
      await this.sttProvider.start({
        // 实时预览：只更新界面，绝不在此触发发送。
        onPartialResult: (result) => {
          this.turnAssembler.handlePartial(result.text);
        },
        // Worker 已完成 1.5s 静音判停后的 final；组装器再做短窗合并后唯一提交。
        onFinalResult: (text) => {
          this.turnAssembler.handleFinal(text);
        },
        onError: this.onError
      });
    } catch (error) {
      // 握手/麦克风等启动失败必须可见，禁止 void start() 后静默。
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async stop() {
    // 先停上游采集，再 flush 当前草稿，保证关麦也能提交已说完的内容。
    await this.sttProvider.stop();
    this.turnAssembler.flush();
    this.turnAssembler.dispose();
  }
}
