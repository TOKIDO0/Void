/**
 * 将自然语言中的软件名匹配到目录项。
 * 只做目录匹配，不做下载；多命中时返回 ambiguous，避免猜错软件。
 */

import { listSoftwareCatalog } from "./softwareCatalog";
import type { SoftwareCatalogEntry, SoftwareMatchResult } from "./softwareTypes";

function normalizeQuery(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[（）()【】\[\]「」"'`]/g, "");
}

/**
 * 从用户句子中尽量抽出软件名片段（去掉下载/安装等动作词）。
 */
export function extractSoftwareQuery(userInput: string): string {
  const raw = userInput.trim();
  if (!raw) {
    return "";
  }

  // 去掉常见动作与包装词，保留可能的产品名
  const stripped = raw
    .replace(
      /(?:请|帮我|给我|麻烦|想|要|需要)?(?:下载|获取|装|安装|拉取|保存)?(?:一下|一个|下)?/g,
      " "
    )
    .replace(
      /(?:的)?(?:官方)?(?:Windows|windows|win10|win11|电脑版|桌面版|客户端|安装包|软件|程序|应用)/gi,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();

  return stripped || raw;
}

export function matchSoftwareCatalog(userInput: string): SoftwareMatchResult {
  const query = extractSoftwareQuery(userInput);
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) {
    return { kind: "none", query: userInput.trim() };
  }

  const hits: Array<{ entry: SoftwareCatalogEntry; matchedAlias: string; score: number }> = [];

  for (const entry of listSoftwareCatalog()) {
    const candidates = [entry.displayName, entry.softwareId, ...entry.aliases];
    for (const alias of candidates) {
      const normalizedAlias = normalizeQuery(alias);
      if (!normalizedAlias) {
        continue;
      }
      if (
        normalizedQuery === normalizedAlias
        || normalizedQuery.includes(normalizedAlias)
        || normalizedAlias.includes(normalizedQuery)
      ) {
        // 更长别名命中优先，减少「B」误伤等短串
        hits.push({
          entry,
          matchedAlias: alias,
          score: normalizedAlias.length
        });
        break;
      }
    }
  }

  if (!hits.length) {
    return { kind: "none", query };
  }

  hits.sort((left, right) => right.score - left.score);
  const bestScore = hits[0].score;
  const top = hits.filter((item) => item.score === bestScore);
  const uniqueIds = new Set(top.map((item) => item.entry.softwareId));
  if (uniqueIds.size > 1) {
    return {
      kind: "ambiguous",
      query,
      candidates: top.map((item) => item.entry)
    };
  }

  return {
    kind: "matched",
    entry: top[0].entry,
    matchedAlias: top[0].matchedAlias
  };
}
