export type VoiceSttBridgeClientEvent =
  | {
      type: "start";
      sampleRate: number;
      format: "pcm_s16le";
    }
  | {
      type: "audio";
      audioBase64: string;
    }
  | {
      /** 本地 VAD 已确认用户持续静音，请提交当前回合但保持麦克风会话。 */
      type: "commit";
    }
  | {
      type: "stop";
    };

export type VoiceSttBridgeServerEvent =
  | {
      type: "ready";
    }
  | {
      type: "partial";
      text: string;
      isInterim: boolean;
    }
  | {
      type: "final";
      text: string;
      /** 上游即将重建时立即提交，避免新 partial 清掉 400ms 合并窗中的旧 final。 */
      commitImmediately?: boolean;
    }
  | {
      type: "error";
      message: string;
      /** true 表示当前上游会话可安全重建，不应关闭麦克风。 */
      recoverable?: boolean;
    };

export function isVoiceSttBridgeServerEvent(payload: unknown): payload is VoiceSttBridgeServerEvent {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }

  const event = payload as Record<string, unknown>;
  return typeof event.type === "string";
}
