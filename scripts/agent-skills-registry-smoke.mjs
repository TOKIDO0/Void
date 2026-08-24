/**
 * 41 号文档：本地技能注册表函数级冒烟（Node 环境，不进 src 编译图）。
 * 覆盖：合法 manifest 正例 / 坏 JSON / 名字不符 / 缺触发词 / 非法目录名 /
 *       未知字段拒绝 / steps 超限 / 目录不存在空列表 / symlink 目录拒绝。
 * 运行：npx tsx scripts/agent-skills-registry-smoke.mjs
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const scriptDir = path.dirname(fileURL());
function fileURL() {
  return import.meta.url.replace(/^file:\/\/\//, "").replace(/\//g, "\\");
}

const { scanSkillsDirectory } = await import(
  new URL("../server/skills/skillsRegistry.ts", import.meta.url).href
);

const failures = [];
const notes = [];

const validManifest = {
  name: "ai-news-daily",
  version: "1.0.0",
  description: "生成一页 AI 新闻速览报告。",
  triggers: ["AI 日报", "科技早报"],
  requiredTools: ["browser.search", "file.writeText"],
  steps: ["检索当天 AI 要闻，挑 5 条。", "整理成一页报告并保存。"],
  boundaries: ["不下载大文件"]
};

function writeSkill(root, directoryName, content) {
  mkdirSync(path.join(root, directoryName), { recursive: true });
  writeFileSync(path.join(root, directoryName, "void-skill.json"), content, "utf8");
}

const skillsRoot = mkdtempSync(path.join(tmpdir(), "void-skills-smoke-"));
try {
  writeSkill(skillsRoot, "ai-news-daily", JSON.stringify(validManifest));
  writeSkill(skillsRoot, "broken-json", "{ not json");
  writeSkill(skillsRoot, "name-mismatch", JSON.stringify({ ...validManifest, name: "other-name" }));
  writeSkill(
    skillsRoot,
    "missing-triggers",
    JSON.stringify({ ...validManifest, name: "missing-triggers", triggers: undefined })
  );
  // steps 超总量上限：12 条 × 300+ 字符
  const longStep = "很".repeat(301);
  writeSkill(
    skillsRoot,
    "steps-too-long",
    JSON.stringify({
      ...validManifest,
      name: "steps-too-long",
      triggers: ["长剧本"],
      steps: Array.from({ length: 12 }, () => longStep)
    })
  );
  // 未知字段（藏可执行载荷）必须被拒
  writeSkill(
    skillsRoot,
    "unknown-field",
    JSON.stringify({ ...validManifest, name: "unknown-field", script: "evil()" })
  );
  // 非法目录名（大写/下划线不符合命名规则）
  writeSkill(
    skillsRoot,
    "Unknown_Name",
    JSON.stringify({ ...validManifest, name: "Unknown_Name" })
  );
  // 非法目录名
  try {
    symlinkSync(path.join(skillsRoot, "ai-news-daily"), path.join(skillsRoot, "linked-skill"), "junction");
  } catch {
    // 无权限创建 junction 时跳过该项
  }

  const result = scanSkillsDirectory(skillsRoot);
  const entryByName = new Map(result.skills.map((entry) => [entry.name, entry]));

  const validEntry = entryByName.get("ai-news-daily");
  if (
    result.status !== "ok"
    || validEntry?.status !== "valid"
    || validEntry.requiredTools.join(",") !== "browser.search,file.writeText"
    || validEntry.steps.length !== 2
    || validEntry.triggers.length !== 2
    || validEntry.boundaries[0] !== "不下载大文件"
  ) {
    failures.push(`R1 合法 manifest 应完整解析为 valid，实际 ${JSON.stringify(validEntry)}`);
  } else {
    notes.push("R1 正例通过：合法 manifest 完整解析，字段/触发词/步骤/边界一致");
  }

  const invalidExpectations = [
    ["broken-json", /JSON/],
    ["name-mismatch", /一致/],
    ["missing-triggers", /triggers/],
    ["steps-too-long", /3600|steps/u],
    ["unknown-field", /未知字段/],
    ["Unknown_Name", /命名规则/]
  ];
  for (const [directoryName, pattern] of invalidExpectations) {
    const entry = entryByName.get(directoryName);
    if (entry?.status !== "invalid" || !pattern.test(entry.reason)) {
      failures.push(`负例 ${directoryName} 应 invalid 且原因匹配 ${pattern}，实际 ${JSON.stringify(entry)}`);
    }
  }
  if (entryByName.has("linked-skill") && entryByName.get("linked-skill")?.status !== "invalid") {
    failures.push("junction 技能目录应被拒绝");
  }

  if (!failures.some((message) => message.startsWith("负例"))) {
    notes.push("R2 负例通过：坏 JSON/名字不符/缺触发词/steps 超限/未知字段/非法目录名均 invalid + 中文原因");
  }

  const missingResult = scanSkillsDirectory(path.join(tmpdir(), `void-skills-absent-${Date.now()}`));
  if (missingResult.status !== "ok" || missingResult.skills.length !== 0) {
    failures.push("R3 目录不存在应返回空列表而非抛错");
  } else {
    notes.push("R3 缺省语义通过：目录不存在时为空列表（默认禁用、如实说明）");
  }
} finally {
  rmSync(skillsRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error("[agent-skills-registry-smoke] FAILED");
  for (const failure of failures) {
    console.error(` - ${failure}`);
  }
  process.exit(1);
}

console.log("[agent-skills-registry-smoke] PASSED");
for (const note of notes) {
  console.log(` - ${note}`);
}
