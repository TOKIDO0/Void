import { listMemories } from "../../memory/memoryStore";

/**
 * 办公模板偏好读取：唯一真源为 memoryStore 的 preference 分区。
 * 供 file.createExcel/Pptx/Docx 在 templateId 缺省时自动补齐，保持“用户说喜欢深色则后续都深色”。
 * 纯函数零副作用：无偏好时返回 undefined，交由服务端 hint 自适应。
 */
export type OfficeTemplatePreference = "void-dark" | "void-light" | "void-vivid";

export function resolveOfficeTemplateFromText(preferenceText: string, hint?: string): OfficeTemplatePreference | undefined {
  const text = (preferenceText ?? "").toLowerCase();
  if (text.includes("深色") || (text.includes("深") && !text.includes("加深")) || text.includes("dark") || text.includes("黑色") || text.includes("暗色")) {
    return "void-dark";
  }
  if (text.includes("浅色") || text.includes("浅") || text.includes("light") || text.includes("亮色") || text.includes("白色")) {
    return "void-light";
  }
  if (text.includes("活力") || text.includes("鲜艳") || text.includes("vivid") || text.includes("彩色")) {
    return "void-vivid";
  }
  const lowerHint = (hint ?? "").toLowerCase();
  if (lowerHint.includes("游戏") || lowerHint.includes("game") || lowerHint.includes("活力") || lowerHint.includes("vivid")) {
    return "void-vivid";
  }
  return undefined;
}

export function resolveOfficeTemplatePreferenceFromMemory(hint?: string): OfficeTemplatePreference | undefined {
  try {
    const prefs = listMemories().filter((m) => m.memoryType === "preference");
    const text = prefs.map((m) => m.content).join(" ");
    return resolveOfficeTemplateFromText(text, hint);
  } catch {
    return undefined;
  }
}
