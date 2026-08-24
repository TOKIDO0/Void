/**
 * 浏览器自动化 HTTP 路由处理器。
 * 路径前缀：/void-browser/*
 * 仅 JSON；错误统一 BrowserApiResponse 形态。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isInvalidJsonBody,
  isRequestBodyTooLarge,
  readJsonBody
} from "../http/httpRequest";
import {
  browserSessionManager,
  getBrowserErrorPayload
} from "./browserSessionManager";
import type {
  BrowserApiResponse,
  BrowserClickData,
  BrowserCloseSessionData,
  BrowserExtractData,
  BrowserLongPressData,
  BrowserOpenData,
  BrowserReadResultData,
  BrowserScreenshotData,
  BrowserSearchData,
  BrowserSwitchTabData,
  BrowserTabsData,
  BrowserTypeData,
  BrowserWaitForData
} from "./browserTypes";

function sendJson(response: ServerResponse, status: number, body: unknown) {
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

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

async function withBrowserHandler<T>(
  response: ServerResponse,
  work: () => Promise<T>
): Promise<void> {
  try {
    const data = await work();
    const payload: BrowserApiResponse<T> = { ok: true, data };
    sendJson(response, 200, payload);
  } catch (error) {
    if (isRequestBodyTooLarge(error)) {
      sendJson(response, 413, {
        ok: false,
        error: { code: "REQUEST_BODY_TOO_LARGE", message: error.message }
      });
      return;
    }
    if (isInvalidJsonBody(error)) {
      sendJson(response, 400, {
        ok: false,
        error: { code: "INVALID_REQUEST", message: error.message }
      });
      return;
    }
    const payloadError = getBrowserErrorPayload(error);
    const status =
      payloadError.code === "INVALID_REQUEST"
        ? 400
        : payloadError.code === "SESSION_NOT_FOUND" || payloadError.code === "PAGE_NOT_FOUND"
          ? 404
          : payloadError.code === "RESOURCE_LIMIT"
            ? 429
            : payloadError.code === "BROWSER_UNAVAILABLE"
              ? 503
              : 500;
    const payload: BrowserApiResponse<never> = {
      ok: false,
      error: payloadError
    };
    sendJson(response, status, payload);
  }
}

/**
 * 处理 /void-browser/* 路由。命中返回 true。
 */
