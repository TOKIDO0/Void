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

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.startsWith("audio/")) {
    const audioBlob = await response.blob();
    return {
      audioUrl: URL.createObjectURL(audioBlob),
      mimeType: audioBlob.type || contentType,
      provider: options.providerKind
    };
  }

  const payload = await safeReadJson(response, options);
  assertSuccessfulBaseResponse(payload, options);

  const audioUrl = extractAudioUrl(payload);
  if (audioUrl) {
    return {
      audioUrl,
      provider: options.providerKind
    };
  }

  const hexAudio = extractHexAudio(payload);
  if (hexAudio) {
    const mimeType = resolveAudioMimeType(payload, contentType);
    const audioBlob = decodeHexAudio(hexAudio, mimeType);
    return {
      audioUrl: URL.createObjectURL(audioBlob),
      mimeType,
      provider: options.providerKind
    };
  }

  const base64Audio = extractBase64Audio(payload);
  if (base64Audio) {
    const mimeType = resolveAudioMimeType(payload, contentType);
    const audioBlob = decodeBase64Audio(base64Audio, mimeType);
    return {
      audioUrl: URL.createObjectURL(audioBlob),
      mimeType,
      provider: options.providerKind
    };
  }

  throw createNetworkError(
    `${options.providerLabel} 返回了非音频响应，且未找到可用的音频字段。响应摘要：${summarizePayload(payload)}`,
    options.endpointUrl,
    payload
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

async function safeReadJson(response: Response, options: ParseVoiceResponseOptions) {
  const responseBuffer = await response.arrayBuffer();
  const responseText = decodeResponseText(responseBuffer);

  const jsonPayload = tryParseJsonPayload(responseText);
  if (jsonPayload) {
    return jsonPayload;
  }

  const embeddedBase64Audio = extractEmbeddedBase64Audio(responseText);
  if (embeddedBase64Audio) {
    return {
      code: 0,
      message: "",
      data: embeddedBase64Audio,
      audio_format: inferAudioFormatFromBase64(embeddedBase64Audio)
    } as JsonRecord;
  }

  const binaryAudioBlob = tryCreateBinaryAudioBlob(
    responseBuffer,
    response.headers.get("content-type"),
    options.providerKind
  );

  if (binaryAudioBlob) {
    return {
      data: await blobToBase64(binaryAudioBlob),
      audio_format: binaryAudioBlob.type
    } as JsonRecord;
  }

  throw createNetworkError(
    `[voice-parse-v2] ${options.providerLabel} 返回内容不是可解析的音频流，也不是合法 JSON。响应预览：${responseText.slice(0, 160)}`,
    options.endpointUrl
  );
}

function tryParseJsonPayload(responseText: string) {
  const candidateTexts = buildJsonParseCandidates(responseText);

  for (const candidateText of candidateTexts) {
    try {
      const parsed = JSON.parse(candidateText) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as JsonRecord;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function buildJsonParseCandidates(responseText: string) {
  const candidates = new Set<string>();
  const normalizedText = normalizeJsonLikeText(responseText);
  const trimmedText = responseText.trim();

  if (trimmedText) {
    candidates.add(trimmedText);
  }

  if (normalizedText && normalizedText !== trimmedText) {
    candidates.add(normalizedText);
  }

  const firstBraceIndex = normalizedText.indexOf("{");
  const lastBraceIndex = normalizedText.lastIndexOf("}");
  if (firstBraceIndex >= 0 && lastBraceIndex > firstBraceIndex) {
    candidates.add(normalizedText.slice(firstBraceIndex, lastBraceIndex + 1).trim());
  }

  return [...candidates];
}

function normalizeJsonLikeText(value: string) {
  return value
    .replace(/^\uFEFF/, "")
    .replace(/\u0000/g, "")
    .trim();
}

function extractEmbeddedBase64Audio(responseText: string) {
  const normalizedText = normalizeJsonLikeText(responseText);
  const base64Match = normalizedText.match(/"data"\s*:\s*"([A-Za-z0-9+/=]{32,})"/);
  if (base64Match?.[1]) {
    return base64Match[1];
  }

  if (normalizedText.includes("SUQz")) {
    const relaxedMatch = normalizedText.match(/([A-Za-z0-9+/=]*SUQz[A-Za-z0-9+/=]{16,})/);
    return relaxedMatch?.[1] ?? "";
  }

  return "";
}

function inferAudioFormatFromBase64(base64Audio: string) {
  const normalizedBase64 = stripDataUrlPrefix(base64Audio).replace(/\s/g, "");
  if (normalizedBase64.startsWith("SUQz")) {
    return "audio/mpeg";
  }

  return "audio/mpeg";
}

function assertSuccessfulBaseResponse(payload: JsonRecord, options: ParseVoiceResponseOptions) {
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

function extractAudioUrl(payload: JsonRecord) {
  const directCandidates = [payload.audio_url, payload.audioUrl, payload.url, payload.data];
  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && isProbablyHttpUrl(candidate)) {
      return candidate;
    }
  }

  const data = asRecord(payload.data);
  const nestedCandidates = [data?.audio_url, data?.audioUrl, data?.url, data?.link];
  for (const candidate of nestedCandidates) {
    if (typeof candidate === "string" && isProbablyHttpUrl(candidate)) {
      return candidate;
    }
  }

  return "";
}

function extractHexAudio(payload: JsonRecord) {
  const data = asRecord(payload.data);
  const candidates = [payload.audio_hex, payload.data, data?.audio_hex, data?.audio, data?.data];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && isProbablyHex(candidate)) {
      return candidate;
    }
  }

  return "";
}

function extractBase64Audio(payload: JsonRecord) {
  const directCandidates = [payload.audio, payload.audio_base64, payload.audioBase64, payload.base64, payload.data];
  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && isProbablyBase64(candidate)) {
      return candidate;
    }
  }

  const data = asRecord(payload.data);
  const nestedCandidates = [data?.audio, data?.audio_base64, data?.audioBase64, data?.base64, data?.data];
  for (const candidate of nestedCandidates) {
    if (typeof candidate === "string" && isProbablyBase64(candidate)) {
      return candidate;
    }
  }

  return "";
}

