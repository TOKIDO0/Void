/**
 * VOID 托管语音代理 —— Cloudflare Worker 入口路由。
 *
 * 职责：在客户端与豆包 openspeech v3 之间做「带鉴权头的翻译式 WebSocket 桥接」。
 * 豆包鉴权密钥只存在 Worker Secret（env），客户端永不持有。
 *   - /tts  → 豆包双向流式 TTS 桥接（见 ttsBridge.ts）
 *   - /stt  → 豆包大模型流式 STT 桥接（见 sttBridge.ts）
 *   - /health → 健康检查
 *
 * 客户端↔Worker 之间沿用与原 sidecar 完全一致的 JSON 信封协议，仅 start 事件不再带密钥。
 */
import { handleTtsSession } from "./ttsBridge";
import { handleSttSession } from "./sttBridge";

export interface Env {
  // 豆包 openspeech v3 鉴权（STT/TTS 共用 App/Access），均以 Worker Secret 注入。
  DOUBAO_APP_ID: string;
  DOUBAO_ACCESS_KEY: string;
  DOUBAO_TTS_RESOURCE_ID: string;
  DOUBAO_ASR_RESOURCE_ID: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    // 面向客户端的一对 WebSocket：server 端留在 Worker 内，client 端随 101 返回。
    const { 0: clientSocket, 1: serverSocket } = new WebSocketPair();
    serverSocket.accept();

    if (url.pathname === "/tts") {
      handleTtsSession(serverSocket, env);
    } else if (url.pathname === "/stt") {
      handleSttSession(serverSocket, env);
    } else {
      serverSocket.close(1008, "unknown voice proxy path");
    }

    return new Response(null, { status: 101, webSocket: clientSocket });
  }
} satisfies ExportedHandler<Env>;
