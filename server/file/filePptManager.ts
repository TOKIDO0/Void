import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertAllowedFilePath } from "./filePathPolicy";
import { createFileError, resolveDownloadFinalRoot } from "./fileRuntimePaths";
import { generatePptxBuffer, type PptSlideInput } from "./pptGenerator";
import { getPptTemplate, resolvePptTemplate } from "./pptTemplates";

export type CreatePptxRequest = {
  fileName: string;
  title?: string;
  slides: PptSlideInput[];
  templateId?: string;
};

export type CreatePptxData = {
  path: string;
  fileName: string;
  bytes: number;
  slides: number;
  templateId: string;
  writtenAt: number;
};

function sanitizeFileName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw createFileError("INVALID_REQUEST", "fileName 不能为空");
  if (!trimmed.toLowerCase().endsWith(".pptx")) throw createFileError("INVALID_REQUEST", "fileName 必须以 .pptx 结尾");
  if (trimmed.includes("/") || trimmed.includes("\\") || /[<>:"|?*\x00-\x1F]/.test(trimmed) || /[ .]$/.test(trimmed)) {
    throw createFileError("INVALID_REQUEST", `fileName 非法：${trimmed}`);
  }
  return trimmed;
}

export async function createPptxFile(input: CreatePptxRequest): Promise<CreatePptxData> {
  const fileName = sanitizeFileName(input.fileName);
  if (!input.slides || input.slides.length === 0) throw createFileError("INVALID_REQUEST", "slides 至少需要 1 个");
  if (input.slides.length > 30) throw createFileError("INVALID_REQUEST", "slides 最多 30 个");
  for (const s of input.slides) {
    if (!s.title || s.title.trim().length === 0) throw createFileError("INVALID_REQUEST", "每个 slide 需 title");
    if (s.title.length > 120) throw createFileError("INVALID_REQUEST", "slide title 最多 120 字");
    if (s.bullets && s.bullets.length > 12) throw createFileError("INVALID_REQUEST", "bullets 最多 12 项");
    if (s.chart) {
      if (!s.chart.labels || !s.chart.values || s.chart.labels.length !== s.chart.values.length) throw createFileError("INVALID_REQUEST", "chart labels/values 长度需一致");
      if (s.chart.labels.length > 12) throw createFileError("INVALID_REQUEST", "chart 最多 12 项");
    }
  }
  const template = input.templateId ? getPptTemplate(input.templateId as never) : resolvePptTemplate(undefined, input.title ?? input.slides[0]?.title);
  const title = input.title?.trim() || input.slides[0]?.title || "VOID 演示文稿";
  const buffer = await generatePptxBuffer({ title, slides: input.slides, template });
  const finalRoot = resolveDownloadFinalRoot();
  const finalPath = join(finalRoot, fileName);
  assertAllowedFilePath(finalPath, { mustExist: false });
  if (existsSync(finalPath)) throw createFileError("DESTINATION_EXISTS", `目标已存在：${finalPath}`, { path: finalPath });
  mkdirSync(dirname(finalPath), { recursive: true });
  writeFileSync(finalPath, buffer);
  return { path: finalPath, fileName, bytes: buffer.length, slides: input.slides.length + 1, templateId: template.id, writtenAt: Date.now() };
}
