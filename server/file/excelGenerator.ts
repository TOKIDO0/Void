import ExcelJS from "exceljs";
import type { ExcelTemplate } from "./excelTemplates";

export type ExcelSheetInput = {
  name: string;
  headers: string[];
  rows: (string | number)[][];
  chart?: {
    type: "bar" | "pie";
    title: string;
    xColumn: number; // 0-based index of category column
    yColumn: number; // 0-based index of value column
  };
};

export type ExcelGenerateInput = {
  sheets: ExcelSheetInput[];
  template: ExcelTemplate;
  title?: string;
};

function sanitizeSheetName(raw: string): string {
  const cleaned = raw.replace(/[\\/*?:\[\]]/g, "_").trim().slice(0, 31);
  return cleaned || "Sheet1";
}

function calcColumnWidths(headers: string[], rows: (string | number)[][]): number[] {
  const widths = headers.map((h) => String(h).length);
  for (const row of rows) {
    row.forEach((cell, idx) => {
      const len = String(cell ?? "").length;
      if (len > (widths[idx] ?? 10)) widths[idx] = len;
    });
  }
  return widths.map((w) => Math.min(Math.max(w + 4, 12), 40));
}

export async function generateExcelBuffer(input: ExcelGenerateInput): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "VOID";
  workbook.created = new Date();

  for (const sheetInput of input.sheets) {
    const sheetName = sanitizeSheetName(sheetInput.name);
    const worksheet = workbook.addWorksheet(sheetName);

    const headers = sheetInput.headers;
    const rows = sheetInput.rows;

    // 标题行（若有 title，仅首 Sheet 加标题）
    let headerRowIndex = 1;
    if (input.title && workbook.worksheets.length === 1) {
      const titleRow = worksheet.addRow([input.title]);
      titleRow.font = { size: input.template.titleFontSize, bold: true, color: { argb: "FF111827" } };
      titleRow.height = 20;
      worksheet.mergeCells(1, 1, 1, Math.max(headers.length, 1));
      titleRow.alignment = { horizontal: "center", vertical: "middle" };
      headerRowIndex = 2;
    }

    // 表头
    const headerRow = worksheet.addRow(headers);
    headerRow.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: input.template.headerBg } };
      cell.font = { color: { argb: input.template.headerFontColor }, bold: input.template.headerFontBold, size: 11 };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = {
        top: { style: "thin", color: { argb: input.template.borderColor } },
        left: { style: "thin", color: { argb: input.template.borderColor } },
        bottom: { style: "thin", color: { argb: input.template.borderColor } },
        right: { style: "thin", color: { argb: input.template.borderColor } }
      };
    });
    headerRow.height = 18;
    headerRow.commit();

    // 数据行 + 斑马纹
    rows.forEach((row, idx) => {
      const excelRow = worksheet.addRow(row);
      const isEven = idx % 2 === 0;
      const bg = isEven ? input.template.stripeEvenBg : input.template.stripeOddBg;
      excelRow.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bg } };
        cell.border = {
          top: { style: "thin", color: { argb: input.template.borderColor } },
          left: { style: "thin", color: { argb: input.template.borderColor } },
          bottom: { style: "thin", color: { argb: input.template.borderColor } },
          right: { style: "thin", color: { argb: input.template.borderColor } }
        };
        cell.alignment = { vertical: "middle" };
        // 数值右对齐
        if (typeof cell.value === "number") cell.alignment = { horizontal: "right", vertical: "middle" };
      });
      excelRow.height = 16;
      excelRow.commit();
    });

    // 列宽、筛选、冻结
    const widths = calcColumnWidths(headers, rows);
    widths.forEach((w, idx) => {
      const col = worksheet.getColumn(idx + 1);
      col.width = w;
    });
    if (headers.length > 0) {
      worksheet.autoFilter = {
        from: { row: headerRowIndex, column: 1 },
        to: { row: headerRowIndex, column: headers.length }
      };
      worksheet.views = [{ state: "frozen", xSplit: 0, ySplit: headerRowIndex, activeCell: `A${headerRowIndex + 1}` }];
    }

    // 图表：exceljs 图表支持有限，首版以“图表数据区 + 占位说明”保证打开不报错；后续可升级为原生 chart
    if (sheetInput.chart && rows.length > 0) {
      const chartTitle = sheetInput.chart.title || "Chart";
      // 在数据下方空一行后写入图表说明（避免与数据重叠）
      const chartRowIdx = headerRowIndex + rows.length + 3;
      const chartRow = worksheet.getRow(chartRowIdx);
      chartRow.getCell(1).value = `图表：${chartTitle}（${sheetInput.chart.type}）—— 数据区 ${headers[sheetInput.chart.xColumn]} vs ${headers[sheetInput.chart.yColumn]}`;
      chartRow.getCell(1).font = { italic: true, color: { argb: "FF6B7280" }, size: 10 };
      chartRow.commit();
      // 预留：若 exceljs 后续支持 addChart，可在此处插入
      // worksheet.addChart({ ... })
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
