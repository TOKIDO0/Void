/**
 * VOID 记忆 Embedding HTTP 路由：/void-memory/*（M4）。
 * 前端召回侧经此端点拿本地句向量；密钥无关、纯本地推理，不外发任何文本到第三方 API。
 *
 * 契约与其它 sidecar 模块一致：成功 { ok:true, data }，失败 { ok:false, error:{ code, message } }。
 * 模型加载/推理异常统一兜成 500 + EMBEDDING_FAILED，前端据此回退纯全文检索。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isInvalidJsonBody,
  isRequestBodyTooLarge,
  readJsonBody
} from "../http/httpRequest";
import {
  DEFAULT_LOCAL_EMBEDDING_MODEL,
  EMBEDDING_BATCH_MAX_TEXTS
} from "./memoryEmbeddingConfig";

const EMBEDDING_TEXT_MAX_CHARACTERS = 1000;
const EMBEDDING_TOTAL_TEXT_MAX_CHARACTERS = 20_000;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** 从请求体取 texts：必须是字符串数组，逐条 trim，丢弃空串。 */
function parseTexts(body: Record<string, unknown>): string[] {
  const raw = body.texts;
  if (!Array.isArray(raw)) {
    throw Object.assign(new Error("texts 必须是字符串数组"), {
      memoryCode: "INVALID_REQUEST"
    });
  }
  const texts: string[] = [];
  let totalCharacters = 0;
  for (const item of raw) {
    if (typeof item !== "string") {
      throw Object.assign(new Error("texts 内元素必须都是字符串"), {
        memoryCode: "INVALID_REQUEST"
      });
    }
    const trimmed = item.trim();
    if (trimmed) {
      if (trimmed.length > EMBEDDING_TEXT_MAX_CHARACTERS) {
        throw Object.assign(
          new Error(`单条文本不能超过 ${EMBEDDING_TEXT_MAX_CHARACTERS} 字符`),
          { memoryCode: "INVALID_REQUEST" }
        );
      }
      totalCharacters += trimmed.length;
      if (totalCharacters > EMBEDDING_TOTAL_TEXT_MAX_CHARACTERS) {
        throw Object.assign(
          new Error(`texts 总字符不能超过 ${EMBEDDING_TOTAL_TEXT_MAX_CHARACTERS}`),
          { memoryCode: "INVALID_REQUEST" }
        );
      }
      texts.push(trimmed);
    }
  }
  if (texts.length > EMBEDDING_BATCH_MAX_TEXTS) {
    throw Object.assign(
      new Error(`texts 条数超限：${texts.length} > ${EMBEDDING_BATCH_MAX_TEXTS}`),
      { memoryCode: "INVALID_REQUEST" }
    );
  }
  return texts;
}

/**
 * 处理 /void-memory/* 。命中返回 true。
 */
export async function handleMemoryHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string
): Promise<boolean> {
  if (!pathname.startsWith("/void-memory")) {
    return false;
  }

  if (request.method === "GET" && pathname === "/void-memory/health") {
    sendJson(response, 200, {
      status: "ok",
      module: "memory",
      model: DEFAULT_LOCAL_EMBEDDING_MODEL,
      limits: {
        batchMaxTexts: EMBEDDING_BATCH_MAX_TEXTS,
        textMaxCharacters: EMBEDDING_TEXT_MAX_CHARACTERS,
        totalTextMaxCharacters: EMBEDDING_TOTAL_TEXT_MAX_CHARACTERS
      }
    });
    return true;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, {
      ok: false,
      error: { code: "INVALID_REQUEST", message: "仅支持 POST/GET health" }
    });
    return true;
  }

  if (pathname === "/void-memory/embed") {
    try {
      const body = asRecord(await readJsonBody(request));
      const isQuery = body.isQuery === true;
      const texts = parseTexts(body);
      const { embedTexts } = await import("./memoryEmbeddingModel");
      const vectors = await embedTexts(texts, isQuery);
      const dim = vectors.length > 0 ? vectors[0].length : 0;
      sendJson(response, 200, {
        ok: true,
        data: { vectors, dim, model: DEFAULT_LOCAL_EMBEDDING_MODEL }
      });
    } catch (error) {
      if (isRequestBodyTooLarge(error)) {
        sendJson(response, 413, {
          ok: false,
          error: { code: "REQUEST_BODY_TOO_LARGE", message: error.message }
        });
        return true;
      }
      if (isInvalidJsonBody(error)) {
        sendJson(response, 400, {
          ok: false,
          error: { code: "INVALID_REQUEST", message: error.message }
        });
        return true;
      }
      const memoryCode =
        typeof error === "object" && error && "memoryCode" in error
          ? String((error as { memoryCode?: unknown }).memoryCode)
          : "EMBEDDING_FAILED";
      const status = memoryCode === "INVALID_REQUEST" ? 400 : 500;
      sendJson(response, status, {
        ok: false,
        error: {
          code: memoryCode,
          message: error instanceof Error ? error.message : "记忆向量编码失败"
        }
      });
    }
    return true;
  }

  sendJson(response, 404, {
    ok: false,
    error: { code: "INVALID_REQUEST", message: `未知记忆路由：${pathname}` }
  });
  return true;
}
