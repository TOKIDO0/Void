import { randomBytes } from "node:crypto";

const TICKET_TTL_MS = 30_000;
const MAX_PENDING_TICKETS = 32;

type PendingTicket = { createdAt: number; expiresAt: number };

const pending = new Map<string, PendingTicket>();

export type VoiceSttTicket = { ticket: string; expiresAt: number };

/**
 * 单次 WS 票据：只用于 /void-voice/stt 的 upgrade 鉴权。
 * 不落盘、不使用长期 token、消费即删除。
 * 取票本身已在 bridge token + 回环 + Origin 校验之后，不再叠加时间节流，
 * 避免用户快速停止/重开时被误判 429。
 */
export function issueVoiceSttTicket(now = Date.now()): VoiceSttTicket | null {
  pruneExpired(now);
  if (pending.size >= MAX_PENDING_TICKETS) {
    return null;
  }
  const ticket = randomBytes(32).toString("base64url");
  const expiresAt = now + TICKET_TTL_MS;
  pending.set(ticket, { createdAt: now, expiresAt });
  return { ticket, expiresAt };
}

/** 消费票据；存在且未过期才通过，无论结果都删除。 */
export function consumeVoiceSttTicket(ticket: string, now = Date.now()): boolean {
  const entry = pending.get(ticket);
  if (!entry) {
    return false;
  }
  pending.delete(ticket);
  return entry.expiresAt > now;
}

function pruneExpired(now: number): void {
  for (const [ticket, entry] of pending) {
    if (entry.expiresAt <= now) {
      pending.delete(ticket);
    }
  }
}
