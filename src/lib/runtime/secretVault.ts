/**
 * P0-2 密钥 vault 接缝（Stronghold）。
 *
 * 架构取舍（必须先说清楚）：
 *  - Stronghold 是 Tauri Rust 插件，JS API 只能在 WebView/前端进程调用，
 *    sidecar（独立 node 进程）读不到 Stronghold。因此 vault 引用链路是：
 *    前端 Stronghold 存原文 → 解锁/请求时前端 resolve 成明文 → 经回环 + bridge token
 *    短时送内存（sidecar 只存内存、绝不落盘、不回显）→ jobs.json 永远只存 vault: 引用。
 *  - 同步 getSecret/setSecret 保持兼容（读本地缓存），新增 async vault 版为真相源；
 *    一次性迁移 migratePlaintextSecretsToVault() 把 localStorage 明文搬进 Stronghold
 *    成功后立即清除明文。
 */

export const VAULT_REF_PREFIX = "vault:";

export function isVaultRef(value: string): boolean {
  return value.trim().startsWith(VAULT_REF_PREFIX);
}

export function vaultAliasFromRef(ref: string): string {
  const trimmed = ref.trim();
  if (!trimmed.startsWith(VAULT_REF_PREFIX)) return "";
  return trimmed.slice(VAULT_REF_PREFIX.length).trim();
}

export function toVaultRef(alias: string): string {
  return `${VAULT_REF_PREFIX}${alias.trim()}`;
}

type StrongholdModule = {
  Stronghold?: new (...args: never[]) => {
    load?: (...args: never[]) => Promise<unknown>;
    unload?: (...args: never[]) => Promise<unknown>;
  };
  load?: (...args: never[]) => Promise<unknown>;
};

let strongholdAvailable: boolean | null = null;
const memoryVaultFallback = new Map<string, string>();

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window
  );
}

async function probeStronghold(): Promise<boolean> {
  if (strongholdAvailable !== null) return strongholdAvailable;
  if (!isTauriRuntime()) {
    strongholdAvailable = false;
    return false;
  }
  try {
    // @ts-ignore 可选依赖：未安装时 probe 返回 false，不中断构建
    await import("@tauri-apps/plugin-stronghold");
    strongholdAvailable = true;
  } catch {
    strongholdAvailable = false;
  }
  return strongholdAvailable;
}

export async function isVaultAvailable(): Promise<boolean> {
  return probeStronghold();
}

/**
 * vault 读取：Stronghold 可用时走插件，否则走内存 fallback（仅会话级，不落盘）。
 * 调用方不得把返回值再写入 localStorage 明文。
 */
export async function getVaultSecret(alias: string): Promise<string> {
  const key = alias.trim();
  if (!key) return "";
  if (await probeStronghold()) {
    try {
      // @ts-ignore 可选依赖：未安装时回落内存 vault
      const mod = (await import("@tauri-apps/plugin-stronghold")) as unknown as StrongholdModule & {
        getSecret?: (alias: string) => Promise<string>;
      };
      if (typeof mod.getSecret === "function") {
        const value = await mod.getSecret(key);
        return typeof value === "string" ? value : "";
      }
    } catch {
      // fallthrough to memory fallback
    }
  }
  return memoryVaultFallback.get(key) ?? "";
}

/** vault 写入：Stronghold 可用时走插件，否则内存 fallback。 */
export async function setVaultSecret(alias: string, value: string): Promise<void> {
  const key = alias.trim();
  const trimmed = value.trim();
  if (!key) return;
  if (await probeStronghold()) {
    try {
      // @ts-ignore 可选依赖：未安装时回落内存 vault
      const mod = (await import("@tauri-apps/plugin-stronghold")) as unknown as StrongholdModule & {
        setSecret?: (alias: string, value: string) => Promise<void>;
        removeSecret?: (alias: string) => Promise<void>;
      };
      if (!trimmed) {
        await mod.removeSecret?.(key);
      } else if (typeof mod.setSecret === "function") {
        await mod.setSecret(key, trimmed);
      } else {
        if (!trimmed) memoryVaultFallback.delete(key);
        else memoryVaultFallback.set(key, trimmed);
      }
      return;
    } catch {
      // fallthrough
    }
  }
  if (!trimmed) memoryVaultFallback.delete(key);
  else memoryVaultFallback.set(key, trimmed);
}

export async function removeVaultSecret(alias: string): Promise<void> {
  await setVaultSecret(alias, "");
}

/** resolve vault: 引用或明文（兼容期）：vault 引用走 vault，无前缀视为历史明文透传。 */
export async function resolveSecretValue(stored: string): Promise<string> {
  const trimmed = (stored ?? "").trim();
  if (!trimmed) return "";
  if (!isVaultRef(trimmed)) return trimmed;
  return getVaultSecret(vaultAliasFromRef(trimmed));
}
