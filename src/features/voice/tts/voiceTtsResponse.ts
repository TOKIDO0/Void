import { createHttpStatusError, createNetworkError } from "../../../lib/model-providers/providerErrors";

type JsonRecord = Record<string, unknown>;

type ParseVoiceResponseOptions = {
  providerLabel: string;
  providerKind: "doubao" | "minimax" | "fishaudio";
  endpointUrl: string;
};

export async function parseVoiceSynthesisResponse(
  response: Response,
  options: ParseVoiceResponseOptions
) {
  if (!response.ok) {
    const serviceMessage = await safeReadServiceMessage(response);
    throw createHttpStatusError(
      response.status,
      prependProviderLabel(options.providerLabel, serviceMessage),
      options.endpointUrl
    );
  }

  throw createNetworkError(
    `${options.providerLabel} 返回了无法直接解析的响应，请交由对应 provider 按协议解析。`,
    options.endpointUrl
  );
}

async function safeReadServiceMessage(response: Response) {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    try {
      const payload = await response.json() as JsonRecord;
      return extractErrorMessage(payload) || JSON.stringify(payload);
    } catch {
      return "";
    }
  }

  try {
    return await response.text();
  } catch {
    return "";
  }
}

export function assertSuccessfulBaseResponse(payload: JsonRecord, options: ParseVoiceResponseOptions) {
  const baseResp = asRecord(payload.base_resp);
  const header = asRecord(payload.header);
  const statusCode = typeof payload.code === "number"
    ? payload.code
    : typeof baseResp?.status_code === "number"
      ? baseResp.status_code
      : typeof header?.code === "number"
        ? header.code
        : null;

  if (statusCode === null || statusCode === 0 || statusCode === 20000000) {
    return;
  }

  const statusMessage = typeof payload.message === "string"
    ? payload.message
    : typeof baseResp?.status_msg === "string"
      ? baseResp.status_msg
      : typeof header?.message === "string"
        ? header.message
        : "";

  throw createNetworkError(
    prependProviderLabel(options.providerLabel, statusMessage || `status_code=${statusCode}`),
    options.endpointUrl,
    payload
  );
}

export function resolveAudioMimeType(payload: JsonRecord, fallbackContentType: string) {
  const data = asRecord(payload.data);
  const extraInfo = asRecord(payload.extra_info);
  const formatCandidates = [
    payload.audio_format,
    payload.format,
    data?.audio_format,
    data?.format,
    extraInfo?.audio_format,
    asRecord(payload.audio_setting)?.format
  ];

  for (const candidate of formatCandidates) {
    if (typeof candidate !== "string") {
      continue;
    }

    const normalizedFormat = candidate.toLowerCase();
    if (normalizedFormat === "mp3" || normalizedFormat === "mpeg" || normalizedFormat === "audio/mpeg") {
      return "audio/mpeg";
    }
    if (normalizedFormat === "wav" || normalizedFormat === "audio/wav") {
      return "audio/wav";
    }
    if (normalizedFormat === "pcm" || normalizedFormat === "audio/pcm") {
      return "audio/pcm";
    }
    if (normalizedFormat === "flac" || normalizedFormat === "audio/flac") {
      return "audio/flac";
    }
    if (normalizedFormat === "opus" || normalizedFormat === "audio/ogg") {
      return "audio/ogg";
    }
  }

  if (fallbackContentType.startsWith("audio/")) {
    return fallbackContentType;
  }

  return "audio/mpeg";
}

export function decodeHexAudio(hexAudio: string, mimeType: string) {
  const normalizedHex = hexAudio.replace(/\s/g, "").toLowerCase();
  const bytes = new Uint8Array(normalizedHex.length / 2);
  for (let index = 0; index < normalizedHex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalizedHex.slice(index, index + 2), 16);
  }

  return new Blob([bytes], { type: mimeType });
}

export function decodeBase64Audio(base64Audio: string, mimeType: string) {
  const normalizedBase64 = stripDataUrlPrefix(base64Audio).replace(/\s/g, "");
  const binaryString = window.atob(normalizedBase64);
  const audioBytes = new Uint8Array(binaryString.length);
  for (let index = 0; index < binaryString.length; index += 1) {
    audioBytes[index] = binaryString.charCodeAt(index);
  }

  return new Blob([audioBytes], { type: mimeType });
}

function extractErrorMessage(payload: JsonRecord) {
  const baseResp = asRecord(payload.base_resp);
  const data = asRecord(payload.data);
  const header = asRecord(payload.header);
  const errorRecord = asRecord(payload.error);
  const candidates = [
    payload.error,
    errorRecord?.message,
    errorRecord?.code,
    payload.message,
    payload.msg,
    header?.message,
    baseResp?.status_message,
    baseResp?.status_msg,
    data?.error,
    data?.message
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return "";
}

function prependProviderLabel(providerLabel: string, message: string) {
  if (!message.trim()) {
    return `${providerLabel} 请求失败。`;
  }

  return `${providerLabel} 请求失败：${message}`;
}

function stripDataUrlPrefix(value: string) {
  const separatorIndex = value.indexOf(",");
  if (value.startsWith("data:") && separatorIndex >= 0) {
    return value.slice(separatorIndex + 1);
  }

  return value;
}

function asRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as JsonRecord;
}
