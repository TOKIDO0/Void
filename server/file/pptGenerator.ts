import pptxgenPkg from "pptxgenjs";
import type { PptTemplate } from "./pptTemplates";
// pptxgenjs exports default as constructor via .default in ESM interop
const PptxGenJS = (pptxgenPkg as unknown as { default: typeof pptxgenPkg }).default ?? pptxgenPkg;

export type PptSlideInput = {
  title: string;
  bullets?: string[];
  body?: string;
  chart?: {
    type: "bar" | "pie";
    title: string;
    labels: string[];
    values: number[];
  };
  layout?: "title" | "bullets" | "chart" | "titleBody";
};

export type PptGenerateInput = {
  title: string;
  slides: PptSlideInput[];
  template: PptTemplate;
  author?: string;
};

function sanitize(text: string, max = 120): string {
  return text.trim().slice(0, max) || "Untitled";
}

export async function generatePptxBuffer(input: PptGenerateInput): Promise<Buffer> {
  const pres = new (PptxGenJS as unknown as new () => InstanceType<typeof pptxgenPkg>)();
  pres.layout = "LAYOUT_16x9";
  pres.author = input.author ?? "VOID";
  pres.title = input.title;
  pres.subject = input.title;

  // 封面
  const cover = pres.addSlide();
  cover.background = { color: input.template.bg };
  cover.addText(sanitize(input.title, 80), {
    x: 0.8, y: 1.8, w: 8.4, h: 1.2,
    fontSize: 32, bold: true, color: input.template.titleColor, fontFace: "Microsoft YaHei", align: "center", valign: "middle"
  });
  cover.addText("VOID 智能整理 · 仅作参考", {
    x: 0.8, y: 3.2, w: 8.4, h: 0.4,
    fontSize: 11, italic: true, color: input.template.bodyColor, fontFace: "Calibri", align: "center"
  });
  cover.addShape(pres.ShapeType.rect, { x: 4.2, y: 3.9, w: 1.6, h: 0.06, fill: { color: input.template.accent } });
  cover.addText(new Date().toLocaleDateString("zh-CN"), {
    x: 0.8, y: 4.2, w: 8.4, h: 0.3,
    fontSize: 9, color: input.template.bodyColor, fontFace: "Calibri", align: "center"
  });

  for (const s of input.slides) {
    const slide = pres.addSlide();
    slide.background = { color: "FFFFFF" };
    // 顶部色条
    slide.addShape(pres.ShapeType.rect, { x: 0, y: 0, w: 10, h: 0.05, fill: { color: input.template.accent } });
    // 标题
    slide.addText(sanitize(s.title, 60), {
      x: 0.5, y: 0.25, w: 9, h: 0.6,
      fontSize: 20, bold: true, color: input.template.headingColor, fontFace: "Microsoft YaHei", valign: "middle"
    });
    slide.addShape(pres.ShapeType.rect, { x: 0.5, y: 0.85, w: 1.2, h: 0.04, fill: { color: input.template.accent2 } });

    if (s.chart && s.chart.labels.length > 0) {
      const chartTitle = sanitize(s.chart.title, 50);
      slide.addText(chartTitle, { x: 0.5, y: 1.0, w: 9, h: 0.3, fontSize: 11, bold: true, color: "64748B", fontFace: "Calibri" });
      const chartData = [{
        name: chartTitle,
        labels: s.chart.labels,
        values: s.chart.values
      }];
      const chartType = s.chart.type === "pie" ? pres.ChartType.pie : pres.ChartType.bar;
      // 使用原生 chart，不用图片回退
      (slide as unknown as { addChart: (t: unknown, d: unknown, o: unknown) => void }).addChart(chartType, chartData, {
        x: 0.5, y: 1.4, w: 9, h: 3.8,
        chartColors: input.template.chartPalette,
        showTitle: false,
        showLegend: s.chart.type === "pie",
        legendPos: "b",
        showValue: true,
        dataLabelPosition: s.chart.type === "pie" ? "outEnd" : "outEnd",
        valAxisLineShow: false,
        catAxisLineShow: false,
        valGridLine: { color: "E2E8F0", size: 0.5, style: "dash" },
        catGridLine: { style: "none" },
        catAxisLabelColor: "64748B",
        valAxisLabelColor: "64748B"
      });
      if (s.bullets && s.bullets.length > 0) {
        const bulletTexts = s.bullets.slice(0, 3).map(t => ({ text: sanitize(t, 80), options: { fontSize: 9, color: "475569", bullet: true } }));
        slide.addText(bulletTexts as unknown as string, { x: 0.5, y: 5.4, w: 9, h: 0.6, fontFace: "Calibri", valign: "top", paraSpaceAfter: 2 } as unknown as object);
      }
    } else if (s.bullets && s.bullets.length > 0) {
      const items = s.bullets.slice(0, 6).map((b, idx) => ({
        text: sanitize(b, 90),
        options: { fontSize: 11, color: idx === 0 ? input.template.headingColor : "334155", bullet: true, breakLine: idx < s.bullets!.length - 1, paraSpaceAfter: 4 }
      }));
      slide.addText(items as unknown as string, { x: 0.6, y: 1.2, w: 8.8, h: 3.5, fontFace: "Calibri", valign: "top", lineSpacingMultiple: 1.05 } as unknown as object);
      if (s.body) {
        slide.addText(sanitize(s.body, 200), { x: 0.6, y: 4.7, w: 8.8, h: 0.5, fontSize: 9, italic: true, color: "94A3B8", fontFace: "Calibri" });
      }
    } else {
      slide.addText(sanitize(s.body ?? "—", 300), { x: 0.6, y: 1.3, w: 8.8, h: 3.8, fontSize: 12, color: "334155", fontFace: "Calibri", valign: "top", lineSpacingMultiple: 1.15 });
    }
    // 页脚免责声明
    slide.addText("数据综合公开来源，仅作趋势参考", { x: 0.5, y: 5.35, w: 9, h: 0.15, fontSize: 7, italic: true, color: "94A3B8", fontFace: "Calibri", align: "center" });
  }

  const out = await pres.write({ outputType: "nodebuffer" }) as Buffer;
  return Buffer.from(out);
}
