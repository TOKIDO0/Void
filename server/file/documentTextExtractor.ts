import { extname } from "node:path";
import { createFileError } from "./fileRuntimePaths";

const MAX_DOCUMENT_PAGES = 80;
const MAX_EXTRACTED_CHARACTERS = 200_000;

export type ExtractedDocumentText = {
  content: string;
  characters: number;
  truncated: boolean;
  sourceKind: "pdf" | "docx";
};

export function isSupportedDocumentTextPath(path: string): boolean {
  const extension = extname(path).toLowerCase();
  return extension === ".pdf" || extension === ".docx";
}

export async function extractDocumentText(
  path: string,
  bytes: Buffer
): Promise<ExtractedDocumentText> {
  const extension = extname(path).toLowerCase();
  if (extension === ".pdf") {
    return extractPdfText(bytes);
  }
  if (extension === ".docx") {
    return extractDocxText(bytes);
  }
  throw createFileError("INVALID_REQUEST", `不支持的文档格式：${extension || "无扩展名"}`);
}

async function extractPdfText(bytes: Buffer): Promise<ExtractedDocumentText> {
  let pdfDocument: { numPages: number; getPage: (pageNumber: number) => Promise<unknown>; destroy: () => Promise<void> } | undefined;
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      disableWorker: true
    });
    pdfDocument = await loadingTask.promise;

    const pageLimit = Math.min(pdfDocument.numPages, MAX_DOCUMENT_PAGES);
    const pageTexts: string[] = [];
    let totalCharacters = 0;
    let truncated = pdfDocument.numPages > pageLimit;

    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      if (totalCharacters >= MAX_EXTRACTED_CHARACTERS) {
        truncated = true;
        break;
      }

      const page = await pdfDocument.getPage(pageNumber) as {
        getTextContent: () => Promise<{ items: unknown[] }>;
      };
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item) => {
          const maybeText = item as { str?: unknown };
          return typeof maybeText.str === "string" ? maybeText.str : "";
        })
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      if (pageText) {
        pageTexts.push(pageText);
        totalCharacters += pageText.length;
      }
    }

    const content = limitExtractedText(pageTexts.join("\n\n"));
    if (!content.content.trim()) {
      throw createFileError(
        "UNSUPPORTED_DOCUMENT",
        "这份 PDF 没有可提取的文字层，可能是扫描件或图片 PDF"
      );
    }

    return {
      ...content,
      truncated: truncated || content.truncated,
      sourceKind: "pdf"
    };
  } catch (error) {
    if (typeof error === "object" && error !== null && "fileCode" in error) {
      throw error;
    }
    throw createFileError(
      "UNSUPPORTED_DOCUMENT",
      error instanceof Error ? `PDF 解析失败：${error.message}` : "PDF 解析失败"
    );
  } finally {
    await pdfDocument?.destroy().catch(() => undefined);
  }
}

async function extractDocxText(bytes: Buffer): Promise<ExtractedDocumentText> {
  try {
    const mammothModule = await import("mammoth") as {
      default?: { extractRawText?: (input: { buffer: Buffer }) => Promise<{ value: string }> };
      extractRawText?: (input: { buffer: Buffer }) => Promise<{ value: string }>;
    };
    const extractRawText =
      mammothModule.extractRawText ?? mammothModule.default?.extractRawText;
    if (!extractRawText) {
      throw new Error("mammoth.extractRawText 不可用");
    }

    const result = await extractRawText({ buffer: bytes });
    const normalized = result.value.replace(/\n{3,}/g, "\n\n").trim();
    if (!normalized) {
      throw createFileError("UNSUPPORTED_DOCUMENT", "这份 DOCX 没有可提取的文字内容");
    }
    return {
      ...limitExtractedText(normalized),
      sourceKind: "docx"
    };
  } catch (error) {
    if (typeof error === "object" && error !== null && "fileCode" in error) {
      throw error;
    }
    throw createFileError(
      "UNSUPPORTED_DOCUMENT",
      error instanceof Error ? `DOCX 解析失败：${error.message}` : "DOCX 解析失败"
    );
  }
}

function limitExtractedText(content: string): Omit<ExtractedDocumentText, "sourceKind"> {
  if (content.length <= MAX_EXTRACTED_CHARACTERS) {
    return {
      content,
      characters: content.length,
      truncated: false
    };
  }
  return {
    content: content.slice(0, MAX_EXTRACTED_CHARACTERS),
    characters: MAX_EXTRACTED_CHARACTERS,
    truncated: true
  };
}
