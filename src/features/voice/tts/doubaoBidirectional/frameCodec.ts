/**
 * 豆包（火山引擎）双向流式 TTS 二进制帧编解码。
 *
 * 忠实移植自官方参考 `protocols_.py`（559 行）的帧协议，用浏览器原生字节操作实现，无第三方依赖。
 * 帧结构（大端序，header_size=1 时头固定 4 字节）：
 *   byte0 = (version<<4) | headerSize
 *   byte1 = (msgType<<4) | flag
 *   byte2 = (serialization<<4) | compression
 *   byte3 = padding(0)
 *   之后按 flag / msgType 依次为：event(int32) / sessionId(uint32 长度+utf8) / sequence(int32)
 *          / errorCode(uint32) / connectId(uint32 长度+utf8) / payload(uint32 长度+字节)
 *
 * 关键：flag 是互斥单值——同一帧要么带 event（WithEvent），要么带 sequence（Positive/NegativeSeq），
 * 不会两者并存，因此 writer/reader 的字段顺序差异不影响往返一致性。
 */

/** 消息类型（byte1 高 4 位） */
export enum MsgType {
  Invalid = 0,
  FullClientRequest = 0b1,
  AudioOnlyClient = 0b10,
  FullServerResponse = 0b1001,
  AudioOnlyServer = 0b1011,
  FrontEndResultServer = 0b1100,
  Error = 0b1111
}

/** 消息标志位（byte1 低 4 位） */
export enum MsgTypeFlag {
  NoSeq = 0, // 无序号非终包
  PositiveSeq = 0b1, // 带正序号非终包
  LastNoSeq = 0b10, // 无序号终包
  NegativeSeq = 0b11, // 带负序号终包
  WithEvent = 0b100 // 载荷带 event 号
}

export enum VersionBits {
  Version1 = 1
}

export enum HeaderSizeBits {
  HeaderSize4 = 1 // 头 = 4 * 1 = 4 字节
}

export enum SerializationBits {
  Raw = 0,
  JSON = 0b1,
  Thrift = 0b11,
  Custom = 0b1111
}

export enum CompressionBits {
  None = 0,
  Gzip = 0b1,
  Custom = 0b1111
}

/** 事件类型（仅收录 TTS 双向流式实际用到的上下行事件） */
export enum EventType {
  None = 0,

  // 上行连接事件
  StartConnection = 1,
  FinishConnection = 2,

  // 下行连接事件
  ConnectionStarted = 50,
  ConnectionFailed = 51,
  ConnectionFinished = 52,

  // 上行会话事件
  StartSession = 100,
  CancelSession = 101,
  FinishSession = 102,

  // 下行会话事件
  SessionStarted = 150,
  SessionCanceled = 151,
  SessionFinished = 152,
  SessionFailed = 153,
  UsageResponse = 154,

  // 上行通用事件
  TaskRequest = 200,
  UpdateConfig = 201,

  // 下行 TTS 事件
  TTSSentenceStart = 350,
  TTSSentenceEnd = 351,
  TTSResponse = 352,
  TTSEnded = 359,
  TTSSubtitle = 364
}

/** 一帧的完整字段视图 */
export interface TtsFrame {
  version: VersionBits;
  headerSize: HeaderSizeBits;
  type: MsgType;
  flag: MsgTypeFlag;
  serialization: SerializationBits;
  compression: CompressionBits;
  event: number;
  sessionId: string;
  connectId: string;
  sequence: number;
  errorCode: number;
  payload: Uint8Array;
}

/** 构造帧时的可选入参，未给字段取协议默认值 */
export type TtsFrameInput = Partial<TtsFrame> & Pick<TtsFrame, "type">;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8");

// 与 payload 结构体一致的五类「带序号/载荷」消息类型
const SEQUENCED_TYPES = new Set<MsgType>([
  MsgType.FullClientRequest,
  MsgType.FullServerResponse,
  MsgType.FrontEndResultServer,
  MsgType.AudioOnlyClient,
  MsgType.AudioOnlyServer
]);

