export type VoiceSttBridgeClientEvent =
  | {
      type: "start";
      appKey: string;
      accessKey: string;
      resourceId: string;
      sampleRate: number;
      format: "pcm_s16le";
    }
  | {
      type: "audio";
      audioBase64: string;
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
    }
  | {
      type: "error";
      message: string;
    };

export function isVoiceSttBridgeServerEvent(payload: unknown): payload is VoiceSttBridgeServerEvent {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }

  const event = payload as Record<string, unknown>;
  return typeof event.type === "string";
}
