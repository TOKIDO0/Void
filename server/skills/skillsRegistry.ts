/**
 * VOID 本地技能底座一期（41 号文档）：任务剧本注册表。
 *
 * 技能 = 本地任务剧本：<runtime-root>/skills/<name>/void-skill.json。
 * 硬边界（对照 S26 requiredFutureBoundaries）：
 *   - 只做只读扫描与结构校验，不加载、不执行任何代码；
 *   - 不跟随符号链接/junction；
 *   - 数量与体积全部有上界，防止无界增长；
 *   - 坏技能标记 invalid + 中文原因，不静默忽略也不整体失败。
 */

import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveRuntimeRoot } from "../file/fileRuntimePaths";

/** 单个技能目录数上限：超出按名称排序截断，防止无界扫描。 */
export const MAX_SKILL_DIRECTORIES = 50;
/** 单个 manifest 文件体积上限。 */
export const MAX_MANIFEST_BYTES = 64 * 1024;

const SKILL_MANIFEST_FILE_NAME = "void-skill.json";
const SKILL_DIRECTORY_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;

export type SkillManifest = {
  name: string;
  version: string;
  description: string;
  triggers: string[];
  requiredTools: string[];
  steps: string[];
  boundaries: string[];
};

export type ValidSkillEntry = SkillManifest & {
  status: "valid";
  manifestPath: string;
  manifestBytes: number;
};

export type InvalidSkillEntry = {
  status: "invalid";
  /** 尝试从 manifest 或目录名取到的标识；解析完全失败时为空串。 */
  name: string;
  manifestPath: string;
  reason: string;
};

export type SkillEntry = ValidSkillEntry | InvalidSkillEntry;

export type SkillsScanResult = {
  status: "ok";
  skillRoot: string;
  scannedDirectoryCount: number;
  truncated: boolean;
  skills: SkillEntry[];
};

export function resolveSkillsRoot(runtimeRoot?: string): string {
  return join(runtimeRoot ?? resolveRuntimeRoot(), "skills");
}

/**
 * 扫描技能根目录下的一层子目录并校验 manifest。
 * 目录不存在 / 为空返回空列表；任何单点失败都不影响其余技能。
 */
