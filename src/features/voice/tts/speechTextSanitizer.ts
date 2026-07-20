/**
 * 从朗读文本中移除链接目标。
 *
 * 显示层仍保留完整链接，便于用户点击；这里只处理送入 TTS 的副本：
 * - Markdown 链接保留可读标题，例如 `[使用说明](https://example.com)` → `使用说明`；
 * - 裸露的 http/https/www 链接整段移除，避免语音逐字符朗读地址。
 */
export function stripLinksForSpeech(text: string) {
  return text
    .replace(/!?\[([^\]\n]*)\]\([^\n)]*\)/g, "$1")
    .replace(/<(?:https?:\/\/|www\.)[A-Za-z0-9\-._~:/?#\[\]@!$&()*+,;=%]+>/gi, "")
    .replace(/(?:https?:\/\/|www\.)[A-Za-z0-9\-._~:/?#\[\]@!$&()*+,;=%]+/gi, "")
    // 链接独占一行时，去掉清洗后残留的无意义标签。
    .replace(/^\s*(?:链接|网址|URL)\s*[：:]?\s*$/gim, "");
}
