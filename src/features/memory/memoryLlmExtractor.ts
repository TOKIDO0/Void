// VOID 记忆系统 —— 后台 LLM 事实提炼
// 职责：把「已通过 salience 的用户原话」拆成多条短事实 + 分区/主体；不写库、不挡主对话。
// 铁律：只保留用户明确说出的断言；禁止把「会/更/挺」升级成「只/唯一/全部」。

import type { ModelConfig } from "../settings/modelConfig";
import { getModelProvider } from "../../lib/model-providers/providerRegistry";
import type { MemoryType, SubjectType } from "./memoryTypes";
import { isMemoryType, isSubjectType, MEMORY_TYPES } from "./memoryTypes";
import { assessSensitivity } from "./memoryPolicy";

/** 单条提炼结果：可供 policy + store 落库。 */
export type ExtractedMemoryFact = {
  content: string;
  memoryType: MemoryType;
  subjectType: SubjectType;
  subjectName: string;
  confidence: number;
  sensitivity: ReturnType<typeof assessSensitivity>;
};

/** 提炼失败时不抛到 UI；调用方收到空数组即本轮不写。 */
export type MemoryExtractionResult = {
  facts: ExtractedMemoryFact[];
  /** 调试用简短原因，不上屏 */
  reason: string;
};

/** 单条事实最大字数（与投影 80 字同量级，避免长原文回灌）。 */
const MAX_FACT_CONTENT_LENGTH = 80;
/** 单轮最多落库条数，防止模型刷屏。 */
const MAX_FACTS_PER_TURN = 6;
/** 提炼专用输出上限：短 JSON，省 token、降延迟。 */
const EXTRACTION_MAX_OUTPUT_TOKENS = 700;
/** 提炼温度压低，减少发挥。 */
const EXTRACTION_TEMPERATURE = 0.1;

/** 模型不得在用户未说时擅自加入的升级措辞（按短语检查，避免「只会」误放行「只放」）。 */
const FORBIDDEN_UPGRADE_PHRASES: readonly string[] = [
  "只放",
  "仅放",
  "只吃",
  "只喜欢",
  "仅喜欢",
  "唯一喜欢",
  "唯一",
  "全部",
  "所有",
  "从不",
  "永远",
  "绝对"
];

/** 单字升级标记：仅当原话完全未出现该字时拦截（兜底）。 */
const FORBIDDEN_UPGRADE_CHARS: readonly string[] = ["只", "仅"];

const EXTRACTION_SYSTEM_PROMPT = `你是 VOID 的「长期记忆事实提炼器」。任务：从用户原话中拆出可长期复用的短事实。

输出要求（必须严格遵守）：
1. 只输出一个 JSON 对象，不要 markdown，不要解释。格式：
{"facts":[{"content":"短事实","memoryType":"preference","subjectType":"self","subjectName":"用户本人","confidence":0.8}]}
2. facts 可为空数组；无长期价值时返回 {"facts":[]}。
3. 每条 content：一条断言、尽量短、保留原意用词，不要扩写、不要总结成故事。
4. 禁止把弱表述升级成绝对表述：
   - 用户说「会多放」→ 记「会多放」，禁止改成「只放」
   - 用户说「更喜欢 A」→ 记「更喜欢 A」，禁止改成「只喜欢 A」
   - 用户说「除了 X 都挺喜欢」→ 可记「不喜欢 X」与「整体较喜欢该类」，禁止记「只喜欢某一品牌」
5. 主体判定：
   - 事实关于用户自己（含「我/自己」偏好、习惯、身份）→ subjectType=self, subjectName=用户本人
   - 仅当事实明确关于亲属本人时 → subjectType=relative, subjectName=具体关系词（如母亲/家人）
   - 朋友同理 subjectType=friend
   - 不要因为句中顺带提到「家人」就把「我讨厌香菜」标成亲属
6. memoryType 只能是：userProfile | emotionTrend | longTermGoal | healthRecord | relationship | preference | task | knowledgeCache
   （禁止 agentRelationship）
7. 不要记录：纯闲聊、问句、一次性场景描写、密钥/密码/证件号、对 AI 的评价。
8. confidence 取 0.5–0.95；原话越明确越高。
9. 最多 ${MAX_FACTS_PER_TURN} 条。

正例：
用户：「我很讨厌吃香菜，但是家人做饭会放，我自己做饭会多放辣椒酱」
→
{"facts":[
  {"content":"用户讨厌吃香菜","memoryType":"preference","subjectType":"self","subjectName":"用户本人","confidence":0.9},
  {"content":"用户自己做饭会多放辣椒酱","memoryType":"preference","subjectType":"self","subjectName":"用户本人","confidence":0.85}
]}`;

/**
 * 调用用户当前配置的模型，把一句用户原话拆成多条记忆事实。
 * 失败 / 非法输出 → 空 facts（调用方不得回退写整句原文）。
 */
