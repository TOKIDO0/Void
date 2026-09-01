import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  convertInchesToTwip
} from "docx";
import type { DocxTemplate } from "./docxTemplates";

export type DocxSectionInput = {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
  table?: { headers: string[]; rows: (string | number)[][]; caption?: string };
  quote?: string;
};

export type DocxGenerateInput = {
  title: string;
  subtitle?: string;
  sections: DocxSectionInput[];
  template: DocxTemplate;
  author?: string;
};

function sanitize(text: string, max = 200): string {
  return text.trim().slice(0, max) || "—";
}

function hexColor(hex: string): string {
  return hex.replace(/^#/, "").toUpperCase();
}

export async function generateDocxBuffer(input: DocxGenerateInput): Promise<Buffer> {
  const t = input.template;
  const title = sanitize(input.title, 80);
  const subtitle = input.subtitle ? sanitize(input.subtitle, 120) : "VOID 智能整理 · 仅作参考";

  const children: Paragraph[] = [];

  // 封面
  children.push(
    new Paragraph({ spacing: { before: 2400 }, children: [] }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: title, bold: true, size: 56, color: hexColor(t.headingColor), font: "Microsoft YaHei" })],
      spacing: { after: 160 }
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ text: "—", color: hexColor(t.accent), size: 20 }),
        new TextRun({ text: "  ", size: 20 }),
        new TextRun({ text: subtitle, italics: true, color: hexColor(t.bodyColor), size: 18, font: "Calibri" })
      ],
      spacing: { after: 200 }
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: new Date().toLocaleDateString("zh-CN"), color: hexColor(t.bodyColor), size: 16, font: "Calibri" })],
      spacing: { after: 400 }
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [],
      border: { bottom: { color: hexColor(t.accent), space: 1, style: BorderStyle.SINGLE, size: 6 } }
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: "数据综合公开来源，仅作趋势参考", italics: true, color: "94A3B8", size: 14, font: "Calibri" })],
      spacing: { after: 600 }
    })
  );

  // 章节
  for (let idx = 0; idx < input.sections.length; idx++) {
    const s = input.sections[idx];
    const heading = sanitize(s.heading, 80);
    // 章节标题
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 400, after: 120 },
        shading: { type: ShadingType.CLEAR, color: "auto", fill: hexColor(t.accent) },
        border: { left: { color: hexColor(t.accent), space: 8, style: BorderStyle.SINGLE, size: 12 } },
        indent: { left: convertInchesToTwip(0.12) },
        children: [new TextRun({ text: heading, bold: true, size: 26, color: hexColor(t.headingColor), font: "Microsoft YaHei" })]
      }),
      new Paragraph({
        spacing: { after: 180 },
        children: [new TextRun({ text: `SECTION ${String(idx + 1).padStart(2, "0")}`, color: hexColor(t.accent2), size: 14, font: "Calibri", allCaps: true })]
      })
    );

    if (s.paragraphs) {
      for (const p of s.paragraphs.slice(0, 8)) {
        children.push(
          new Paragraph({
            spacing: { after: 120, line: 360 },
            alignment: AlignmentType.JUSTIFIED,
            children: [new TextRun({ text: sanitize(p, 600), size: 20, color: hexColor(t.bodyColor), font: "Calibri" })]
          })
        );
      }
    }

    if (s.bullets && s.bullets.length > 0) {
      for (const b of s.bullets.slice(0, 12)) {
        children.push(
          new Paragraph({
            bullet: { level: 0 },
            spacing: { after: 60 },
            indent: { left: convertInchesToTwip(0.25), hanging: convertInchesToTwip(0.18) },
            children: [new TextRun({ text: sanitize(b, 200), size: 19, color: hexColor(t.bodyColor), font: "Calibri" })]
          })
        );
      }
    }

    if (s.quote) {
      children.push(
        new Paragraph({
          spacing: { before: 160, after: 160 },
          indent: { left: convertInchesToTwip(0.2) },
          border: { left: { color: hexColor(t.quoteBorder), space: 8, style: BorderStyle.SINGLE, size: 8 } },
          shading: { type: ShadingType.CLEAR, color: "auto", fill: "F8FAFC" },
          children: [new TextRun({ text: sanitize(s.quote, 300), italics: true, size: 19, color: hexColor(t.bodyColor), font: "Calibri" })]
        })
      );
    }

    if (s.table && s.table.headers.length > 0) {
      if (s.table.caption) {
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 160, after: 80 },
            children: [new TextRun({ text: sanitize(s.table.caption, 80), bold: true, size: 17, color: hexColor(t.headingColor), font: "Calibri" })]
          })
        );
      }
      const cols = s.table.headers.length;
      const colWidth = Math.floor(100 / cols);
      const headerCells = s.table.headers.slice(0, 8).map(
        (h) =>
          new TableCell({
            width: { size: colWidth, type: WidthType.PERCENTAGE },
            shading: { type: ShadingType.CLEAR, color: "auto", fill: hexColor(t.tableHeaderBg) },
            verticalAlign: AlignmentType.CENTER as unknown as never,
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: sanitize(h, 40), bold: true, size: 18, color: hexColor(t.tableHeaderColor), font: "Microsoft YaHei" })]
              })
            ]
          })
      );
      const dataRows = s.table.rows.slice(0, 30).map((row, rIdx) => {
        const bg = rIdx % 2 === 0 ? "FFFFFF" : "F8FAFC";
        return new TableRow({
          children: row.slice(0, cols).map(
            (cell) =>
              new TableCell({
                width: { size: colWidth, type: WidthType.PERCENTAGE },
                shading: { type: ShadingType.CLEAR, color: "auto", fill: bg },
                children: [
                  new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: [new TextRun({ text: String(cell ?? "").slice(0, 80), size: 17, color: hexColor(t.bodyColor), font: "Calibri" })]
                  })
                ]
              })
          )
        });
      });
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [new TableRow({ children: headerCells }), ...dataRows],
          alignment: AlignmentType.CENTER
        }),
        new Paragraph({ spacing: { after: 200 }, children: [] })
      );
    }
  }

  // 页脚说明
  children.push(
    new Paragraph({ spacing: { before: 400 }, children: [] }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      border: { top: { color: hexColor(t.accent), space: 1, style: BorderStyle.SINGLE, size: 3 } },
      spacing: { before: 200 },
      children: [new TextRun({ text: "—  本文档由 VOID 生成，内容仅供参考  —", italics: true, color: "94A3B8", size: 15, font: "Calibri" })]
    })
  );

  const doc = new Document({
    creator: input.author ?? "VOID",
    title,
    description: title,
    sections: [
      {
        properties: {
          page: {
            margin: { top: convertInchesToTwip(0.8), bottom: convertInchesToTwip(0.7), left: convertInchesToTwip(0.9), right: convertInchesToTwip(0.9) }
          }
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [new TextRun({ text: title, color: "94A3B8", size: 14, font: "Calibri", italics: true })]
              })
            ]
          })
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: "VOID  ·  ", color: "94A3B8", size: 14, font: "Calibri" }),
                  new TextRun({ children: [PageNumber.CURRENT], color: "94A3B8", size: 14 }),
                  new TextRun({ text: " / ", color: "94A3B8", size: 14 }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], color: "94A3B8", size: 14 })
                ]
              })
            ]
          })
        },
        children
      }
    ]
  });

  const buffer = await Packer.toBuffer(doc);
  return Buffer.from(buffer);
}
