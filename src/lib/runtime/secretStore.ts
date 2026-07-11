/**
 * 持久化密钥存储适配层。
 *
 * 背景：模型 API Key 原先存 sessionStorage，整页重载即丢，导致模型请求 401
 * ——这是「AI 不回复 / TTS 哑 / 历史缺 AI 回复」三个线上现象的同一根因。
 * 本模块把「密钥存在哪」收敛到唯一入口，避免 sessionStorage / localStorage /
 * 未来 Tauri Stronghold 的判断散落在各调用点。
 *
 * 当前后端 = 浏览器 localStorage（密钥是用户自有机器上的用户自备 key，
 * 无跨用户泄露风险，可安全持久化落盘）。
 * 未来 Tauri 打包需要系统级加密存储时，只替换下方 SECRET_BACKEND 这一处接缝
 * 即可接入 Stronghold，调用方（getSecret / setSecret / removeSecret）无需改动。
 */

// 密钥存储后端契约：任何后端（localStorage / 未来 Stronghold）都实现这三个同步方法。
type SecretBackend = {
  get(key: string): string;
  set(key: string, value: string): void;
  remove(key: string): void;
};

// 浏览器 localStorage 后端。
const localStorageBackend: SecretBackend = {
  get: (key) => window.localStorage.getItem(key) ?? "",
  set: (key, value) => window.localStorage.setItem(key, value),
  remove: (key) => window.localStorage.removeItem(key)
};

// 唯一接缝：未来接入 Tauri Stronghold 加密后端时，只替换这一行。
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
  SECRET_BACKEND.set(key, trimmedValue);
}

/** 清除持久化密钥。 */
export function removeSecret(key: string): void {
  SECRET_BACKEND.remove(key);
}