// 这些连接级事件不携带 sessionId 字段（写入与读取都跳过）
const SESSION_ID_SKIP_EVENTS = new Set<number>([
  EventType.StartConnection,
  EventType.FinishConnection,
  EventType.ConnectionStarted,
  EventType.ConnectionFailed,
  EventType.ConnectionFinished
]);

// 仅这些事件在读取端携带 connectId 字段
const CONNECT_ID_EVENTS = new Set<number>([
  EventType.ConnectionStarted,
  EventType.ConnectionFailed,
  EventType.ConnectionFinished
]);

/** 追加写字节的增长缓冲 */
class ByteWriter {
  private readonly bytes: number[] = [];

  pushByte(value: number): void {
    this.bytes.push(value & 0xff);
  }

  pushUint32BE(value: number): void {
    const unsigned = value >>> 0;
    this.bytes.push((unsigned >>> 24) & 0xff, (unsigned >>> 16) & 0xff, (unsigned >>> 8) & 0xff, unsigned & 0xff);
  }

  // int32 与 uint32 的字节形态一致（二补码），负序号靠 >>> 0 归一化
  pushInt32BE(value: number): void {
    this.pushUint32BE(value >>> 0);
  }

  pushBytes(data: Uint8Array): void {
    for (const byte of data) {
      this.bytes.push(byte);
    }
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

/** 顺序读字节的游标读取器 */
class ByteReader {
  private offset = 0;

  constructor(private readonly view: DataView) {}

  seek(absoluteOffset: number): void {
    this.offset = absoluteOffset;
  }

  get remaining(): number {
    return this.view.byteLength - this.offset;
  }

  readUint8(): number {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  readUint32BE(): number {
    const value = this.view.getUint32(this.offset, false);
    this.offset += 4;
    return value;
  }

  readInt32BE(): number {
    const value = this.view.getInt32(this.offset, false);
    this.offset += 4;
    return value;
  }

  readBytes(length: number): Uint8Array {
    const start = this.view.byteOffset + this.offset;
    const slice = new Uint8Array(this.view.buffer.slice(start, start + length));
    this.offset += length;
    return slice;
  }
}

function withDefaults(input: TtsFrameInput): TtsFrame {
  return {
    version: input.version ?? VersionBits.Version1,
    headerSize: input.headerSize ?? HeaderSizeBits.HeaderSize4,
    type: input.type,
    flag: input.flag ?? MsgTypeFlag.NoSeq,
    serialization: input.serialization ?? SerializationBits.JSON,
    compression: input.compression ?? CompressionBits.None,
    event: input.event ?? EventType.None,
    sessionId: input.sessionId ?? "",
    connectId: input.connectId ?? "",
    sequence: input.sequence ?? 0,
    errorCode: input.errorCode ?? 0,
    payload: input.payload ?? new Uint8Array(0)
  };
}

/**
 * 将帧字段序列化为二进制。字段顺序严格对齐 protocols_.py 的 `_get_writers`：
 * WithEvent → [event, sessionId]；序号帧 → [sequence]；错误帧 → [errorCode]；最后统一 [payload]。
 */
export function encodeFrame(input: TtsFrameInput): Uint8Array {
  const frame = withDefaults(input);
  const writer = new ByteWriter();

  // 头三字节 + padding 补齐到 4*headerSize
  writer.pushByte((frame.version << 4) | frame.headerSize);
  writer.pushByte((frame.type << 4) | frame.flag);
  writer.pushByte((frame.serialization << 4) | frame.compression);
  const headerBytes = 4 * frame.headerSize;
  for (let padding = headerBytes - 3; padding > 0; padding -= 1) {
    writer.pushByte(0);
  }

  if (frame.flag === MsgTypeFlag.WithEvent) {
    writer.pushInt32BE(frame.event);
    if (!SESSION_ID_SKIP_EVENTS.has(frame.event)) {
      const sessionIdBytes = textEncoder.encode(frame.sessionId);
      writer.pushUint32BE(sessionIdBytes.length);
      writer.pushBytes(sessionIdBytes);
    }
  }

  if (SEQUENCED_TYPES.has(frame.type)) {
    if (frame.flag === MsgTypeFlag.PositiveSeq || frame.flag === MsgTypeFlag.NegativeSeq) {
      writer.pushInt32BE(frame.sequence);
    }
  } else if (frame.type === MsgType.Error) {
    writer.pushUint32BE(frame.errorCode);
  } else {
    throw new Error(`不支持的消息类型：${frame.type}`);
  }

  writer.pushUint32BE(frame.payload.length);
  writer.pushBytes(frame.payload);

  return writer.toUint8Array();
}

/**
 * 从二进制解析帧。字段顺序严格对齐 protocols_.py 的 `_get_readers`：
 * 序号帧 → [sequence]；WithEvent → [event, sessionId, connectId]；最后统一 [payload]。
 */
export function decodeFrame(data: Uint8Array): TtsFrame {
  if (data.length < 3) {
    throw new Error(`帧过短：至少需 3 字节，实际 ${data.length}`);
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const reader = new ByteReader(view);

  const versionAndHeaderSize = reader.readUint8();
  const version = (versionAndHeaderSize >> 4) as VersionBits;
  const headerSize = (versionAndHeaderSize & 0x0f) as HeaderSizeBits;

  const typeAndFlag = reader.readUint8();
  const type = (typeAndFlag >> 4) as MsgType;
  const flag = (typeAndFlag & 0x0f) as MsgTypeFlag;

  const serializationAndCompression = reader.readUint8();
  const serialization = (serializationAndCompression >> 4) as SerializationBits;
  const compression = (serializationAndCompression & 0x0f) as CompressionBits;

  // 跳过头 padding，从 4*headerSize 处开始读正文
  reader.seek(4 * headerSize);

  const frame: TtsFrame = {
    version,
    headerSize,
    type,
    flag,
    serialization,
    compression,
    event: EventType.None,
    sessionId: "",
    connectId: "",
    sequence: 0,
    errorCode: 0,
    payload: new Uint8Array(0)
  };

  if (SEQUENCED_TYPES.has(type)) {
    if (flag === MsgTypeFlag.PositiveSeq || flag === MsgTypeFlag.NegativeSeq) {
      frame.sequence = reader.readInt32BE();
    }
  } else if (type === MsgType.Error) {
    frame.errorCode = reader.readUint32BE();
  } else {
    throw new Error(`不支持的消息类型：${type}`);
  }

  if (flag === MsgTypeFlag.WithEvent) {
    frame.event = reader.readInt32BE();

    if (!SESSION_ID_SKIP_EVENTS.has(frame.event)) {
      const sessionIdSize = reader.readUint32BE();
      if (sessionIdSize > 0) {
        frame.sessionId = textDecoder.decode(reader.readBytes(sessionIdSize));
      }
    }

    if (CONNECT_ID_EVENTS.has(frame.event)) {
      const connectIdSize = reader.readUint32BE();
      if (connectIdSize > 0) {
        frame.connectId = textDecoder.decode(reader.readBytes(connectIdSize));
      }
    }
  }

  const payloadSize = reader.readUint32BE();
  if (payloadSize > 0) {
    frame.payload = reader.readBytes(payloadSize);
  }

  return frame;
}

/** 便捷：把 JSON 对象编码为 UTF-8 载荷 */
export function encodeJsonPayload(value: unknown): Uint8Array {
  return textEncoder.encode(JSON.stringify(value));
}

/** 便捷：把载荷按 UTF-8 解析为 JSON（失败返回 null） */
export function decodeJsonPayload(payload: Uint8Array): unknown {
  if (payload.length === 0) {
    return null;
  }
  try {
    return JSON.parse(textDecoder.decode(payload));
  } catch {
    return null;
  }
}
