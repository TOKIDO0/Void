/**
 * 附件文档本地抽取（PDF / DOCX → 纯文本）。
 *
 * 定位：DeepSeek 等纯文本模型无法读文档，行业通行做法（Cherry Studio 等客户端同款）是
 * 上传阶段在本地抽出文本再随消息发送；Anthropic 原生 PDF document 块由对话层按能力判定另行处理。
 *
 * 依赖（36 号方案 D.4，已获用户许可、精确锁版）：
 *   - pdfjs-dist@4.10.38：浏览器端 PDF 文本层抽取；
 *   - mammoth@1.11.0：DOCX → 纯文本。
 */
import * as pdfjs from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import mammoth from "mammoth/mammoth.browser";

// pdf.js 必须显式指定 worker 入口；用 Vite 的 ?url 资源导入保证打包后路径正确。
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** 单份文档抽取文本上限（字符）：超出截断并附提示，防止撑爆模型上下文。 */
const MAX_EXTRACTED_CHARACTERS = 48000;

export type DocumentExtractionResult =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; message: string };

/** PDF → 纯文本。扫描件（无文本层）会得到空文本，返回明确错误。 */
export async function extractPdfText(fileData: ArrayBuffer): Promise<DocumentExtractionResult> {
  try {
    const pdfDocument = await pdfjs.getDocument({ data: fileData }).promise;
    const pageTexts: string[] = [];
    let totalCharacters = 0;
    let truncated = false;

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      if (totalCharacters >= MAX_EXTRACTED_CHARACTERS) {
        truncated = true;
        break;
      }

      const page = await pdfDocument.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      if (pageText) {
        pageTexts.push(pageText);
        totalCharacters += pageText.length;
      }
    }

    await pdfDocument.destroy();

    const combinedText = pageTexts.join("\n\n").slice(0, MAX_EXTRACTED_CHARACTERS);
    if (!combinedText.trim()) {
      return {
        ok: false,
        message: "这份 PDF 没有可提取的文字层（可能是扫描件），当前模型无法读取；请换视觉模型或提供文字版。"
      };
    }

    return { ok: true, text: combinedText, truncated: truncated || combinedText.length >= MAX_EXTRACTED_CHARACTERS };
  } catch {
    return { ok: false, message: "PDF 解析失败，文件可能已损坏或加密。" };
  }
}

/** DOCX → 纯文本。 */
export async function extractDocxText(fileData: ArrayBuffer): Promise<DocumentExtractionResult> {
  try {
    const result = await mammoth.extractRawText({ arrayBuffer: fileData });
    const text = result.value.replace(/\n{3,}/g, "\n\n").trim();
    if (!text) {
      return { ok: false, message: "这份 DOCX 没有可提取的文字内容。" };
    }

    const truncated = text.length > MAX_EXTRACTED_CHARACTERS;
    return { ok: true, text: truncated ? text.slice(0, MAX_EXTRACTED_CHARACTERS) : text, truncated };
  } catch {
    return { ok: false, message: "DOCX 解析失败，文件可能已损坏或不是有效的 Word 文档。" };
  }
}

/** 组装抽取结果为附件文本内容（截断时附提示，避免模型误以为读到了全文）。 */
export function buildExtractedAttachmentContent(result: Extract<DocumentExtractionResult, { ok: true }>) {
  return result.truncated
    ? `${result.text}\n\n（注：文档过长，以上为截断后的前段内容）`
    : result.text;
}
