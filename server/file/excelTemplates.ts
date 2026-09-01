export type ExcelTemplateId = "void-dark" | "void-light" | "void-vivid";

export type ExcelTemplate = {
  id: ExcelTemplateId;
  name: string;
  headerBg: string; // ARGB
  headerFontColor: string;
  headerFontBold: boolean;
  stripeEvenBg: string;
  stripeOddBg: string;
  borderColor: string;
  titleFontSize: number;
  chartPalette: string[]; // ARGB
};

const TEMPLATES: Record<ExcelTemplateId, ExcelTemplate> = {
  "void-dark": {
    id: "void-dark",
    name: "VOID 深色",
    headerBg: "FF1F2937",
    headerFontColor: "FFE5E7EB",
    headerFontBold: true,
    stripeEvenBg: "FF111827",
    stripeOddBg: "FF1F2937",
    borderColor: "FF374151",
    titleFontSize: 14,
    chartPalette: ["FF38BDF8", "FF818CF8", "FF22D3EE", "FFA78BFA"]
  },
  "void-light": {
    id: "void-light",
    name: "VOID 浅色",
    headerBg: "FF3B82F6",
    headerFontColor: "FFFFFFFF",
    headerFontBold: true,
    stripeEvenBg: "FFF8FAFC",
    stripeOddBg: "FFE0E7FF",
    borderColor: "FFCBD5E1",
    titleFontSize: 14,
    chartPalette: ["FF2563EB", "FF0EA5E9", "FF0891B2", "FF6366F1"]
  },
  "void-vivid": {
    id: "void-vivid",
    name: "VOID 活力",
    headerBg: "FF1E2761",
    headerFontColor: "FFFFFFFF",
    headerFontBold: true,
    stripeEvenBg: "FFF8FAFC",
    stripeOddBg: "FFEEF2FF",
    borderColor: "FFCBD5E1",
    titleFontSize: 16,
    chartPalette: ["FFF96167", "FFF9E795", "FF2F3C7E", "FF38BDF8"]
  }
};

export function listExcelTemplates(): ExcelTemplate[] {
  return Object.values(TEMPLATES);
}

export function resolveExcelTemplate(preferred?: string, hint?: string): ExcelTemplate {
  const lowerHint = (hint ?? "").toLowerCase();
  const lowerPref = (preferred ?? "").toLowerCase();
  // 记忆偏好优先：用户说过喜欢深色/浅色
  if (lowerPref.includes("深") || lowerPref.includes("dark")) return TEMPLATES["void-dark"];
  if (lowerPref.includes("浅") || lowerPref.includes("light")) return TEMPLATES["void-light"];
  // 任务自适应：游戏/活力主题用 vivid
  if (lowerHint.includes("游戏") || lowerHint.includes("game") || lowerHint.includes("活力") || lowerHint.includes("vivid")) return TEMPLATES["void-vivid"];
  // 默认商务浅色
  return TEMPLATES["void-light"];
}

export function getExcelTemplate(id: ExcelTemplateId): ExcelTemplate {
  return TEMPLATES[id] ?? TEMPLATES["void-light"];
}
