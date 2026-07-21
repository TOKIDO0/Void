// VOID 记忆全文索引（M3）
// 唯一 owner：在分区候选集内按文本相关度排序；不做意图判定、不写库、不投影。
// 引擎：@orama/orama 全文检索 + 中文双字 n-gram tokenizer（M4 再填向量槽，本阶段不启用 embedding）。
// 对外接口与 M1 对齐，memoryStore / memoryRetriever 无需改形状。

import {
  count,
  create,
  insert,
  remove,
  search,
  type AnyOrama,
  type Results,
  type Tokenizer
} from "@orama/orama";
import type { MemoryEntry } from "./memoryTypes";
import { MEMORY_TYPE_LABELS } from "./memoryTypes";

export type MemorySearchHit = {
  id: string;
  score: number;
};

/** 索引文档 schema：全文可搜字段 + 元数据；embedding 留给 M4，本阶段不建向量字段。 */
const MEMORY_SEARCH_SCHEMA = {
  id: "string",
  content: "string",
  subjectName: "string",
  typeLabel: "string",
  /** 组合字段，便于字段加权与换说法命中 */
  searchText: "string",
  memoryType: "string"
} as const;

type MemorySearchDocument = {
  id: string;
  content: string;
  subjectName: string;
  typeLabel: string;
  searchText: string;
  memoryType: string;
};

/** 进程内单例 Orama 库；条目量小时允许全量重建。 */
let memorySearchDb: AnyOrama | null = null;
/** 与索引同步的条目快照，用于 candidate 过滤、重叠校验与重建。 */
const indexedEntriesById = new Map<string, MemoryEntry>();

/**
 * 用当前全量合法条目重建索引。
 * 空数组会清空索引，保证 clear 后不会搜到脏数据。
 */
export function rebuildMemorySearchIndex(entries: MemoryEntry[]): void {
  const db = createEmptyDb();
  indexedEntriesById.clear();

  for (const entry of entries) {
    const document = toIndexedDocument(entry);
    insert(db, document);
    indexedEntriesById.set(entry.id, entry);
  }

  memorySearchDb = db;
}

/** 单条写入/更新后同步：M3 数据量小，直接基于现有快照重建。 */
export function syncMemorySearchIndexAfterUpsert(entry: MemoryEntry): void {
  indexedEntriesById.set(entry.id, entry);
  rebuildMemorySearchIndex(Array.from(indexedEntriesById.values()));
}

export function syncMemorySearchIndexAfterRemove(id: string): void {
  if (!indexedEntriesById.delete(id)) {
    return;
  }
  // 有现成库时优先增量删；失败则全量重建
  const db = memorySearchDb;
  if (db) {
    try {
      remove(db, id);
      return;
    } catch {
      // 增量删失败则回退全量重建
    }
  }
  rebuildMemorySearchIndex(Array.from(indexedEntriesById.values()));
}

export function clearMemorySearchIndex(): void {
  indexedEntriesById.clear();
  memorySearchDb = createEmptyDb();
}

/**
 * 仅在 candidateIds 白名单内按 query 相关度排序。
 * - 分区门禁必须由调用方先算好 candidates，本函数绝不扩召回范围。
 * - Orama 命中后再做 token 重叠校验，避免 OR 模式下公共字/标签噪声。
 * - 索引异常或无命中时返回空数组，由 retriever 回退 confidence/时间排序。
 */
export function searchMemoriesInCandidates(
  query: string,
  candidateIds: readonly string[],
  limit: number
): MemorySearchHit[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery || limit <= 0 || candidateIds.length === 0) {
    return [];
  }

  const db = memorySearchDb;
  if (!db || count(db) === 0) {
    return [];
  }

  const candidateIdSet = new Set(candidateIds);
  const queryTokens = collectMeaningfulTokens(normalizedQuery);
  if (queryTokens.size === 0) {
    return [];
  }

  try {
    const rawResults = search(db, {
      term: normalizedQuery,
      // 中文多 token：threshold=1 近似 OR，提升换说法命中；假阳性靠下方重叠过滤
      threshold: 1,
      // 关闭编辑距离：n-gram 不需要 fuzzy，避免短 token 误匹配
      tolerance: 0,
      limit: Math.max(limit * 8, 24),
      properties: ["content", "subjectName", "typeLabel", "searchText"],
      boost: {
        content: 3,
        subjectName: 1.5,
        typeLabel: 0.5,
        searchText: 2
      }
    });

    // 默认组件为同步路径；若异常返回 Promise 则降级空结果，避免拖垮对话
    if (!rawResults || typeof (rawResults as { then?: unknown }).then === "function") {
      return [];
    }

    const syncResults = rawResults as Results<MemorySearchDocument>;
    const hits: MemorySearchHit[] = [];
    for (const hit of syncResults.hits) {
      const id = String(hit.id);
      if (!candidateIdSet.has(id)) {
        continue;
      }

      const entry = indexedEntriesById.get(id);
      if (!entry || !hasTokenOverlap(queryTokens, entry)) {
        continue;
      }

      hits.push({ id, score: hit.score });
      if (hits.length >= limit) {
        break;
      }
    }
    return hits;
  } catch {
    // 索引异常时静默降级，避免拖垮对话主路径
    return [];
  }
}

