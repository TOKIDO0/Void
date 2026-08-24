/**
 * 记忆 Embedding 轻量配置。
 * 不 import transformers，保证 bridge health 与默认启动路径保持轻量。
 */

/** 钉死的本地句向量模型（中文检索强、小、384 维、Transformers.js ONNX 可用）。 */
export const DEFAULT_LOCAL_EMBEDDING_MODEL = "Xenova/bge-small-zh-v1.5";

/** 单次请求可编码的文本条数上限，防止异常调用一次灌入过多文本拖垮进程。 */
export const EMBEDDING_BATCH_MAX_TEXTS = 512;
