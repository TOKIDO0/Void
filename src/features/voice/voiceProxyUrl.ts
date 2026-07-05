import { createProxyUnavailableError } from "../../lib/model-providers/providerErrors";
import type { VoiceRequestMode } from "./voiceProviderConfig";

type VoiceFetchTarget = {
  url: string;
  directUrl: string;
  mode: VoiceRequestMode;
  headers: Record<string, string>;
};

const DEVELOPMENT_VOICE_PROXY_PATH = "/void-voice-proxy";
const PRODUCTION_VOICE_PROXY_PATH = "/api/voice";

export function buildVoiceFetchTarget(endpointUrl: string, requestMode: VoiceRequestMode): VoiceFetchTarget {
  if (requestMode === "production-proxy" || !import.meta.env.DEV) {
    return {
      url: PRODUCTION_VOICE_PROXY_PATH,
      directUrl: endpointUrl,
      mode: "production-proxy",
      headers: {
        "X-VOID-Target-URL": endpointUrl
      }
    };
  }

  return {
    url: DEVELOPMENT_VOICE_PROXY_PATH,
    directUrl: endpointUrl,
    mode: "development-proxy",
    headers: {
      "X-VOID-Target-URL": endpointUrl
    }
  };
}

export async function fetchVoiceWithProxy(target: VoiceFetchTarget, init: RequestInit) {
  try {
    return await fetch(target.url, {
      ...init,
      signal: init.signal,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        ...target.headers
      }
    });
  } catch (error) {
    throw createProxyUnavailableError(
      target.mode === "production-proxy"
        ? "正式语音代理不可用，请检查服务端 /api/voice 是否已部署。"
        : "开发语音代理不可用，请检查 /void-voice-proxy 是否正常运行。",
      target.directUrl,
      error
    );
  }
}