/** 索引是否已完成至少一次构建（含空库）。 */
export function isMemorySearchIndexReady(): boolean {
  return memorySearchDb !== null;
}

function createEmptyDb(): AnyOrama {
  return create({
    schema: MEMORY_SEARCH_SCHEMA,
    // 自定义 tokenizer：中英文统一 n-gram / 词切，不依赖 Orama 内置语言包
    components: {
      tokenizer: createChineseNgramTokenizer()
    }
  });
}

/** Orama tokenizer：把任意字段文本转成 n-gram token 数组。 */
function createChineseNgramTokenizer(): Tokenizer {
  return {
    // language 标签仅满足接口；实际切词不走 stemmer / 英文 split
    language: "english",
    normalizationCache: new Map<string, string>(),
    tokenize(raw: string): string[] {
      if (typeof raw !== "string" || !raw) {
        return [];
      }
      const tokenized = buildSearchText(raw);
      if (!tokenized) {
        return [];
      }
      return tokenized.split(/\s+/).filter(Boolean);
    }
  };
}

function toIndexedDocument(entry: MemoryEntry): MemorySearchDocument {
  const content = entry.content.trim();
  const subjectName = entry.subjectName.trim();
  const typeLabel = MEMORY_TYPE_LABELS[entry.memoryType];
  // 各字段存原文，由 Orama tokenizer 统一 n-gram；searchText 仅作组合字段加权
  return {
    id: entry.id,
    content,
    subjectName,
    typeLabel,
    searchText: `${content} ${subjectName} ${typeLabel}`.trim(),
    memoryType: entry.memoryType
  };
}

/** 查询与条目是否共享至少一个「有意义」token（长度≥2 或拉丁词）。 */
function hasTokenOverlap(queryTokens: Set<string>, entry: MemoryEntry): boolean {
  const typeLabel = MEMORY_TYPE_LABELS[entry.memoryType];
  const entryTokens = collectMeaningfulTokens(
    `${entry.content} ${entry.subjectName} ${typeLabel}`
  );
  for (const token of queryTokens) {
    if (entryTokens.has(token)) {
      return true;
    }
  }
  return false;
}

/** 提取用于重叠校验的 token 集合。 */
function collectMeaningfulTokens(text: string): Set<string> {
  const tokens = buildSearchText(text)
    .split(/\s+/)
    .filter((token) => token.length >= 2 || /^[a-z0-9_]+$/i.test(token));
  return new Set(tokens);
}

/**
 * 把任意文本转成检索用 token 串：
 * - CJK：连续双字 n-gram；单独一字才保留单字（避免全库单字 OR 噪声）
 * - Latin/数字：按非字母数字切词
 */
export function buildSearchText(text: string): string {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return "";
  }

  const tokens: string[] = [];
  let latinBuffer = "";
  let cjkRun = "";

  const flushLatin = () => {
    if (latinBuffer) {
      tokens.push(latinBuffer);
      latinBuffer = "";
    }
  };

  const flushCjk = () => {
    if (!cjkRun) {
      return;
    }
    if (cjkRun.length === 1) {
      tokens.push(cjkRun);
    } else {
      for (let index = 0; index < cjkRun.length - 1; index += 1) {
        tokens.push(cjkRun.slice(index, index + 2));
      }
    }
    cjkRun = "";
  };

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (/[\s\p{P}\p{S}]/u.test(char)) {
      flushLatin();
      flushCjk();
      continue;
    }

    if (/[㐀-鿿]/.test(char)) {
      flushLatin();
      cjkRun += char;
      continue;
    }

    if (/[a-z0-9_]/i.test(char)) {
      flushCjk();
      latinBuffer += char;
      continue;
    }

    flushLatin();
    flushCjk();
  }

  flushLatin();
  flushCjk();
  return tokens.join(" ");
}
