import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

/** 本地 STT 模型名（阶段 3 选定）。 */
export const VOICE_STT_MODEL_NAME = "sherpa-onnx-streaming-paraformer-bilingual-zh-en";

export const VOICE_STT_MODEL_DIR_ENV = "VOID_STT_MODEL_DIR";

export type VoiceSttModelFiles = {
  encoder: string;
  decoder: string;
  tokens: string;
};

export type VoiceSttModelStatus =
  | { state: "ready"; dir: string; files: VoiceSttModelFiles; totalBytes: number }
  | { state: "missing"; dir: string; reason: string }
  | { state: "invalid"; dir: string; reason: string };

/**
 * 模型目录解析顺序：
 * 1. VOID_STT_MODEL_DIR（联调/用户自定义）
 * 2. 安装包资源目录：cwd 为 <resourceDir>/sidecar-app，模型在 <resourceDir>/voice/stt/<name>
 * 3. 本机运行时目录：D:\AI\void-runtime\models\stt\<name>
 */
export function resolveVoiceSttModelDir(): string {
  const fromEnv = process.env[VOICE_STT_MODEL_DIR_ENV]?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const bundled = join(process.cwd(), "..", "voice", "stt", VOICE_STT_MODEL_NAME);
  if (existsSync(bundled)) {
    return bundled;
  }
  const runtimeRoot = process.env.VOID_RUNTIME_ROOT?.trim() || "D:\\AI\\void-runtime";
  return join(runtimeRoot, "models", "stt", VOICE_STT_MODEL_NAME);
}

export function inspectVoiceSttModel(dir = resolveVoiceSttModelDir()): VoiceSttModelStatus {
  if (!existsSync(dir)) {
    return { state: "missing", dir, reason: "模型目录不存在" };
  }

  const files: VoiceSttModelFiles = {
    encoder: join(dir, "encoder.int8.onnx"),
    decoder: join(dir, "decoder.int8.onnx"),
    tokens: join(dir, "tokens.txt")
  };

  const missing = Object.entries(files).find(([, path]) => !existsSync(path));
  if (missing) {
    return { state: "missing", dir, reason: `缺少模型文件：${missing[0]}` };
  }

  let totalBytes = 0;
  for (const path of Object.values(files)) {
    const size = statSync(path).size;
    if (size <= 0) {
      return { state: "invalid", dir, reason: "模型文件为空" };
    }
    totalBytes += size;
  }

  return { state: "ready", dir, files, totalBytes };
}
