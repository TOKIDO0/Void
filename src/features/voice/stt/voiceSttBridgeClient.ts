import { bridgeAuthHeadersForUrl } from "../../../lib/runtime/voidBridgeAuth";
import { resolveVoidBridgeOrigin } from "../../../lib/runtime/voidBridgeRuntime";

export type VoiceSttTicket = {
  ticket: string;
  expiresAt: number;
  mode: "local";
  model: string;
};

export type VoiceSttModelInfo = {
  state: "ready" | "missing" | "invalid";
  dir?: string;
  reason?: string;
  totalBytes?: number;
};

export type VoiceSttBridgeStatus = {
  engineLoaded: boolean;
  activeSessions: number;
  maxSessions: number;
  idleUnloadMs: number;
  model: VoiceSttModelInfo;
  modelDir: string;
};

/** 本机 sidecar 取一次性 WS 票据；失败时抛出带 voiceSttCode 的错误。 */
export async function fetchVoiceSttTicket(signal?: AbortSignal): Promise<VoiceSttTicket> {
  const origin = resolveVoidBridgeOrigin();
  const url = `${origin}/void-voice/stt/ticket`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { ...(await bridgeAuthHeadersForUrl(url)) },
      signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    throw withVoiceSttCode(
      new Error("本机语音服务未连接，本地识别无法启动。请确认 VOID 桌面端/本机服务在运行。"),
      "LOCAL_STT_BRIDGE_UNREACHABLE"
    );
  }

  let payload: { ok?: boolean; data?: VoiceSttTicket; error?: { code?: string; message?: string } };
  try {
    payload = await response.json() as typeof payload;
  } catch {
    throw withVoiceSttCode(new Error(`本机语音服务返回了非 JSON 响应（HTTP ${response.status}）。`), "LOCAL_STT_INVALID_RESPONSE");
  }
  if (!response.ok || !payload.ok || !payload.data?.ticket) {
    throw withVoiceSttCode(
      new Error(payload.error?.message ?? "本地语音取票失败。"),
      payload.error?.code ?? "LOCAL_STT_TICKET_INVALID"
    );
  }
  return payload.data;
}

/** 只读状态：模型是否就绪、引擎是否已加载、当前会话数。 */
export async function fetchVoiceSttStatus(signal?: AbortSignal): Promise<VoiceSttBridgeStatus> {
  const origin = resolveVoidBridgeOrigin();
  const url = `${origin}/void-voice/stt/status`;
  const response = await fetch(url, {
    method: "GET",
    headers: { ...(await bridgeAuthHeadersForUrl(url)) },
    signal
  });
  const payload = await response.json() as { ok?: boolean; data?: VoiceSttBridgeStatus; error?: { message?: string } };
  if (!response.ok || !payload.ok || !payload.data) {
    throw new Error(payload.error?.message ?? "本地语音状态读取失败。");
  }
  return payload.data;
}

export function resolveVoiceSttWsUrl(ticket: string): string {
  const origin = resolveVoidBridgeOrigin();
  const wsOrigin = origin.replace(/^http/, "ws");
  return `${wsOrigin}/void-voice/stt?ticket=${encodeURIComponent(ticket)}`;
}

function withVoiceSttCode(error: Error, code: string): Error {
  Object.assign(error, { voiceSttCode: code });
  return error;
}
