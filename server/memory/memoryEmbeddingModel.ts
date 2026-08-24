/**
 * VOID 记忆本地 Embedding 模型（M4，bridge/Node 侧唯一 owner）。
 *
 * 职责单一：懒加载本地句向量模型、把文本批量编码成单位向量、进程内缓存已算过的文本。
 * 不做 HTTP、不做召回融合、不碰 localStorage —— 那些分别在 handlers / 前端 ranker 里。
 *
 * 设计要点：
 * - 模型跑在 Node（onnxruntime-node），首次会从 Hugging Face 下载权重。
 * - 模型缓存目录强制指向 D 盘运行时根（D:\AI\void-runtime\models\embeddings），
 *   绝不落 C:\Users\...\.cache（遵守项目「不往 C 盘塞东西」硬约束）。
 * - 模型 ID 钉死为中文检索小模型 bge-small-zh-v1.5 的 Transformers.js ONNX 版；
 *   换模型必须改这里的常量并复核 HF 可达性。
 * - 失败不抛给对话主路径：加载/推理异常由 handlers 兜成降级信号，前端回退纯全文。
 */

import { join } from "node:path";
import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { resolveRuntimeRoot } from "../file/fileRuntimePaths";
import {
  DEFAULT_LOCAL_EMBEDDING_MODEL,
  EMBEDDING_BATCH_MAX_TEXTS
} from "./memoryEmbeddingConfig";

/**
 * bge 系列为「非对称检索」模型：查询侧要加检索指令前缀，被检索文本（记忆内容）不加。
 * 这是官方推荐用法，能提升 query↔passage 的匹配质量。
 */
const BGE_QUERY_INSTRUCTION = "为这个句子生成表示以用于检索相关文章：";

/** 进程内「文本 → 向量」缓存上限；超过则整体清空（记忆条目量小，简单策略足够）。 */
const EMBEDDING_CACHE_MAX_ENTRIES = 4000;

/**
 * 把模型缓存目录指向 D 盘运行时根。
 * @huggingface/transformers 在 Node 下用 env.cacheDir 决定权重落盘位置。
 * 只设一次，且在模块加载时立即生效，保证首次 pipeline() 下载就落 D 盘。
 */
env.cacheDir = join(resolveRuntimeRoot(), "models", "embeddings");
// 允许首次联网从 HF 拉取权重；已缓存后断网仍可用（onnxruntime-node 读本地缓存）。
env.allowRemoteModels = true;

/** 懒加载的推理管道 promise；仅在首次 embed 时触发，避免 bridge 启动就加载大模型。 */
let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

/** 文本→单位向量缓存。键含用途（query/passage）前缀，避免两种前缀串用。 */
const embeddingCache = new Map<string, number[]>();

/** 触发/复用模型加载。首次调用会下载并初始化（较慢），后续直接复用。 */
function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", DEFAULT_LOCAL_EMBEDDING_MODEL);
  }
  return extractorPromise;
}

/** 缓存键：用途 + 原文，保证 query 前缀与 passage 不冲突。 */
function toCacheKey(text: string, isQuery: boolean): string {
  return `${isQuery ? "q" : "p"}:${text}`;
}

/** 查询侧补检索指令前缀；被检索文本原样返回。 */
function toModelInput(text: string, isQuery: boolean): string {
  return isQuery ? `${BGE_QUERY_INSTRUCTION}${text}` : text;
}

/**
 * 把一批文本编码成单位向量（mean pooling + L2 normalize）。
 * - 已缓存的文本直接命中，不重复推理。
 * - 返回顺序与入参 texts 一一对应。
 * - 任一阶段异常直接抛出，由 handlers 兜成降级响应。
 */
export async function embedTexts(texts: string[], isQuery: boolean): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }
  if (texts.length > EMBEDDING_BATCH_MAX_TEXTS) {
    throw new Error(
      `单次编码文本条数超限：${texts.length} > ${EMBEDDING_BATCH_MAX_TEXTS}`
    );
  }

  // 先命中缓存，收集仍需推理的文本及其原始下标。
  const results: (number[] | null)[] = texts.map((text) => {
    const cached = embeddingCache.get(toCacheKey(text, isQuery));
    return cached ? cached : null;
  });

  const pendingIndexes: number[] = [];
  const pendingInputs: string[] = [];
  for (let index = 0; index < texts.length; index += 1) {
    if (results[index] === null) {
      pendingIndexes.push(index);
      pendingInputs.push(toModelInput(texts[index], isQuery));
    }
  }

  if (pendingInputs.length > 0) {
    const extractor = await getExtractor();
    const output = await extractor(pendingInputs, { pooling: "mean", normalize: true });
    // Tensor.tolist() → number[][]，行序与 pendingInputs 一致。
    const vectors = output.tolist() as number[][];

    for (let position = 0; position < pendingIndexes.length; position += 1) {
      const originalIndex = pendingIndexes[position];
      const vector = vectors[position];
      results[originalIndex] = vector;
      writeCache(toCacheKey(texts[originalIndex], isQuery), vector);
    }
  }

  // 到这里所有位置都已填满（命中缓存或刚推理）。
  return results.map((vector) => vector ?? []);
}

/** 写缓存并做朴素容量控制：超上限直接清空重来。 */
function writeCache(key: string, vector: number[]): void {
  if (embeddingCache.size >= EMBEDDING_CACHE_MAX_ENTRIES) {
    embeddingCache.clear();
  }
  embeddingCache.set(key, vector);
}