function resolveAudioMimeType(payload: JsonRecord, fallbackContentType: string) {
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

function decodeHexAudio(hexAudio: string, mimeType: string) {
  const normalizedHex = hexAudio.replace(/\s/g, "").toLowerCase();
  const bytes = new Uint8Array(normalizedHex.length / 2);
  for (let index = 0; index < normalizedHex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalizedHex.slice(index, index + 2), 16);
  }

  return new Blob([bytes], { type: mimeType });
}

function decodeBase64Audio(base64Audio: string, mimeType: string) {
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

function isProbablyHttpUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

function isProbablyHex(value: string) {
  const normalizedValue = value.replace(/\s/g, "");
  return normalizedValue.length > 32 && normalizedValue.length % 2 === 0 && /^[a-fA-F0-9]+$/.test(normalizedValue);
}

function isProbablyBase64(value: string) {
  const normalizedValue = stripDataUrlPrefix(value).replace(/\s/g, "");
  return normalizedValue.length > 32 && /^[A-Za-z0-9+/=]+$/.test(normalizedValue);
}

function tryCreateBinaryAudioBlob(
  responseBuffer: ArrayBuffer,
  contentTypeHeader: string | null,
  providerKind: ParseVoiceResponseOptions["providerKind"]
) {
  if (responseBuffer.byteLength === 0) {
    return null;
  }

  const contentType = contentTypeHeader?.toLowerCase().trim() ?? "";
  if (contentType.startsWith("audio/")) {
    return new Blob([responseBuffer], { type: contentType });
  }

  if (contentType.includes("application/octet-stream")) {
    return new Blob([responseBuffer], {
      type: inferAudioMimeTypeFromBytes(new Uint8Array(responseBuffer), providerKind)
    });
  }

  if (looksLikeBinaryAudio(new Uint8Array(responseBuffer))) {
    return new Blob([responseBuffer], {
      type: inferAudioMimeTypeFromBytes(new Uint8Array(responseBuffer), providerKind)
    });
  }

  return null;
}

function looksLikeBinaryAudio(audioBytes: Uint8Array) {
  if (audioBytes.length >= 3 && audioBytes[0] === 0x49 && audioBytes[1] === 0x44 && audioBytes[2] === 0x33) {
    return true;
  }

  if (
    audioBytes.length >= 12
    && audioBytes[0] === 0x52
    && audioBytes[1] === 0x49
    && audioBytes[2] === 0x46
    && audioBytes[3] === 0x46
    && audioBytes[8] === 0x57
    && audioBytes[9] === 0x41
    && audioBytes[10] === 0x56
    && audioBytes[11] === 0x45
  ) {
    return true;
  }

  if (audioBytes.length >= 4 && audioBytes[0] === 0x66 && audioBytes[1] === 0x4c && audioBytes[2] === 0x61 && audioBytes[3] === 0x43) {
    return true;
  }

  return false;
}

function inferAudioMimeTypeFromBytes(
  audioBytes: Uint8Array,
  _providerKind: ParseVoiceResponseOptions["providerKind"]
) {
  if (audioBytes.length >= 3 && audioBytes[0] === 0x49 && audioBytes[1] === 0x44 && audioBytes[2] === 0x33) {
    return "audio/mpeg";
  }

  if (
    audioBytes.length >= 12
    && audioBytes[0] === 0x52
    && audioBytes[1] === 0x49
    && audioBytes[2] === 0x46
    && audioBytes[3] === 0x46
    && audioBytes[8] === 0x57
    && audioBytes[9] === 0x41
    && audioBytes[10] === 0x56
    && audioBytes[11] === 0x45
  ) {
    return "audio/wav";
  }

  if (audioBytes.length >= 4 && audioBytes[0] === 0x66 && audioBytes[1] === 0x4c && audioBytes[2] === 0x61 && audioBytes[3] === 0x43) {
    return "audio/flac";
  }

  return "audio/mpeg";
}

function decodeResponseText(responseBuffer: ArrayBuffer) {
  return new TextDecoder("utf-8", { fatal: false }).decode(responseBuffer);
}

async function blobToBase64(blob: Blob) {
  const buffer = await blob.arrayBuffer();
  let binaryString = "";
  const bytes = new Uint8Array(buffer);
  for (const byte of bytes) {
    binaryString += String.fromCharCode(byte);
  }

  return window.btoa(binaryString);
}

function asRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as JsonRecord;
}

function summarizePayload(payload: JsonRecord) {
  const data = asRecord(payload.data);
  const header = asRecord(payload.header);
  const baseResp = asRecord(payload.base_resp);

  const summary = {
    topLevelKeys: Object.keys(payload).slice(0, 12),
    dataKeys: data ? Object.keys(data).slice(0, 12) : [],
    header,
    baseResp,
    dataPreview: extractPreviewFields(data)
  };

  try {
    return JSON.stringify(summary);
  } catch {
    return "[unserializable payload]";
  }
}

function extractPreviewFields(data: JsonRecord | null) {
  if (!data) {
    return null;
  }

  const preview: Record<string, unknown> = {};
  for (const key of ["audio", "data", "url", "audio_url", "audioBase64", "audio_hex", "status"]) {
    if (key in data) {
      preview[key] = typeof data[key] === "string"
        ? String(data[key]).slice(0, 80)
        : data[key];
    }
  }

  return preview;
}