export async function handleBrowserHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string
): Promise<boolean> {
  if (!pathname.startsWith("/void-browser")) {
    return false;
  }

  if (request.method === "GET" && pathname === "/void-browser/health") {
    sendJson(response, 200, {
      status: "ok",
      browserReady: browserSessionManager.isBrowserReady(),
      activeSessions: browserSessionManager.listActiveTaskIds().length
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

  if (pathname === "/void-browser/session/ensure") {
    await withBrowserHandler(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const taskId = readString(body, "taskId");
      if (!taskId) {
        throw Object.assign(new Error("缺少 taskId"), { browserCode: "INVALID_REQUEST" });
      }
      return browserSessionManager.ensureSession(taskId);
    });
    return true;
  }

  if (pathname === "/void-browser/session/close") {
    await withBrowserHandler<BrowserCloseSessionData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const taskId = readString(body, "taskId");
      if (!taskId) {
        throw Object.assign(new Error("缺少 taskId"), { browserCode: "INVALID_REQUEST" });
      }
      return browserSessionManager.closeSession(taskId);
    });
    return true;
  }

  // Q2：列出任务内标签页
  if (pathname === "/void-browser/tabs") {
    await withBrowserHandler<BrowserTabsData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const taskId = readString(body, "taskId");
      if (!taskId) {
        throw Object.assign(new Error("缺少 taskId"), {
          browserCode: "INVALID_REQUEST"
        });
      }
      return browserSessionManager.listTabs({ taskId });
    });
    return true;
  }

  // Q2：切换活动标签页
  if (pathname === "/void-browser/switch-tab") {
    await withBrowserHandler<BrowserSwitchTabData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const taskId = readString(body, "taskId");
      const pageId = readString(body, "pageId");
      if (!taskId || !pageId) {
        throw Object.assign(new Error("缺少 taskId 或 pageId"), {
          browserCode: "INVALID_REQUEST"
        });
      }
      return browserSessionManager.switchTab({ taskId, pageId });
    });
    return true;
  }

  if (pathname === "/void-browser/open") {
    await withBrowserHandler<BrowserOpenData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const taskId = readString(body, "taskId");
      const url = readString(body, "url");
      if (!taskId || !url) {
        throw Object.assign(new Error("缺少 taskId 或 url"), {
          browserCode: "INVALID_REQUEST"
        });
      }
      return browserSessionManager.open({
        taskId,
        url,
        pageId: readString(body, "pageId")
      });
    });
    return true;
  }

  if (pathname === "/void-browser/search") {
    await withBrowserHandler<BrowserSearchData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const taskId = readString(body, "taskId");
      const query = readString(body, "query");
      if (!taskId || !query) {
        throw Object.assign(new Error("缺少 taskId 或 query"), {
          browserCode: "INVALID_REQUEST"
        });
      }
      const engineRaw = readString(body, "engine");
      const engine =
        engineRaw === "bilibili" || engineRaw === "duckduckgo"
          ? engineRaw
          : undefined;
      return browserSessionManager.search({
        taskId,
        query,
        engine,
        limit: readNumber(body, "limit")
      });
    });
    return true;
  }

  if (pathname === "/void-browser/reveal-system") {
    await withBrowserHandler(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const taskId = readString(body, "taskId");
      const url = readString(body, "url");
      if (!taskId || !url) {
        throw Object.assign(new Error("缺少 taskId 或 url"), {
          browserCode: "INVALID_REQUEST"
        });
      }
      return browserSessionManager.revealInSystemBrowser({
        taskId,
        url,
        titleHint: readString(body, "titleHint")
      });
    });
    return true;
  }

  if (pathname === "/void-browser/read-result") {
    await withBrowserHandler<BrowserReadResultData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const taskId = readString(body, "taskId");
      if (!taskId) {
        throw Object.assign(new Error("缺少 taskId"), { browserCode: "INVALID_REQUEST" });
      }
      return browserSessionManager.readResult({
        taskId,
        pageId: readString(body, "pageId"),
        limit: readNumber(body, "limit")
      });
    });
    return true;
  }

  if (pathname === "/void-browser/screenshot") {
    await withBrowserHandler<BrowserScreenshotData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const taskId = readString(body, "taskId");
      if (!taskId) {
        throw Object.assign(new Error("缺少 taskId"), { browserCode: "INVALID_REQUEST" });
      }
      return browserSessionManager.screenshot({
        taskId,
        pageId: readString(body, "pageId"),
        fullPage: readBoolean(body, "fullPage")
      });
    });
    return true;
  }

  // 阶段 G1 / Q1：窄动作 click / type / wait-for（selector 或 role+name）
  if (pathname === "/void-browser/click") {
    await withBrowserHandler<BrowserClickData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const taskId = readString(body, "taskId");
      const selector = readString(body, "selector");
      const role = readString(body, "role");
      const name = readString(body, "name");
      // 至少要有 taskId，且 selector 或 (role+name) 二选一
      if (!taskId) {
        throw Object.assign(new Error("缺少 taskId"), {
          browserCode: "INVALID_REQUEST"
        });
      }
      if (!selector && !(role && name)) {
        throw Object.assign(
          new Error("缺少定位目标：请提供 selector，或同时提供 role 与 name"),
          { browserCode: "INVALID_REQUEST" }
        );
      }
      const buttonRaw = readString(body, "button");
      const button =
        buttonRaw === "right" || buttonRaw === "middle" || buttonRaw === "left"
          ? buttonRaw
          : undefined;
      return browserSessionManager.click({
        taskId,
        pageId: readString(body, "pageId"),
        selector,
        role,
        name,
        button,
        clickCount: readNumber(body, "clickCount")
      });
    });
    return true;
  }

  // S3：长按（B 站三连等）；定位规则与 click 相同
  if (pathname === "/void-browser/long-press") {
    await withBrowserHandler<BrowserLongPressData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const taskId = readString(body, "taskId");
      const selector = readString(body, "selector");
      const role = readString(body, "role");
      const name = readString(body, "name");
      if (!taskId) {
        throw Object.assign(new Error("缺少 taskId"), {
          browserCode: "INVALID_REQUEST"
        });
      }
      if (!selector && !(role && name)) {
        throw Object.assign(
          new Error("缺少定位目标：请提供 selector，或同时提供 role 与 name"),
          { browserCode: "INVALID_REQUEST" }
        );
      }
      const buttonRaw = readString(body, "button");
      const button =
        buttonRaw === "right" || buttonRaw === "middle" || buttonRaw === "left"
          ? buttonRaw
          : undefined;
      return browserSessionManager.longPress({
        taskId,
        pageId: readString(body, "pageId"),
        selector,
        role,
        name,
        button,
        holdMs: readNumber(body, "holdMs")
      });
    });
    return true;
  }

  if (pathname === "/void-browser/type") {
    await withBrowserHandler<BrowserTypeData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const taskId = readString(body, "taskId");
      const selector = readString(body, "selector");
      const role = readString(body, "role");
      const name = readString(body, "name");
      if (!taskId) {
        throw Object.assign(new Error("缺少 taskId"), {
          browserCode: "INVALID_REQUEST"
        });
      }
      if (!selector && !(role && name)) {
        throw Object.assign(
          new Error("缺少定位目标：请提供 selector，或同时提供 role 与 name"),
          { browserCode: "INVALID_REQUEST" }
        );
      }
      if (typeof body.text !== "string") {
        throw Object.assign(new Error("缺少 text"), { browserCode: "INVALID_REQUEST" });
      }
      return browserSessionManager.type({
        taskId,
        pageId: readString(body, "pageId"),
        selector,
        role,
        name,
        text: body.text,
        clear: readBoolean(body, "clear"),
        submit: readBoolean(body, "submit")
      });
    });
    return true;
  }

  if (pathname === "/void-browser/wait-for") {
    await withBrowserHandler<BrowserWaitForData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const taskId = readString(body, "taskId");
      const selector = readString(body, "selector");
      if (!taskId || !selector) {
        throw Object.assign(new Error("缺少 taskId 或 selector"), {
          browserCode: "INVALID_REQUEST"
        });
      }
      const stateRaw = readString(body, "state");
      const state =
        stateRaw === "attached"
        || stateRaw === "detached"
        || stateRaw === "visible"
        || stateRaw === "hidden"
          ? stateRaw
          : undefined;
      return browserSessionManager.waitFor({
        taskId,
        pageId: readString(body, "pageId"),
        selector,
        state,
        timeoutMs: readNumber(body, "timeoutMs")
      });
    });
    return true;
  }

  // 阶段 G2：结构化抽取（只读）
  if (pathname === "/void-browser/extract") {
    await withBrowserHandler<BrowserExtractData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const taskId = readString(body, "taskId");
      if (!taskId) {
        throw Object.assign(new Error("缺少 taskId"), {
          browserCode: "INVALID_REQUEST"
        });
      }
      const modeRaw = readString(body, "mode");
      const mode =
        modeRaw === "text" || modeRaw === "both" || modeRaw === "links"
          ? modeRaw
          : undefined;
      return browserSessionManager.extract({
        taskId,
        pageId: readString(body, "pageId"),
        mode,
        scopeSelector: readString(body, "scopeSelector"),
        limit: readNumber(body, "limit"),
        includeBelowFold: readBoolean(body, "includeBelowFold")
      });
    });
    return true;
  }

  sendJson(response, 404, {
    ok: false,
    error: { code: "INVALID_REQUEST", message: `未知浏览器路由：${pathname}` }
  });
  return true;
}
