/**
 * P6 接管模式 Tauri 直调客户端（enigo 键鼠经 Rust command，不走 sidecar HTTP）。
 * 桌面端专用；纯 Web 下 invoke 不可用，如实报 NOT_DESKTOP。
 */

import { invoke } from "@tauri-apps/api/core";

export type TakeoverSessionView = {
  sessionId: string;
  expiresInSec: number;
  allow: string[];
};

export type TakeoverAuditEntry = {
  at: number;
  action: string;
  foregroundExe: string;
};

export type TakeoverStatusView = {
  active: boolean;
  sessionId?: string;
  expiresInSec: number;
  allow: string[];
  auditTail: TakeoverAuditEntry[];
};

export type TakeoverInputReceipt = {
  ok: boolean;
  foregroundExe: string;
  at: number;
};

function toTakeoverError(error: unknown): Error & { takeoverCode: string } {
  const message = typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : "接管调用失败";
  const err = new Error(message) as Error & { takeoverCode: string };
  err.takeoverCode = /桌面端|Tauri|__TAURI__|not allowed|not found/i.test(message) ? "NOT_DESKTOP" : "TAKEOVER_FAILED";
  return err;
}

async function callTakeover<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw toTakeoverError(error);
  }
}

export async function takeoverStart(ttlMinutes?: number, allowProcesses?: string[]): Promise<TakeoverSessionView> {
  return callTakeover<TakeoverSessionView>("takeover_start", {
    ttlMinutes: ttlMinutes ?? null,
    allowProcesses: allowProcesses ?? []
  });
}

export async function takeoverStop(): Promise<boolean> {
  return callTakeover<boolean>("takeover_stop");
}

export async function takeoverStatus(): Promise<TakeoverStatusView> {
  return callTakeover<TakeoverStatusView>("takeover_status");
}

export type TakeoverInputRequest = {
  kind: "keyTap" | "keyDown" | "keyUp" | "typeText" | "mouseMove" | "mouseClick";
  key?: string;
  text?: string;
  button?: string;
  x?: number;
  y?: number;
};

export async function takeoverInput(input: TakeoverInputRequest): Promise<TakeoverInputReceipt> {
  const { kind, key, text, button, x, y } = input;
  return callTakeover<TakeoverInputReceipt>("takeover_input", {
    input: { kind, key, text, button, x, y }
  });
}