export function scanSkillsDirectory(skillRootInput?: string): SkillsScanResult {
  const skillRoot = resolve(skillRootInput ?? resolveSkillsRoot());

  if (!existsSync(skillRoot)) {
    return { status: "ok", skillRoot, scannedDirectoryCount: 0, truncated: false, skills: [] };
  }

  const rootStat = statSync(skillRoot);
  if (!rootStat.isDirectory()) {
    return { status: "ok", skillRoot, scannedDirectoryCount: 0, truncated: false, skills: [] };
  }

  const directoryNames = readdirSync(skillRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const truncated = directoryNames.length > MAX_SKILL_DIRECTORIES;
  const effectiveNames = directoryNames.slice(0, MAX_SKILL_DIRECTORIES);

  const skills: SkillEntry[] = effectiveNames.map((directoryName) =>
    inspectSkillDirectory(skillRoot, directoryName)
  );

  return {
    status: "ok",
    skillRoot,
    scannedDirectoryCount: effectiveNames.length,
    truncated,
    skills
  };
}

function inspectSkillDirectory(skillRoot: string, directoryName: string): SkillEntry {
  const directoryPath = join(skillRoot, directoryName);
  const manifestPath = join(directoryPath, SKILL_MANIFEST_FILE_NAME);

  // 目录名即技能 ID：拒绝大写/中文/路径穿越形态的目录名。
  if (!SKILL_DIRECTORY_NAME_PATTERN.test(directoryName)) {
    return invalid(directoryName, manifestPath, `目录名不符合技能命名规则（小写字母/数字/连字符，≤48 字符）：${directoryName}`);
  }

  let directoryStat;
  try {
    directoryStat = statSync(directoryPath);
  } catch {
    return invalid(directoryName, manifestPath, "无法读取技能目录状态");
  }
  // statSync 对 symlink 返回目标信息；配合 lstat 判定链接本身。
  try {
    if (lstatSync(directoryPath).isSymbolicLink()) {
      return invalid(directoryName, manifestPath, "技能目录不允许是符号链接/junction");
    }
  } catch {
    // lstat 失败不改变主流程；上面 statSync 已确认可读。
  }
  if (!directoryStat.isDirectory()) {
    return invalid(directoryName, manifestPath, "技能路径不是目录");
  }

  if (!existsSync(manifestPath)) {
    return invalid(directoryName, manifestPath, `缺少 ${SKILL_MANIFEST_FILE_NAME}`);
  }

  let raw: Buffer;
  try {
    raw = readFileSync(manifestPath);
  } catch {
    return invalid(directoryName, manifestPath, "manifest 文件无法读取");
  }

  if (raw.byteLength > MAX_MANIFEST_BYTES) {
    return invalid(directoryName, manifestPath, `manifest 超过 ${Math.floor(MAX_MANIFEST_BYTES / 1024)} KiB 上限`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return invalid(directoryName, manifestPath, "manifest 不是合法 JSON");
  }

  const validation = validateSkillManifest(parsed, directoryName);
  if (!validation.valid) {
    return invalid(directoryName, manifestPath, validation.reason);
  }

  return {
    status: "valid",
    ...validation.manifest,
    manifestPath,
    manifestBytes: raw.byteLength
  };
}

type ManifestValidation =
  | { valid: true; manifest: SkillManifest }
  | { valid: false; reason: string };

/**
 * 结构层校验（纯函数）。白名单比对（requiredTools 是否已注册）在前端工具层完成，
 * bridge 不持有工具注册表。
 */
export function validateSkillManifest(parsed: unknown, directoryName: string): ManifestValidation {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { valid: false, reason: "manifest 顶层必须是 JSON 对象" };
  }

  const record = parsed as Record<string, unknown>;

  // 一期严格 schema：未知字段直接拒绝，杜绝把可执行载荷藏进 manifest。
  const allowedKeys = new Set(["name", "version", "description", "triggers", "requiredTools", "steps", "boundaries"]);
  const unknownKeys = Object.keys(record).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    return { valid: false, reason: `manifest 含未知字段：${unknownKeys.join("、")}` };
  }

  const nameError = validateStringField(record.name, "name", 1, 48);
  if (nameError) {
    return { valid: false, reason: nameError };
  }
  if (record.name !== directoryName) {
    return { valid: false, reason: `manifest.name（${String(record.name)}）必须与目录名（${directoryName}）一致` };
  }

  const versionError = validateStringField(record.version, "version", 1, 16);
  if (versionError) {
    return { valid: false, reason: versionError };
  }

  const descriptionError = validateStringField(record.description, "description", 1, 200);
  if (descriptionError) {
    return { valid: false, reason: descriptionError };
  }

  const triggers = validateStringArray(record.triggers, "triggers", 1, 8, 40);
  if (!Array.isArray(triggers)) {
    return { valid: false, reason: triggers };
  }

  const requiredTools = validateStringArray(record.requiredTools, "requiredTools", 1, 10, 80);
  if (!Array.isArray(requiredTools)) {
    return { valid: false, reason: requiredTools };
  }

  const steps = validateStringArray(record.steps, "steps", 1, 12, 300);
  if (!Array.isArray(steps)) {
    return { valid: false, reason: steps };
  }
  const totalStepCharacters = steps.reduce((sum, step) => sum + step.length, 0);
  if (totalStepCharacters > 3600) {
    return { valid: false, reason: "steps 总字数超过 3600 上限" };
  }

  let boundaries: string[] = [];
  if (record.boundaries !== undefined) {
    const boundariesResult = validateStringArray(record.boundaries, "boundaries", 0, 6, 120);
    if (!Array.isArray(boundariesResult)) {
      return { valid: false, reason: boundariesResult };
    }
    boundaries = boundariesResult;
  }

  return {
    valid: true,
    manifest: {
      name: String(record.name),
      version: String(record.version),
      description: String(record.description),
      triggers,
      requiredTools,
      steps,
      boundaries
    }
  };
}

function validateStringField(value: unknown, fieldName: string, minLength: number, maxLength: number): string | null {
  if (typeof value !== "string" || value.trim().length < minLength || value.length > maxLength) {
    return `${fieldName} 必须是 ${minLength}-${maxLength} 字符的字符串`;
  }
  return null;
}

function validateStringArray(
  value: unknown,
  fieldName: string,
  minLength: number,
  maxLength: number,
  itemMaxLength: number
): string[] | string {
  if (!Array.isArray(value)) {
    return `${fieldName} 必须是字符串数组`;
  }
  if (value.length < minLength || value.length > maxLength) {
    return `${fieldName} 数量必须在 ${minLength}-${maxLength} 条之间`;
  }
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0 || item.length > itemMaxLength) {
      return `${fieldName} 的每条必须是 1-${itemMaxLength} 字符的非空字符串`;
    }
  }
  return value as string[];
}

function invalid(name: string, manifestPath: string, reason: string): InvalidSkillEntry {
  return { status: "invalid", name, manifestPath, reason };
}