export async function extractMemoryFactsFromUserMessage(
  userMessage: string,
  modelConfig: ModelConfig,
  signal?: AbortSignal
): Promise<MemoryExtractionResult> {
  const content = userMessage.trim();
  if (!content) {
    return { facts: [], reason: "空内容" };
  }

  const provider = getModelProvider(modelConfig.provider);
  const validation = provider.validateConfig(modelConfig);
  if (!validation.valid) {
    return { facts: [], reason: validation.message ?? "模型配置无效" };
  }

  // 提炼请求：非流式、低温、短输出；不带 tools，避免占主对话工具环
  const extractConfig: ModelConfig = {
    ...modelConfig,
    temperature: EXTRACTION_TEMPERATURE,
    maxOutputTokens: EXTRACTION_MAX_OUTPUT_TOKENS,
    streamEnabled: false,
    thinkingModeEnabled: false
  };

  try {
    const response = await provider.sendMessage(
      {
        messages: [
          { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
          { role: "user", content: `用户原话：\n${content}` }
        ],
        toolChoice: "none",
        signal
      },
      extractConfig
    );

    const parsed = parseFactsJson(response.content);
    if (!parsed) {
      return { facts: [], reason: "模型输出无法解析为 JSON" };
    }

    const facts = sanitizeExtractedFacts(parsed, content);
    return {
      facts,
      reason: facts.length > 0 ? `提炼 ${facts.length} 条` : "模型未给出可落库事实"
    };
  } catch {
    return { facts: [], reason: "提炼请求失败" };
  }
}

/** 从模型文本中抠出 JSON 对象。 */
function parseFactsJson(raw: string): unknown[] | null {
  const text = raw.trim();
  if (!text) {
    return null;
  }

  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    candidates.push(fenced[1].trim());
  }
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as { facts?: unknown }).facts)) {
        return (parsed as { facts: unknown[] }).facts;
      }
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // 尝试下一个候选
    }
  }
  return null;
}

/** 校验并收紧模型输出：类型白名单、长度、措辞升级、条数。 */
function sanitizeExtractedFacts(
  rawFacts: unknown[],
  originalUserMessage: string
): ExtractedMemoryFact[] {
  const allowedTypes = new Set<string>(MEMORY_TYPES.filter((type) => type !== "agentRelationship"));
  const results: ExtractedMemoryFact[] = [];

  for (const item of rawFacts) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const factContent = typeof record.content === "string" ? record.content.trim() : "";
    if (!factContent || factContent.length > MAX_FACT_CONTENT_LENGTH) {
      continue;
    }
    // 禁止把用户原句整段回写（拆条失败时的偷懒路径）
    if (factContent === originalUserMessage.trim() && originalUserMessage.trim().length > 40) {
      continue;
    }

    const memoryType = record.memoryType;
    const subjectType = record.subjectType;
    if (!isMemoryType(memoryType) || !allowedTypes.has(memoryType)) {
      continue;
    }
    if (!isSubjectType(subjectType)) {
      continue;
    }

    if (introducesForbiddenUpgrade(factContent, originalUserMessage)) {
      continue;
    }

    const subjectName =
      typeof record.subjectName === "string" && record.subjectName.trim()
        ? record.subjectName.trim().slice(0, 20)
        : defaultSubjectName(subjectType as SubjectType);

    // 第一人称偏好/画像强制 self，避免「家人」噪声把主体带走
    const resolvedSubject = resolveSubjectAgainstContent(
      factContent,
      subjectType as SubjectType,
      subjectName
    );

    const confidenceRaw = typeof record.confidence === "number" ? record.confidence : 0.7;
    const confidence = Math.min(0.95, Math.max(0.5, confidenceRaw));
    const sensitivity = assessSensitivity(memoryType, factContent);

    results.push({
      content: factContent,
      memoryType,
      subjectType: resolvedSubject.subjectType,
      subjectName: resolvedSubject.subjectName,
      confidence,
      sensitivity
    });

    if (results.length >= MAX_FACTS_PER_TURN) {
      break;
    }
  }

  return results;
}

/** 若事实里出现原话没有的升级短语/绝对化，拒绝该条。 */
function introducesForbiddenUpgrade(factContent: string, originalUserMessage: string): boolean {
  for (const phrase of FORBIDDEN_UPGRADE_PHRASES) {
    if (factContent.includes(phrase) && !originalUserMessage.includes(phrase)) {
      return true;
    }
  }
  // 单字兜底：事实含「只/仅」且原话完全没有该字
  for (const marker of FORBIDDEN_UPGRADE_CHARS) {
    if (factContent.includes(marker) && !originalUserMessage.includes(marker)) {
      return true;
    }
  }
  // 特殊：「只放」类即使原话有别的「只…」也不算同一断言
  if (/只\s*放/.test(factContent) && !/只\s*放/.test(originalUserMessage)) {
    return true;
  }
  if (/只\s*喜欢/.test(factContent) && !/只\s*喜欢/.test(originalUserMessage)) {
    return true;
  }
  return false;
}

function defaultSubjectName(subjectType: SubjectType): string {
  if (subjectType === "self") {
    return "用户本人";
  }
  if (subjectType === "relative") {
    return "亲属";
  }
  if (subjectType === "friend") {
    return "朋友";
  }
  return "其他";
}

/**
 * 内容层主体校正：
 * - 事实以「用户/我」开头或描述用户自身偏好 → 强制 self
 * - 仅当事实明确在描述亲属本人、且不是用户自我偏好时保留 relative
 */
function resolveSubjectAgainstContent(
  factContent: string,
  subjectType: SubjectType,
  subjectName: string
): { subjectType: SubjectType; subjectName: string } {
  const aboutSelf =
    /^(用户|我)/.test(factContent) ||
    /用户(讨厌|喜欢|偏好|习惯|自己|是|会|不)/.test(factContent);

  if (aboutSelf || subjectType === "self") {
    return { subjectType: "self", subjectName: "用户本人" };
  }

  if (subjectType === "relative") {
    return { subjectType: "relative", subjectName: subjectName || "亲属" };
  }

  if (subjectType === "friend") {
    return { subjectType: "friend", subjectName: subjectName || "朋友" };
  }

  return {
    subjectType,
    subjectName: subjectName || defaultSubjectName(subjectType)
  };
}
