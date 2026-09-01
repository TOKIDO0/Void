import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { assertAllowedFilePath } from "./filePathPolicy";
import { createFileError, resolveDownloadFinalRoot } from "./fileRuntimePaths";
import { generateExcelBuffer, type ExcelSheetInput } from "./excelGenerator";
import { getExcelTemplate, resolveExcelTemplate } from "./excelTemplates";

export type CreateExcelRequest = {
  fileName: string;
  sheets: ExcelSheetInput[];
  templateId?: string;
  title?: string;
};

export type CreateExcelData = {
  path: string;
  fileName: string;
  bytes: number;
  sheets: number;
  templateId: string;
  writtenAt: number;
};

function sanitizeFileName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw createFileError("INVALID_REQUEST", "fileName 不能为空");
  if (!trimmed.toLowerCase().endsWith(".xlsx")) throw createFileError("INVALID_REQUEST", "fileName 必须以 .xlsx 结尾");
  if (trimmed.includes("/") || trimmed.includes("\\") || /[<>:"|?*\x00-\x1F]/.test(trimmed) || /[ .]$/.test(trimmed)) {
    throw createFileError("INVALID_REQUEST", `fileName 非法：${trimmed}`);
  }
  return trimmed;
}

export async function createExcelFile(input: CreateExcelRequest): Promise<CreateExcelData> {
  const fileName = sanitizeFileName(input.fileName);
  if (!input.sheets || input.sheets.length === 0) throw createFileError("INVALID_REQUEST", "sheets 至少需要 1 个");
  if (input.sheets.length > 10) throw createFileError("INVALID_REQUEST", "sheets 最多 10 个");
  for (const sheet of input.sheets) {
    if (!sheet.name || !sheet.headers || sheet.headers.length === 0) throw createFileError("INVALID_REQUEST", "每个 sheet 需 name 与 headers");
    if (sheet.headers.length > 20) throw createFileError("INVALID_REQUEST", "headers 最多 20 列");
    if (sheet.rows.length > 5000) throw createFileError("INVALID_REQUEST", "每个 sheet rows 最多 5000 行");
  }

  const template = input.templateId ? getExcelTemplate(input.templateId as never) : resolveExcelTemplate(undefined, input.sheets[0]?.name);
  const buffer = await generateExcelBuffer({ sheets: input.sheets, template, title: input.title });

  const finalRoot = resolveDownloadFinalRoot();
  const finalPath = join(finalRoot, fileName);
  assertAllowedFilePath(finalPath, { mustExist: false });
  if (existsSync(finalPath)) throw createFileError("DESTINATION_EXISTS", `目标已存在：${finalPath}`, { path: finalPath });

  mkdirSync(dirname(finalPath), { recursive: true });
  writeFileSync(finalPath, buffer);

  return {
    path: finalPath,
    fileName,
    bytes: buffer.length,
    sheets: input.sheets.length,
    templateId: template.id,
    writtenAt: Date.now()
  };
}
