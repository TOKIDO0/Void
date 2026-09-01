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
    const worksheet = workbook.addWorksheet(sheetName, {
      properties: { tabColor: { argb: input.template.headerBg } },
      pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
    });

    const headers = sheetInput.headers;
    const rows = sheetInput.rows;

    // 标题区：首 Sheet 追加大标题 + 副标题（日期/来源），营造高阶“留白+层级”
    let headerRowIndex = 1;
    if (input.title && workbook.worksheets.length === 1) {
      const titleRow = worksheet.addRow([input.title]);
      titleRow.font = { name: "Cambria", size: input.template.titleFontSize + 2, bold: true, color: { argb: "FFFFFFFF" } };
      titleRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: input.template.headerBg } };
      titleRow.alignment = { horizontal: "center", vertical: "middle" };
      titleRow.height = 28;
      worksheet.mergeCells(1, 1, 1, Math.max(headers.length, 1));
      titleRow.commit();

      const subtitle = `生成于 ${new Date().toLocaleDateString("zh-CN")} · VOID 智能整理 · 数据仅作参考`;
      const subRow = worksheet.addRow([subtitle]);
      subRow.font = { name: "Calibri", size: 9, italic: true, color: { argb: "FFE5E7EB" } };
      subRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: input.template.headerBg } };
      subRow.alignment = { horizontal: "center", vertical: "middle" };
      subRow.height = 16;
      worksheet.mergeCells(2, 1, 2, Math.max(headers.length, 1));
      subRow.commit();

      // 空隙行
      worksheet.addRow([]);
      headerRowIndex = 4;
    }

    // 表头：Cambria 11pt 白字深底， hairline 边框，居中
    const headerRow = worksheet.addRow(headers);
    headerRow.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: input.template.headerBg } };
      cell.font = { name: "Cambria", color: { argb: input.template.headerFontColor }, bold: input.template.headerFontBold, size: 11 };
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      cell.border = {
        top: { style: "thin", color: { argb: input.template.borderColor } },
        left: { style: "thin", color: { argb: input.template.borderColor } },
        bottom: { style: "medium", color: { argb: input.template.borderColor } },
        right: { style: "thin", color: { argb: input.template.borderColor } }
      };
    });
    headerRow.height = 20;
    headerRow.commit();

    // 数据行：Calibri 10.5pt，斑马纹极淡，hairline 边框，数值右对齐，百分比列自动 % 格式
    const percentColIndexes = headers.map((h, i) => (h.includes("占比") || h.includes("%") ? i : -1)).filter((i) => i >= 0);
    rows.forEach((row, idx) => {
      const excelRow = worksheet.addRow(row);
      const isEven = idx % 2 === 0;
      const bg = isEven ? input.template.stripeEvenBg : input.template.stripeOddBg;
      excelRow.eachCell((cell, colNumber) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bg } };
        cell.font = { name: "Calibri", size: 10.5, color: { argb: "FF1F2937" } };
        cell.border = {
          top: { style: "hair", color: { argb: input.template.borderColor } },
          left: { style: "hair", color: { argb: input.template.borderColor } },
          bottom: { style: "hair", color: { argb: input.template.borderColor } },
          right: { style: "hair", color: { argb: input.template.borderColor } }
        };
        cell.alignment = { vertical: "middle", wrapText: true };
        if (typeof cell.value === "number") {
          // 占比列显示为 22% 而非 22
          if (percentColIndexes.includes(colNumber - 1)) {
            cell.numFmt = '0"%"';
            cell.alignment = { horizontal: "center", vertical: "middle" };
          } else {
            cell.alignment = { horizontal: "right", vertical: "middle" };
          }
        } else {
          cell.alignment = { horizontal: colNumber === 1 ? "left" : "center", vertical: "middle" };
        }
      });
      excelRow.height = 18;
      excelRow.commit();
    });

    // 列宽：按内容 + 标题自适应，首列稍宽
    const widths = calcColumnWidths(headers, rows);
    widths.forEach((w, idx) => {
      const col = worksheet.getColumn(idx + 1);
      col.width = idx === 0 ? Math.max(w, 14) : w;
    });
    if (headers.length > 0) {
      worksheet.autoFilter = {
        from: { row: headerRowIndex, column: 1 },
        to: { row: headerRowIndex, column: headers.length }
      };
      worksheet.views = [{ state: "frozen", xSplit: 0, ySplit: headerRowIndex, activeCell: `A${headerRowIndex + 1}` }];
    }

    // 底部免责声明：小字灰色，合并居中
    const footerIdx = headerRowIndex + rows.length + 2;
    const footerRow = worksheet.getRow(footerIdx);
    footerRow.getCell(1).value = "注：数据综合 Newzoo/Statista/Sensor Tower 等公开来源，仅作趋势参考；如有不适请咨询专业人士。";
    footerRow.getCell(1).font = { name: "Calibri", size: 8, italic: true, color: { argb: "FF9CA3AF" } };
    footerRow.getCell(1).alignment = { horizontal: "center", vertical: "middle" };
    footerRow.height = 14;
    worksheet.mergeCells(footerIdx, 1, footerIdx, Math.max(headers.length, 1));
    footerRow.commit();

    // 图表占位：用色块+文字模拟“高级图表区”，避免纯文字寒酸
    if (sheetInput.chart && rows.length > 0) {
      const chartTitle = sheetInput.chart.title || "Chart";
      const chartRowIdx = footerIdx + 2;
      const chartRow = worksheet.getRow(chartRowIdx);
      const cell = chartRow.getCell(1);
      cell.value = `▣ 图表：${chartTitle}（${sheetInput.chart.type}）—— ${headers[sheetInput.chart.xColumn]} vs ${headers[sheetInput.chart.yColumn]}（数据已备，图表可在 WPS/Excel 中一键插入）`;
      cell.font = { name: "Calibri", size: 9, color: { argb: input.template.chartPalette[0].replace("FF", "FF") }, bold: true };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
      cell.border = { top: { style: "thin", color: { argb: input.template.borderColor } }, left: { style: "thin", color: { argb: input.template.borderColor } }, bottom: { style: "thin", color: { argb: input.template.borderColor } }, right: { style: "thin", color: { argb: input.template.borderColor } } };
      cell.alignment = { horizontal: "left", vertical: "middle" };
      chartRow.height = 20;
      worksheet.mergeCells(chartRowIdx, 1, chartRowIdx, Math.max(headers.length, 1));
      chartRow.commit();
    }

    // 打印与视图优化
    worksheet.properties.defaultRowHeight = 15;
    worksheet.pageSetup.printArea = `A1:${String.fromCharCode(64 + headers.length)}${footerIdx + 3}`;
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
