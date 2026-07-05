export type VoiceSttPartialResult = {
  text: string;
  isInterim: boolean;
};

export type VoiceSttStartOptions = {
  onPartialResult: (result: VoiceSttPartialResult) => void;
  onFinalResult: (text: string) => void;
  onError: (error: Error) => void;
};

export interface VoiceSttProvider {
  start(options: VoiceSttStartOptions): Promise<void>;
  stop(): Promise<void>;
}
