/**
 * VOID 本地技能 HTTP 路由：/void-skills/*（41 号文档）。
 * 只读列出本地任务剧本；不加载、不执行任何代码。
 *
 * 契约与其它 sidecar 模块一致：成功 { ok:true, data }，失败 { ok:false, error:{ code, message } }。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  MAX_MANIFEST_BYTES,
  MAX_SKILL_DIRECTORIES,
  scanSkillsDirectory
} from "./skillsRegistry";

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

/**
 * 处理 /void-skills/* 。命中返回 true。
 */
export function handleSkillsHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string
): boolean {
  if (!pathname.startsWith("/void-skills")) {
    return false;
  }

  if (request.method === "GET" && (pathname === "/void-skills/list" || pathname === "/void-skills")) {
    try {
      const result = scanSkillsDirectory();
      sendJson(response, 200, { ok: true, data: result });
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: {
          code: "SKILLS_SCAN_FAILED",
          message: error instanceof Error ? error.message : "技能目录扫描失败"
        }
      });
    }
    return true;
  }

  if (request.method !== "GET") {
    sendJson(response, 405, {
      ok: false,
      error: { code: "INVALID_REQUEST", message: "一期仅支持 GET /void-skills/list" }
    });
    return true;
  }

  sendJson(response, 404, {
    ok: false,
    error: { code: "NOT_FOUND", message: "未知技能端点" }
  });
  return true;
}

/** 供 health/自检类输出引用的资源上界。 */
export const SKILLS_LIMITS = {
  maxSkillDirectories: MAX_SKILL_DIRECTORIES,
  maxManifestBytes: MAX_MANIFEST_BYTES
} as const;
