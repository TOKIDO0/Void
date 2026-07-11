/**
 * 把 Workers WebSocket 消息数据（string / ArrayBuffer / Blob / Uint8Array）统一为 Uint8Array。
 * Workers 的二进制 WS 消息常以 Blob 到达（异步），故本函数返回 Promise。
 */
export async function toBytes(data: unknown): Promise<Uint8Array> {
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  return new Uint8Array(await (data as Blob).arrayBuffer());
}
