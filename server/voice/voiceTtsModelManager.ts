import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

export const VOICE_TTS_MODEL_NAME = "kokoro-multi-lang-v1_0";
export const VOICE_TTS_MODEL_DIR_ENV = "VOID_TTS_MODEL_DIR";

export type VoiceTtsModelFiles = {
  model: string;
  voices: string;
  tokens: string;
  lexicon: string;
  ruleFsts: string[];
};

export type VoiceTtsModelStatus =
  | { state: "ready"; dir: string; files: VoiceTtsModelFiles; totalBytes: number }
  | { state: "missing"; dir: string; reason: string }
  | { state: "invalid"; dir: string; reason: string };

export function resolveVoiceTtsModelDir(): string {
  const fromEnv = process.env[VOICE_TTS_MODEL_DIR_ENV]?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const bundled = join(process.cwd(), "..", "voice", "tts", VOICE_TTS_MODEL_NAME);
  if (existsSync(bundled)) {
    return bundled;
  }
  const devBundled = join(process.cwd(), "src-tauri", "resources", "voice", "tts", VOICE_TTS_MODEL_NAME);
  if (existsSync(devBundled)) {
    return devBundled;
  }
  const runtimeRoot = process.env.VOID_RUNTIME_ROOT?.trim() || "D:\\AI\\void-runtime";
  const phase3 = join(runtimeRoot, "phase3-voice", "models", VOICE_TTS_MODEL_NAME);
  if (existsSync(phase3)) {
    return phase3;
  }
  return join(runtimeRoot, "models", "tts", VOICE_TTS_MODEL_NAME);
}

export function inspectVoiceTtsModel(dir = resolveVoiceTtsModelDir()): VoiceTtsModelStatus {
  if (!existsSync(dir)) {
    return { state: "missing", dir, reason: "TTS 模型目录不存在" };
  }

  const files: VoiceTtsModelFiles = {
    model: join(dir, "model.onnx"),
    voices: join(dir, "voices.bin"),
    tokens: join(dir, "tokens.txt"),
    lexicon: join(dir, "lexicon-zh.txt"),
    ruleFsts: ["number-zh.fst", "date-zh.fst", "phone-zh.fst"].map((name) => join(dir, name))
  };

  for (const [name, path] of [
    ["model", files.model],
    ["voices", files.voices],
    ["tokens", files.tokens],
    ["lexicon", files.lexicon]
  ] as const) {
    if (!existsSync(path)) {
      return { state: "missing", dir, reason: `缺少 TTS 模型文件：${name}` };
    }
  }

  let totalBytes = 0;
  for (const path of [files.model, files.voices, files.tokens, files.lexicon]) {
    const size = statSync(path).size;
    if (size <= 0) {
      return { state: "invalid", dir, reason: "TTS 模型文件为空" };
    }
    totalBytes += size;
  }

  return { state: "ready", dir, files, totalBytes };
}
