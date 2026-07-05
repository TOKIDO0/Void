/**
 * 豆包大模型流式语音识别（SAUC bigmodel）WebSocket 二进制协议编解码。
 *
 * 依据火山引擎官方《大模型流式语音识别 API》协议详情实现，非猜测：
 * - 帧结构：4 字节 header + [可选 sequence] + payload size(大端 uint32) + payload
 * - header：byte0=版本(4)+header大小(4)；byte1=消息类型(4)+标志(4)；byte2=序列化(4)+压缩(4)；byte3=保留
 * - 整数字段一律大端；payload 依压缩位决定是否 gzip
 *
 * 本模块只做纯字节编解码，不涉及网络，便于单点维护与将来复用。
 */
import { gzipSync, gunzipSync } from "node:zlib";

// header byte0：协议版本 0b0001 + header 大小 0b0001（1×4=4 字节）
const HEADER_BYTE0 = 0x11;
// header byte3：保留位
const HEADER_RESERVED = 0x00;

// 消息类型（header byte1 高 4 位）
const MESSAGE_TYPE_FULL_CLIENT_REQUEST = 0b0001;
const MESSAGE_TYPE_AUDIO_ONLY_REQUEST = 0b0010;
const MESSAGE_TYPE_FULL_SERVER_RESPONSE = 0b1001;
const MESSAGE_TYPE_ERROR_RESPONSE = 0b1111;

// 消息类型补充标志（header byte1 低 4 位）
const FLAG_NO_SEQUENCE = 0b0000;
const FLAG_LAST_PACKET_NO_SEQUENCE = 0b0010;
const FLAG_POSITIVE_SEQUENCE = 0b0001;

// 序列化方法（header byte2 高 4 位）
const SERIALIZATION_NONE = 0b0000;
const SERIALIZATION_JSON = 0b0001;

// 压缩方法（header byte2 低 4 位）
const COMPRESSION_NONE = 0b0000;
const COMPRESSION_GZIP = 0b0001;

/** 服务端识别成功错误码 */
export const SAUC_SUCCESS_CODE = 20000000;

export type SaucServerFrame =
  | {
      kind: "response";
      /** payload 中是否携带最后一包标志（definite 结束由业务另判） */
      isLastPacket: boolean;
      payload: Record<string, unknown>;
    }
  | {
      kind: "error";
      code: number;
      message: string;
    };

/**
 * 组装 full client request 首帧：携带识别配置参数 JSON。
 * 依官方示例：消息类型 0b0001、无 sequence、JSON 序列化、Gzip 压缩。
 */
export function encodeFullClientRequest(config: Record<string, unknown>): Buffer {
  const header = Buffer.from([
    HEADER_BYTE0,
    (MESSAGE_TYPE_FULL_CLIENT_REQUEST << 4) | FLAG_NO_SEQUENCE,
    (SERIALIZATION_JSON << 4) | COMPRESSION_GZIP,
    HEADER_RESERVED
  ]);

  const compressedPayload = gzipSync(Buffer.from(JSON.stringify(config), "utf-8"));
  return concatWithPayloadSize(header, compressedPayload);
}

/**
 * 组装 audio only request 帧：携带一包音频。
 * 依官方示例：消息类型 0b0010、无序列化(raw)、Gzip 压缩；末包用“最后一包”标志。
 * @param isLastPacket 是否为最后一包（负包），末包音频可为空
 */
export function encodeAudioRequest(pcmAudio: Buffer, isLastPacket: boolean): Buffer {
  const flags = isLastPacket ? FLAG_LAST_PACKET_NO_SEQUENCE : FLAG_NO_SEQUENCE;
  const header = Buffer.from([
    HEADER_BYTE0,
    (MESSAGE_TYPE_AUDIO_ONLY_REQUEST << 4) | flags,
    (SERIALIZATION_NONE << 4) | COMPRESSION_GZIP,
    HEADER_RESERVED
  ]);

  const compressedPayload = gzipSync(pcmAudio);
  return concatWithPayloadSize(header, compressedPayload);
}

/**
 * 解析服务端下发帧：full server response（含识别结果）或 error response。
 * 返回 null 表示非本协议可识别帧（忽略即可）。
 */
export function decodeServerFrame(frame: Buffer): SaucServerFrame | null {
  if (frame.length < 4) {
    return null;
  }

  const headerSize = (frame[0] & 0x0f) * 4;
  const messageType = (frame[1] >> 4) & 0x0f;
  const flags = frame[1] & 0x0f;
  const compression = frame[2] & 0x0f;

  let offset = headerSize;

  if (messageType === MESSAGE_TYPE_ERROR_RESPONSE) {
    // 错误帧：header + 错误码(4B) + 错误信息长度(4B) + 错误信息(UTF8)
    const errorCode = frame.readUInt32BE(offset);
    offset += 4;
    const errorMessageSize = frame.readUInt32BE(offset);
    offset += 4;
    const message = frame.subarray(offset, offset + errorMessageSize).toString("utf-8");
    return { kind: "error", code: errorCode, message };
  }

  if (messageType !== MESSAGE_TYPE_FULL_SERVER_RESPONSE) {
    return null;
  }

  // full server response：flags 低位为 1 时，header 后 4 字节为 sequence，需跳过
  const hasSequence = (flags & FLAG_POSITIVE_SEQUENCE) === FLAG_POSITIVE_SEQUENCE;
  if (hasSequence) {
    offset += 4;
  }

  const payloadSize = frame.readUInt32BE(offset);
  offset += 4;
  const rawPayload = frame.subarray(offset, offset + payloadSize);
  const payloadBuffer = compression === COMPRESSION_GZIP ? gunzipSync(rawPayload) : rawPayload;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadBuffer.toString("utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }

  // flags 含“最后一包”位（0b0010）表示这是末包音频对应的最终结果
  const isLastPacket = (flags & FLAG_LAST_PACKET_NO_SEQUENCE) === FLAG_LAST_PACKET_NO_SEQUENCE;
  return { kind: "response", isLastPacket, payload };
}

/** 拼接 header + payload size(大端 uint32) + payload */
function concatWithPayloadSize(header: Buffer, payload: Buffer): Buffer {
  const payloadSize = Buffer.alloc(4);
  payloadSize.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payloadSize, payload]);
}
