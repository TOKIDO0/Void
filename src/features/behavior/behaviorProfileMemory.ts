/**
 * BEH-02 画像记忆适配层。
 *
 * 职责：把 owner 已派生好的画像草稿写进记忆 `preference` 分区。
 * 只做三件事：
 * 1. policy 闸门（敏感级别 + 写入裁决），不信任服务端自称的敏感级别；
 * 2. 稳定 id 原地更新，避免文案每天变化堆出多条；
 * 3. 同步游标/删除墓碑，尊重用户在记忆面板的删除。
 *
 * 不做画像判定、不生成文案、不改阈值；那些只在 server/behavior/behaviorProfile.ts。
 */

import { assessSensitivity, resolveWriteDecision } from "../memory/memoryPolicy";
import { getMemoryById, upsertMemory } from "../memory/memoryStore";
import type { BehaviorProfileMemoryDraft } from "./behaviorBridgeClient";

/** 单例画像条目的稳定 id：内容变化时原地更新，不新增。 */
export const BEHAVIOR_PROFILE_MEMORY_ID = "mem_behavior_profile_v1";

/** 记忆来源标记，便于管理面板/审计区分机器派生条目。 */
export const BEHAVIOR_PROFILE_MEMORY_SOURCE = "behaviorProfile";

/** 同步游标键：只存布尔状态，不存画像内容。 */
export const BEHAVIOR_PROFILE_SYNC_STATE_KEY = "void.behavior.profile.sync.v1";

export type BehaviorProfileForMemory = {
  status: "ok" | "insufficient_data" | "disabled";
  enabled: boolean;
  memoryDraft: BehaviorProfileMemoryDraft | null;
};

type BehaviorProfileSyncState = {
  version: 1;
  everWritten: boolean;
  dismissed: boolean;
  lastEnabled: boolean;
};

export type BehaviorProfileApplyResult =
  | { action: "written" | "updated" | "unchanged"; id: string }
  | {
    action: "skipped";
    reason:
      | "disabled"
      | "insufficient_data"
      | "dismissed"
      | "policy_confirm"
      | "policy_blocked"
      | "invalid_draft"
      | "write_failed";
  };

function defaultSyncState(): BehaviorProfileSyncState {
  return { version: 1, everWritten: false, dismissed: false, lastEnabled: false };
}

function loadSyncState(): BehaviorProfileSyncState {
  if (typeof window === "undefined" || !window.localStorage) {
    return defaultSyncState();
  }
  try {
    const raw = window.localStorage.getItem(BEHAVIOR_PROFILE_SYNC_STATE_KEY);
    if (!raw) {
      return defaultSyncState();
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.version !== 1) {
      return defaultSyncState();
    }
    return {
      version: 1,
      everWritten: parsed.everWritten === true,
      dismissed: parsed.dismissed === true,
      lastEnabled: parsed.lastEnabled === true
    };
  } catch {
    return defaultSyncState();
  }
}

function saveSyncState(state: BehaviorProfileSyncState): void {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    const serialized = JSON.stringify(state);
    if (window.localStorage.getItem(BEHAVIOR_PROFILE_SYNC_STATE_KEY) === serialized) {
      return;
    }
    window.localStorage.setItem(BEHAVIOR_PROFILE_SYNC_STATE_KEY, serialized);
  } catch (error) {
    // 游标写失败不影响画像本身：下次用条目存在性兜底，不阻塞采样/对话。
    console.warn("[void-behavior] 画像同步游标写入失败", error);
  }
}

function isValidDraft(
  draft: BehaviorProfileMemoryDraft | null
): draft is BehaviorProfileMemoryDraft {
  if (!draft) {
    return false;
  }
  return draft.memoryType === "preference"
    && draft.subjectType === "self"
    && draft.source === BEHAVIOR_PROFILE_MEMORY_SOURCE
    && typeof draft.content === "string"
    && draft.content.trim().length > 0
    && typeof draft.confidence === "number"
    && Number.isFinite(draft.confidence);
}

/**
 * 把一份已经派生好的画像写入记忆。
 * 同步函数，不触网络；失败只返回结构化结果，不向 UI 抛错。
 */
export function applyBehaviorProfileToMemory(
  profile: BehaviorProfileForMemory,
  nowMs = Date.now()
): BehaviorProfileApplyResult {
  const state = loadSyncState();
  const enabled = profile.enabled === true;
  const justEnabled = enabled && !state.lastEnabled;
  if (justEnabled) {
    // 用户重新开启行为观察：清除上次删除留下的墓碑。
    state.dismissed = false;
  }
  state.lastEnabled = enabled;

  if (!enabled || profile.status === "disabled") {
    saveSyncState(state);
    return { action: "skipped", reason: "disabled" };
  }
  if (profile.status !== "ok") {
    saveSyncState(state);
    return { action: "skipped", reason: "insufficient_data" };
  }

  const draft = profile.memoryDraft;
  if (!isValidDraft(draft)) {
    saveSyncState(state);
    return { action: "skipped", reason: "invalid_draft" };
  }

  const existing = getMemoryById(BEHAVIOR_PROFILE_MEMORY_ID);
  if (existing && existing.content === draft.content) {
    state.everWritten = true;
    state.dismissed = false;
    saveSyncState(state);
    return { action: "unchanged", id: BEHAVIOR_PROFILE_MEMORY_ID };
  }

  if (!existing) {
    // 已写过但条目消失：视为用户在记忆面板删除，写墓碑，不自动复活。
    if (state.everWritten && !justEnabled) {
      state.dismissed = true;
      saveSyncState(state);
      return { action: "skipped", reason: "dismissed" };
    }
    if (state.dismissed && !justEnabled) {
      saveSyncState(state);
      return { action: "skipped", reason: "dismissed" };
    }
  }

  const sensitivity = assessSensitivity("preference", draft.content);
  const decision = resolveWriteDecision({
    memoryType: "preference",
    subjectType: "self",
    content: draft.content,
    sensitivity
  });
  if (decision.action !== "auto") {
    saveSyncState(state);
    return {
      action: "skipped",
      reason: decision.action === "confirm" ? "policy_confirm" : "policy_blocked"
    };
  }

  const confidence = Math.min(1, Math.max(0, draft.confidence));
  try {
    if (existing) {
      upsertMemory({
        ...existing,
        memoryType: "preference",
        subjectType: "self",
        subjectName: draft.subjectName || existing.subjectName || "用户本人",
        content: draft.content,
        confidence,
        source: BEHAVIOR_PROFILE_MEMORY_SOURCE,
        sensitivity,
        updatedAt: nowMs
      });
      state.everWritten = true;
      state.dismissed = false;
      saveSyncState(state);
      return { action: "updated", id: BEHAVIOR_PROFILE_MEMORY_ID };
    }

    upsertMemory({
      id: BEHAVIOR_PROFILE_MEMORY_ID,
      memoryType: "preference",
      subjectType: "self",
      subjectName: draft.subjectName || "用户本人",
      content: draft.content,
      confidence,
      source: BEHAVIOR_PROFILE_MEMORY_SOURCE,
      sensitivity,
      createdAt: nowMs,
      updatedAt: nowMs
    });
    state.everWritten = true;
    state.dismissed = false;
    saveSyncState(state);
    return { action: "written", id: BEHAVIOR_PROFILE_MEMORY_ID };
  } catch (error) {
    console.warn("[void-behavior] 作息画像写入记忆失败", error);
    saveSyncState(state);
    return { action: "skipped", reason: "write_failed" };
  }
}
