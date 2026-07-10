// VOID 记忆系统 —— 敏感信息与写入策略
// 职责单一：只判「能不能写、写之前要不要确认、算几级敏感」，不碰存储与分类。
// 三块能力（对齐 21 号 A3 / 04 号第 3、5 节）：
//   1. 永不记录名单：身份证 / 银行卡 / 密码 / 密钥，命中即硬拦截。
//   2. 敏感级别判定：结合分区与内容给出 normal / sensitive / highSensitive。
//   3. 写入开关默认值 + 写入动作裁决：普通偏好自动、待办可撤销、健康写入前确认、高敏永不。

import type { MemoryType, Sensitivity, SubjectType } from "./memoryTypes";

// ---------------------------------------------------------------------------
// 1. 永不记录名单：命中即禁止写入（04 号第 3 节硬要求）
// ---------------------------------------------------------------------------

/**
 * 永不记录的敏感凭证模式。命中任一即判定为高敏感并禁止落库。
 * 采用「结构特征 + 上下文关键词」双策略，尽量拦准、少误伤。
 */
const NEVER_RECORD_PATTERNS: readonly RegExp[] = [
  // 中国大陆身份证号：18 位，末位可为 X
  /\b\d{17}[\dXx]\b/,
  // 银行卡 / 信用卡号：13–19 位连续数字（允许 4 位一组的空格 / 短横分隔）
  /\b(?:\d[ -]?){13,19}\b/,
  // 密码：关键词后跟随赋值内容
  /(?:密码|password|passwd|pwd)\s*[:：=]\s*\S+/i,
  // 密钥 / 令牌 / 凭证：关键词后跟随赋值内容
  /(?:密钥|api[\s_-]?key|secret|token|access[\s_-]?key)\s*[:：=]\s*\S+/i,
  // 常见密钥前缀（OpenAI sk- / Bearer 令牌等）
  /\bsk-[A-Za-z0-9]{16,}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/
];

/** 内容是否命中永不记录名单。命中即绝不能写入。 */
export function containsForbiddenSecret(content: string): boolean {
  return NEVER_RECORD_PATTERNS.some((pattern) => pattern.test(content));
}

// ---------------------------------------------------------------------------
// 2. 敏感级别判定
// ---------------------------------------------------------------------------

/** 触发「敏感」级别的关键词（健康、财务、隐私向）。 */
const SENSITIVE_KEYWORDS: readonly string[] = [
  "病",
  "疾",
  "诊断",
  "药",
  "血压",
  "血糖",
  "抑郁",
  "焦虑",
  "手术",
  "住院",
  "收入",
  "工资",
  "存款",
  "债务",
  "隐私"
];

/** 天然属于敏感分区的记忆类型（健康档案默认敏感）。 */
const SENSITIVE_MEMORY_TYPES: readonly MemoryType[] = ["healthRecord"];

/**
 * 判定一条候选记忆的敏感级别。
 * - 命中永不记录名单 → highSensitive（随后会被写入裁决拦截）。
 * - 健康分区，或命中敏感关键词 → sensitive。
 * - 其余 → normal。
 */
export function assessSensitivity(memoryType: MemoryType, content: string): Sensitivity {
  if (containsForbiddenSecret(content)) {
    return "highSensitive";
  }
  if (SENSITIVE_MEMORY_TYPES.includes(memoryType) || matchesSensitiveKeyword(content)) {
    return "sensitive";
  }
  return "normal";
}

function matchesSensitiveKeyword(content: string): boolean {
  return SENSITIVE_KEYWORDS.some((keyword) => content.includes(keyword));
}

// ---------------------------------------------------------------------------
// 3. 写入开关 + 写入动作裁决
// ---------------------------------------------------------------------------

/** 用户可配置的记忆写入开关（对齐 04 号第 3 节建议的开关项）。 */
export type MemoryWriteSettings = {
  /** 是否允许自动记录健康信息 */
  allowHealth: boolean;
  /** 是否允许自动记录亲属信息 */
  allowRelative: boolean;
  /** 是否允许自动记录情绪趋势 */
  allowEmotionTrend: boolean;
  /** 是否允许自动记录长期目标与待办 */
  allowGoalAndTask: boolean;
  /** 写入敏感记忆前是否弹确认 */
  confirmBeforeSensitive: boolean;
};

/** 推荐默认开关值（04 号第 3 节推荐默认值）。 */
export const DEFAULT_WRITE_SETTINGS: MemoryWriteSettings = {
  allowHealth: true,
  allowRelative: true,
  allowEmotionTrend: true,
  allowGoalAndTask: true,
  confirmBeforeSensitive: true
};

/**
 * 写入动作裁决结果：
 * - auto     直接自动写入。
 * - confirm  需先向用户确认再写入（如敏感记忆 / 健康档案）。
 * - blocked  永不写入（命中永不名单 / 高敏 / 对应开关关闭）。
 */
export type WriteAction = "auto" | "confirm" | "blocked";

export type WriteDecision = {
  action: WriteAction;
  /** 裁决理由，供 UI 提示或日志使用 */
  reason: string;
};

/** 裁决所需的最小输入（不依赖完整 MemoryEntry，保持纯逻辑）。 */
export type WritePolicyInput = {
  memoryType: MemoryType;
  subjectType: SubjectType;
  content: string;
  sensitivity: Sensitivity;
};

/**
 * 综合永不名单、敏感级别、分区与用户开关，裁决一条候选记忆该如何写入。
 * 收尾接线阶段由对话链路调用；并行期本模块只提供纯函数。
 */
export function resolveWriteDecision(
  input: WritePolicyInput,
  settings: MemoryWriteSettings = DEFAULT_WRITE_SETTINGS
): WriteDecision {
  // 永不记录名单 / 高敏：硬拦截，任何开关都不放行。
  if (containsForbiddenSecret(input.content)) {
    return { action: "blocked", reason: "命中永不记录名单（身份证 / 银行卡 / 密码 / 密钥）" };
  }
  if (input.sensitivity === "highSensitive") {
    return { action: "blocked", reason: "高敏感信息永不写入" };
  }

  // 亲属信息开关。
  if (input.subjectType === "relative" && !settings.allowRelative) {
    return { action: "blocked", reason: "已关闭亲属信息自动记录" };
  }

  // 分区级开关。
  if (input.memoryType === "healthRecord" && !settings.allowHealth) {
    return { action: "blocked", reason: "已关闭健康信息自动记录" };
  }
  if (input.memoryType === "emotionTrend" && !settings.allowEmotionTrend) {
    return { action: "blocked", reason: "已关闭情绪趋势自动记录" };
  }
  if (
    (input.memoryType === "longTermGoal" || input.memoryType === "task") &&
    !settings.allowGoalAndTask
  ) {
    return { action: "blocked", reason: "已关闭长期目标与待办自动记录" };
  }

  // 敏感记忆写入前确认。
  if (input.sensitivity === "sensitive" && settings.confirmBeforeSensitive) {
    return { action: "confirm", reason: "敏感信息写入前需用户确认" };
  }

  return { action: "auto", reason: "普通记忆自动写入" };
}
