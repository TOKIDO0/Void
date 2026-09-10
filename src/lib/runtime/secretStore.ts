/**
 * 持久化密钥存储适配层（P0-2 Stronghold 接缝版）。
 *
 * 背景：模型 API Key 原先存 sessionStorage，整页重载即丢，导致模型请求 401
 * ——这是「AI 不回复 / TTS 哑 / 历史缺 AI 回复」三个线上现象的同一根因。
 * 本模块把「密钥存在哪」收敛到唯一入口，避免 sessionStorage / localStorage /
 * Tauri Stronghold 的判断散落在各调用点。
 *
 * 新契约：
 *  - 同步 getSecret/setSecret/removeSecret 保持兼容：读 localStorage 缓存（历史明文），
 *    新写入默认仍落缓存以保可用，但 migratePlaintextSecretsToVault() 会把已知 key
 *    搬进 Stronghold 并清除明文；
 *  - 异步 getSecretAsync/setSecretAsync 走 vault 真相源（Stronghold 可用则加密落盘，
 *    否则内存 fallback 不落盘）；新代码优先用异步版；
 *  - SECRET_BACKEND 仍是唯一接缝：localStorageBackend（同步兼容）+ vaultBackend（异步真相）。
 */

import {
  getVaultSecret,
  isVaultRef,
  setVaultSecret,
  toVaultRef,
  vaultAliasFromRef
} from "./secretVault";

// 密钥存储后端契约：任何后端（localStorage / Stronghold vault）都实现这三个同步方法。
type SecretBackend = {
  get(key: string): string;
  set(key: string, value: string): void;
  remove(key: string): void;
};

// 浏览器 localStorage 后端（同步兼容层；迁移后已知 key 不再走明文）。
const localStorageBackend: SecretBackend = {
  get: (key) => window.localStorage.getItem(key) ?? "",
  set: (key, value) => window.localStorage.setItem(key, value),
  remove: (key) => window.localStorage.removeItem(key)
};

// 唯一接缝：Stronghold 加密后端通过 secretVault 异步接入（见 getSecretAsync）；
// 同步调用方继续走 localStorageBackend 缓存，不直触 Stronghold（插件 API 为异步）。
const SECRET_BACKEND: SecretBackend = localStorageBackend;

/** 读取持久化密钥；不存在时返回空串。 */
export function getSecret(key: string): string {
  return SECRET_BACKEND.get(key);
}

/** 写入持久化密钥；传入空值等价于清除，避免残留空字符串。 */
export function setSecret(key: string, value: string): void {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    SECRET_BACKEND.remove(key);
    return;
  }
  // vault 引用直接透存（引用本身不是秘密）；明文走缓存 + 异步 vault 双写由调用方迁移。
  SECRET_BACKEND.set(key, trimmedValue);
}

/** 清除持久化密钥。 */
export function removeSecret(key: string): void {
  SECRET_BACKEND.remove(key);
}

/** 异步真相源读取：vault 引用走 Stronghold，否则回落同步缓存（兼容历史明文）。 */
export async function getSecretAsync(key: string): Promise<string> {
  const stored = SECRET_BACKEND.get(key).trim();
  if (!stored) return "";
  if (!isVaultRef(stored)) return stored;
  return getVaultSecret(vaultAliasFromRef(stored));
}

/** 异步真相源写入：Stronghold 可用则存 vault 并只留引用，清除明文；否则回落缓存。 */
export async function setSecretAsync(key: string, value: string): Promise<void> {
  const trimmed = value.trim();
  if (!trimmed) {
    SECRET_BACKEND.remove(key);
    await setVaultSecret(key, "");
    return;
  }
  if (isVaultRef(trimmed)) {
    SECRET_BACKEND.set(key, trimmed);
    return;
  }
  try {
    await setVaultSecret(key, trimmed);
    // vault 写入成功：本地只留引用，不留明文。
    SECRET_BACKEND.set(key, toVaultRef(key));
  } catch {
    SECRET_BACKEND.set(key, trimmed);
  }
}

/**
 * 一次性迁移：把已知 key 的 localStorage 明文搬进 vault，成功后清除明文只留引用。
 * 返回实际迁移的 key 列表；未知 key 不碰（调用方显式传入）。
 */
export async function migratePlaintextSecretsToVault(keys: string[]): Promise<string[]> {
  const migrated: string[] = [];
  for (const key of keys) {
    const stored = SECRET_BACKEND.get(key).trim();
    if (!stored || isVaultRef(stored)) continue;
    try {
      await setVaultSecret(key, stored);
      SECRET_BACKEND.set(key, toVaultRef(key));
      migrated.push(key);
    } catch {
      // 单 key 失败不影响其余
    }
  }
  return migrated;
}
