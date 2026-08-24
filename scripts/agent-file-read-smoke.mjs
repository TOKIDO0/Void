import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function expectFileErrorAsync(work, expectedCode) {
  try {
    await work();
  } catch (error) {
    assert(error?.fileCode === expectedCode, `期望 ${expectedCode}，实际 ${error?.fileCode}`);
    return;
  }
  throw new Error(`预期失败 ${expectedCode}，实际成功`);
}

function createSimplePdfBuffer(text) {
  const safeText = text.replace(/[()\\]/g, "\\$&");
  const stream = `BT /F1 24 Tf 100 700 Td (${safeText}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

async function createSimpleDocxBuffer(text) {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  );
  zip.folder("_rels").file(
    ".rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  );
  zip.folder("word").file(
    "document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p></w:body>
</w:document>`
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

function escapeXml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function main() {
  const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), "void-file-read-root-"));
  const outsideRoot = mkdtempSync(path.join(os.tmpdir(), "void-file-read-outside-"));
  process.env.VOID_RUNTIME_ROOT = runtimeRoot;
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  try {
    const sampleDirectory = path.join(runtimeRoot, "samples");
    mkdirSync(path.join(sampleDirectory, "child"), { recursive: true });
    const textPath = path.join(sampleDirectory, "notes.txt");
    const nestedTextPath = path.join(sampleDirectory, "child", "nested.md");
    const pdfPath = path.join(sampleDirectory, "brief.pdf");
    const docxPath = path.join(sampleDirectory, "brief.docx");
    writeFileSync(textPath, "第一行\nVOID UTF-8 sample\n", "utf8");
    writeFileSync(nestedTextPath, "child VOID needle\n", "utf8");
    writeFileSync(pdfPath, createSimplePdfBuffer("VOID PDF sample"));
    writeFileSync(docxPath, await createSimpleDocxBuffer("VOID DOCX sample"));
    writeFileSync(path.join(sampleDirectory, ".env"), "VOID_SECRET=do-not-surface\n", "utf8");
    writeFileSync(path.join(sampleDirectory, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(path.join(sampleDirectory, "invalid.txt"), Buffer.from([0xc3, 0x28]));
    writeFileSync(path.join(sampleDirectory, "large.txt"), Buffer.alloc(1024 * 1024 + 1, 0x61));
    const outsideText = path.join(outsideRoot, "secret.txt");
    writeFileSync(outsideText, "outside", "utf8");
    const { fileAccessManager } = await import(
      pathToFileURL(path.join(projectRoot, "server/file/fileAccessManager.ts")).href
    );
    const { fileDownloadManager } = await import(
      pathToFileURL(path.join(projectRoot, "server/file/fileDownloadManager.ts")).href
    );

    const listed = fileAccessManager.listDirectory(sampleDirectory);
    assert(listed.entries.some((entry) => entry.name === "notes.txt"), "目录应包含 notes.txt");
    assert(listed.entries.some((entry) => entry.name === "child" && entry.kind === "directory"), "应列出一层子目录但不递归");
    const read = await fileAccessManager.readText(textPath);
    assert(read.content.includes("VOID UTF-8 sample"), "应读取严格 UTF-8 文本");
    assert(read.sourceKind === "text", "纯文本 sourceKind 应为 text");
    const pdfRead = await fileAccessManager.readText(pdfPath);
    assert(pdfRead.sourceKind === "pdf" && pdfRead.content.includes("VOID PDF sample"), "应抽取 PDF 文本层");
    const docxRead = await fileAccessManager.readText(docxPath);
    assert(docxRead.sourceKind === "docx" && docxRead.content.includes("VOID DOCX sample"), "应抽取 DOCX 文本");
    assert(fileDownloadManager.verify(textPath).exists, "file.verify 应复用同一允许根策略");

    const escapeLink = path.join(sampleDirectory, "escape");
    symlinkSync(outsideRoot, escapeLink, "junction");
    const searched = fileAccessManager.searchText({
      path: sampleDirectory,
      query: "VOID",
      maxResults: 10,
      extensions: ["txt", "md"]
    });
    assert(searched.matchCount === 2, `全文搜索应返回 2 条匹配，实际 ${searched.matchCount}`);
    assert(searched.filesMatched === 2, `全文搜索应命中 2 个文件，实际 ${searched.filesMatched}`);
    assert(searched.matches.some((entry) => entry.fileName === "notes.txt"), "全文搜索应命中 notes.txt");
    assert(searched.matches.some((entry) => entry.fileName === "nested.md"), "全文搜索应命中子目录 md");
    assert(!searched.matches.some((entry) => entry.fileName === ".env"), "全文搜索不应返回 .env 内容");
    assert(searched.skipped.hiddenSensitive >= 1, "全文搜索应跳过敏感隐藏文件");
    assert(searched.skipped.symbolicLinks >= 1, "全文搜索应跳过符号链接/junction");
    await expectFileErrorAsync(() => fileAccessManager.readText(outsideText), "PATH_NOT_ALLOWED");
    await expectFileErrorAsync(() => fileAccessManager.searchText({ path: outsideRoot, query: "VOID" }), "PATH_NOT_ALLOWED");
    await expectFileErrorAsync(() => fileAccessManager.readText(path.join(escapeLink, "secret.txt")), "PATH_NOT_ALLOWED");
    await expectFileErrorAsync(() => fileAccessManager.readText(path.join(sampleDirectory, "binary.bin")), "BINARY_FILE");
    await expectFileErrorAsync(() => fileAccessManager.readText(path.join(sampleDirectory, "invalid.txt")), "INVALID_UTF8");
    await expectFileErrorAsync(() => fileAccessManager.readText(path.join(sampleDirectory, "large.txt")), "FILE_TOO_LARGE");

    console.log("[agent-file-read-smoke] PASSED");
    console.log(" - 单层目录/UTF-8/PDF/DOCX/全文搜索成功；根外/链接逃逸/二进制/非法 UTF-8/超限均拒绝");
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("[agent-file-read-smoke] FAILED", error);
  process.exitCode = 1;
});
