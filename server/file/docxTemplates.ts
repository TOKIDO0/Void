export type DocxTemplateId = "void-dark" | "void-light" | "void-vivid";

export type DocxTemplate = {
  id: DocxTemplateId;
  name: string;
  accent: string; // hex without #
  accent2: string;
  headingColor: string;
  bodyColor: string;
  tableHeaderBg: string;
  tableHeaderColor: string;
  quoteBorder: string;
};

const TEMPLATES: Record<DocxTemplateId, DocxTemplate> = {
  "void-dark": {
    id: "void-dark",
    name: "VOID 深色",
    accent: "38BDF8",
    accent2: "818CF8",
    headingColor: "0F172A",
    bodyColor: "334155",
    tableHeaderBg: "0F172A",
    tableHeaderColor: "F8FAFC",
    quoteBorder: "38BDF8"
  },
  "void-light": {
    id: "void-light",
    name: "VOID 浅色",
    accent: "2563EB",
    accent2: "0EA5E9",
    headingColor: "1E293B",
    bodyColor: "475569",
    tableHeaderBg: "2563EB",
    tableHeaderColor: "FFFFFF",
    quoteBorder: "2563EB"
  },
  "void-vivid": {
    id: "void-vivid",
    name: "VOID 活力",
    accent: "F96167",
    accent2: "F9E795",
    headingColor: "1E2761",
    bodyColor: "334155",
    tableHeaderBg: "F96167",
    tableHeaderColor: "FFFFFF",
    quoteBorder: "F96167"
  }
};

export function listDocxTemplates(): DocxTemplate[] {
  return Object.values(TEMPLATES);
}

export function resolveDocxTemplate(preferred?: string, hint?: string): DocxTemplate {
  const lowerHint = (hint ?? "").toLowerCase();
  const lowerPref = (preferred ?? "").toLowerCase();
  if (lowerPref.includes("深") || lowerPref.includes("dark")) return TEMPLATES["void-dark"];
  if (lowerPref.includes("浅") || lowerPref.includes("light")) return TEMPLATES["void-light"];
  if (lowerHint.includes("游戏") || lowerHint.includes("game") || lowerHint.includes("活力") || lowerHint.includes("vivid") || lowerHint.includes("报告") || lowerHint.includes("方案")) return TEMPLATES["void-vivid"];
  return TEMPLATES["void-light"];
}

export function getDocxTemplate(id: DocxTemplateId): DocxTemplate {
  return TEMPLATES[id] ?? TEMPLATES["void-light"];
}
