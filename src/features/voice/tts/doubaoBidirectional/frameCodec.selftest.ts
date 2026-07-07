/**
 * 帧编解码自证（22 号 §2 唯一豁免的断言，仅限协议底层，不接入应用运行时）。
 *
 * 两类校验：
 *   1. 固定字节校验——对手算出的已知帧字节逐字节比对，锁死字节序与字段布局。
 *   2. 往返一致——encode→decode 后所有字段与原帧相等，覆盖 event / session / sequence / error 各分支。
 *
 * 运行：`npx tsx src/features/voice/tts/doubaoBidirectional/frameCodec.selftest.ts`
 */

import {
  CompressionBits,
  EventType,
  HeaderSizeBits,
  MsgType,
  MsgTypeFlag,
  SerializationBits,
  VersionBits,
  decodeFrame,
  encodeFrame,
  type TtsFrame,
  type TtsFrameInput
} from "./frameCodec";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`自证失败：${message}`);
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ");
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }
  return true;
}

/** 校验 encode 输出与手算字节完全一致 */
function assertFixedBytes(label: string, input: TtsFrameInput, expectedHex: string): void {
  const actual = encodeFrame(input);
  const expected = Uint8Array.from(expectedHex.split(" ").map((token) => parseInt(token, 16)));
  assert(
    bytesEqual(actual, expected),
    `${label} 字节不符\n  期望: ${expectedHex}\n  实际: ${toHex(actual)}`
  );
}

/** 校验 decode(encode(frame)) 的每个字段与原帧相等 */
function assertRoundTrip(label: string, input: TtsFrameInput): void {
  const original: TtsFrame = {
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

  const decoded = decodeFrame(encodeFrame(input));

  assert(decoded.type === original.type, `${label} type`);
  assert(decoded.flag === original.flag, `${label} flag`);
  assert(decoded.serialization === original.serialization, `${label} serialization`);
  assert(decoded.compression === original.compression, `${label} compression`);
  assert(decoded.event === original.event, `${label} event`);
  assert(decoded.sessionId === original.sessionId, `${label} sessionId(${decoded.sessionId} vs ${original.sessionId})`);
  assert(decoded.connectId === original.connectId, `${label} connectId`);
  assert(decoded.sequence === original.sequence, `${label} sequence(${decoded.sequence} vs ${original.sequence})`);
  assert(decoded.errorCode === original.errorCode, `${label} errorCode`);
  assert(bytesEqual(decoded.payload, original.payload), `${label} payload`);
}

const utf8 = new TextEncoder();

export function runFrameCodecSelfTest(): void {
  // —— 固定字节校验（手算） ——
  // StartConnection：type=FullClientRequest(1) flag=WithEvent(4) event=1 payload="{}"
  //   头 11 14 10 00 | event 00 00 00 01 | (连接事件无 sessionId) | payloadLen 00 00 00 02 | "{}" 7b 7d
  assertFixedBytes(
    "StartConnection",
    { type: MsgType.FullClientRequest, flag: MsgTypeFlag.WithEvent, event: EventType.StartConnection, payload: utf8.encode("{}") },
    "11 14 10 00 00 00 00 01 00 00 00 02 7b 7d"
  );

  // StartSession：event=100 sessionId="abc" payload="{}"
  //   头 11 14 10 00 | event 00 00 00 64 | sidLen 00 00 00 03 | "abc" 61 62 63 | payloadLen 00 00 00 02 | 7b 7d
  assertFixedBytes(
    "StartSession",
    { type: MsgType.FullClientRequest, flag: MsgTypeFlag.WithEvent, event: EventType.StartSession, sessionId: "abc", payload: utf8.encode("{}") },
    "11 14 10 00 00 00 00 64 00 00 00 03 61 62 63 00 00 00 02 7b 7d"
  );

  // —— 往返一致（覆盖各分支） ——
  assertRoundTrip("StartConnection", {
    type: MsgType.FullClientRequest,
    flag: MsgTypeFlag.WithEvent,
    event: EventType.StartConnection,
    payload: utf8.encode("{}")
  });

  assertRoundTrip("TaskRequest 含中文文本", {
    type: MsgType.FullClientRequest,
    flag: MsgTypeFlag.WithEvent,
    event: EventType.TaskRequest,
    sessionId: "session-中文-42",
    payload: utf8.encode(JSON.stringify({ text: "你好，世界。这是第一句。" }))
  });

  assertRoundTrip("音频序号帧（正序号）", {
    type: MsgType.AudioOnlyServer,
    flag: MsgTypeFlag.PositiveSeq,
    sequence: 7,
    payload: Uint8Array.from([0x00, 0x01, 0xfe, 0xff, 0x80])
  });

  assertRoundTrip("音频终包（负序号）", {
    type: MsgType.AudioOnlyServer,
    flag: MsgTypeFlag.NegativeSeq,
    sequence: -3,
    payload: Uint8Array.from([0xde, 0xad, 0xbe, 0xef])
  });

  // connectId 是服务端下行专有字段，客户端 encode 从不写它（对齐 protocols_.py：writers 无 connect_id）。
  // 故不能用 encode→decode 自证，改为手工构造一帧真实服务端 ConnectionStarted 字节来解码：
  //   头 11 94 10 00 | event 00 00 00 32(=50) | (ConnectionStarted 跳过 sessionId)
  //   | connectIdLen 00 00 00 06 | "conn-9" 63 6f 6e 6e 2d 39 | payloadLen 00 00 00 02 | "{}" 7b 7d
  const serverConnectionStarted = Uint8Array.from(
    "11 94 10 00 00 00 00 32 00 00 00 06 63 6f 6e 6e 2d 39 00 00 00 02 7b 7d".split(" ").map((t) => parseInt(t, 16))
  );
  const decodedServer = decodeFrame(serverConnectionStarted);
  assert(decodedServer.type === MsgType.FullServerResponse, "服务端帧 type");
  assert(decodedServer.event === EventType.ConnectionStarted, "服务端帧 event");
  assert(decodedServer.connectId === "conn-9", `服务端帧 connectId(${decodedServer.connectId})`);
  assert(decodedServer.sessionId === "", "服务端帧 sessionId 应为空");
  assert(new TextDecoder().decode(decodedServer.payload) === "{}", "服务端帧 payload");

  assertRoundTrip("下行会话建立（带 sessionId）", {
    type: MsgType.FullServerResponse,
    flag: MsgTypeFlag.WithEvent,
    event: EventType.SessionStarted,
    sessionId: "sess-1",
    payload: utf8.encode(JSON.stringify({ ok: true }))
  });

  assertRoundTrip("错误帧", {
    type: MsgType.Error,
    flag: MsgTypeFlag.NoSeq,
    errorCode: 45000000,
    payload: utf8.encode("invalid request")
  });

  assertRoundTrip("空载荷 NoSeq", {
    type: MsgType.FullClientRequest,
    flag: MsgTypeFlag.NoSeq,
    payload: new Uint8Array(0)
  });
}

runFrameCodecSelfTest();
// 直接运行时打印结果；被 import 时上面这行也会跑一次断言（无副作用，纯校验）
console.log("[frameCodec self-test] 全部通过：固定字节 2 项 + 往返 7 项 + 服务端 connectId 帧解码 1 项。");
