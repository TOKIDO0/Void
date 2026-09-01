export type PptTemplateId = "void-dark" | "void-light" | "void-vivid";

export type PptTemplate = {
  id: PptTemplateId;
  name: string;
  bg: string; // hex without #
  titleColor: string;
  headingColor: string;
  bodyColor: string;
  accent: string;
  accent2: string;
  chartPalette: string[];
};

const TEMPLATES: Record<PptTemplateId, PptTemplate> = {
  "void-dark": {
    id: "void-dark",
    name: "VOID 深色",
    bg: "0F172A",
    titleColor: "F8FAFC",
    headingColor: "38BDF8",
    bodyColor: "E5E7EB",
    accent: "38BDF8",
    accent2: "818CF8",
    chartPalette: ["38BDF8", "818CF8", "22D3EE", "A78BFA"]
  },
  "void-light": {
    id: "void-light",
    name: "VOID 浅色",
    bg: "F8FAFC",
    titleColor: "1E293B",
    headingColor: "2563EB",
    bodyColor: "475569",
    accent: "2563EB",
    accent2: "0EA5E9",
    chartPalette: ["2563EB", "0EA5E9", "0891B2", "6366F1"]
  },
  "void-vivid": {
    id: "void-vivid",
    name: "VOID 活力",
    bg: "1E2761",
    titleColor: "FFFFFF",
    headingColor: "F96167",
    bodyColor: "E0E7FF",
    accent: "F96167",
    accent2: "F9E795",
    chartPalette: ["F96167", "F9E795", "2F3C7E", "38BDF8"]
  }
};

export function listPptTemplates(): PptTemplate[] {
  return Object.values(TEMPLATES);
}

export function resolvePptTemplate(preferred?: string, hint?: string): PptTemplate {
  const lowerHint = (hint ?? "").toLowerCase();
  const lowerPref = (preferred ?? "").toLowerCase();
  if (lowerPref.includes("深") || lowerPref.includes("dark")) return TEMPLATES["void-dark"];
  if (lowerPref.includes("浅") || lowerPref.includes("light")) return TEMPLATES["void-light"];
  if (lowerHint.includes("游戏") || lowerHint.includes("game") || lowerHint.includes("活力") || lowerHint.includes("vivid") || lowerHint.includes("发布") || lowerHint.includes("路演")) return TEMPLATES["void-vivid"];
  return TEMPLATES["void-light"];
}

export function getPptTemplate(id: PptTemplateId): PptTemplate {
  return TEMPLATES[id] ?? TEMPLATES["void-light"];
}
