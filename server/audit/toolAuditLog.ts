/**
 * 工具调用审计日志（P0-5/P1 真源）。
 *
 * owner：server/audit/toolAuditLog.ts。
 * - append-only JSONL：<runtime-root>/audit/tool-calls.jsonl；
 * - 有界：单文件 2MB，超限轮转保留 1 个备份；
 * - 永不抛错：审计失败只 console.warn，不中断业务调用；
 * - 记录字段：时间、模块、动作、结论（allow/ask-allow/deny/needs-confirmation/error）、
 *   调用方标识（bridge token 指纹前 8 位，不存 token 原文）、耗时、错误码。
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { resolveRuntimeRoot } from "../file/fileRuntimePaths";

const MAX_AUDIT_BYTES = 2 * 1024 * 1024;

export type AuditDecision =
  | "allow"
  | "ask-allow"
  | "deny"
  | "needs-confirmation"
  | "error";

export type ToolAuditEntry = {
  at: number;
  module: string;
  action: string;
  decision: AuditDecision;
  reason?: string;
  callerFingerprint?: string;
  durationMs?: number;
  errorCode?: string;
};

function auditFile(): string {
  const dir = join(resolveRuntimeRoot(), "audit");
  mkdirSync(dir, { recursive: true });
  return join(dir, "tool-calls.jsonl");
}

export function fingerprintToken(token: string): string {
  if (!token) return "anonymous";
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}

function rotateIfNeeded(file: string): void {
  try {
    if (!existsSync(file)) return;
    const size = statSync(file).size;
    if (size <= MAX_AUDIT_BYTES) return;
    try {
      renameSync(file, `${file}.1`);
    } catch {
      // ignore
    }
  } catch {
    // ignore
  }
}

export function appendToolAudit(entry: ToolAuditEntry): void {
  try {
    const file = auditFile();
    rotateIfNeeded(file);
    appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    console.warn("[tool-audit] append failed", error instanceof Error ? error.message : error);
  }
}
