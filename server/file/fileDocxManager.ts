import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertAllowedFilePath } from "./filePathPolicy";
import { createFileError, resolveDownloadFinalRoot } from "./fileRuntimePaths";
import { generateDocxBuffer, type DocxSectionInput } from "./docxGenerator";
import { getDocxTemplate, resolveDocxTemplate } from "./docxTemplates";

export type CreateDocxRequest = {
  fileName: string;
  title?: string;
  subtitle?: string;
  sections: DocxSectionInput[];
  templateId?: string;
};

export type CreateDocxData = {
  path: string;
  fileName: string;
  bytes: number;
  sections: number;
  templateId: string;
  writtenAt: number;
};

function sanitizeFileName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw createFileError("INVALID_REQUEST", "fileName 不能为空");
  if (!trimmed.toLowerCase().endsWith(".docx")) throw createFileError("INVALID_REQUEST", "fileName 必须以 .docx 结尾");
  if (trimmed.includes("/") || trimmed.includes("\\") || /[<>:"|?*\x00-\x1F]/.test(trimmed) || /[ .]$/.test(trimmed)) {
    throw createFileError("INVALID_REQUEST", `fileName 非法：${trimmed}`);
  }
  return trimmed;
}

export async function createDocxFile(input: CreateDocxRequest): Promise<CreateDocxData> {
  const fileName = sanitizeFileName(input.fileName);
  if (!input.sections || input.sections.length === 0) throw createFileError("INVALID_REQUEST", "sections 至少需要 1 个");
  if (input.sections.length > 20) throw createFileError("INVALID_REQUEST", "sections 最多 20 个");
  for (const s of input.sections) {
    if (!s.heading || s.heading.trim().length === 0) throw createFileError("INVALID_REQUEST", "每个 section 需 heading");
    if (s.heading.length > 120) throw createFileError("INVALID_REQUEST", "heading 最多 120 字");
    if (s.bullets && s.bullets.length > 12) throw createFileError("INVALID_REQUEST", "bullets 最多 12 项");
    if (s.paragraphs && s.paragraphs.length > 8) throw createFileError("INVALID_REQUEST", "paragraphs 最多 8 段");
    if (s.table) {
      if (!s.table.headers || s.table.headers.length === 0) throw createFileError("INVALID_REQUEST", "table 需 headers");
      if (s.table.headers.length > 8) throw createFileError("INVALID_REQUEST", "table headers 最多 8 列");
      if (s.table.rows.length > 50) throw createFileError("INVALID_REQUEST", "table rows 最多 50 行");
    }
  }
  const template = input.templateId ? getDocxTemplate(input.templateId as never) : resolveDocxTemplate(undefined, input.title ?? input.sections[0]?.heading);
  const title = input.title?.trim() || input.sections[0]?.heading || "VOID 文档";
  const buffer = await generateDocxBuffer({ title, subtitle: input.subtitle, sections: input.sections, template });
  const finalRoot = resolveDownloadFinalRoot();
  const finalPath = join(finalRoot, fileName);
  assertAllowedFilePath(finalPath, { mustExist: false });
  if (existsSync(finalPath)) throw createFileError("DESTINATION_EXISTS", `目标已存在：${finalPath}`, { path: finalPath });
  mkdirSync(dirname(finalPath), { recursive: true });
  writeFileSync(finalPath, buffer);
  return { path: finalPath, fileName, bytes: buffer.length, sections: input.sections.length, templateId: template.id, writtenAt: Date.now() };
}
