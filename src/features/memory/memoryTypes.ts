// VOID 记忆系统 —— 类型唯一真源
// 依据 21 号文档第 3 节与 04 号文档第 6/7 节。分区只此九类、主体只四类、敏感只三级。
// 扩项必须先改 04 号文档，再回来同步这里；其它模块（store / classifier / retriever /
// projection / UI）一律从本文件引入类型与常量，不得自建平行定义。

/**
 * 记忆分区：九类分区知识库，互不混淆。
 * - userProfile       用户画像：昵称、称呼、语言偏好、重要身份
 * - emotionTrend      情绪状态：最近情绪走势、压力源、低落周期
 * - longTermGoal      长期目标：反复提到的目标和计划
 * - healthRecord      健康档案：用户本人或亲属健康信息（靠 subjectType 区分主体）
 * - relationship      人际关系：用户与朋友/亲属/伴侣等现实人际关系
 * - preference        偏好习惯：作息、表达习惯、回复风格偏好
 * - task              任务待办：明确时间、任务、提醒
 * - knowledgeCache    专业知识缓存：已查过且可复用的资料摘要
 * - agentRelationship VOID 与用户：仅显著关系事件中性摘要（P6；禁止混入 relationship）
 */
export type MemoryType =
  | "userProfile"
  | "emotionTrend"
  | "longTermGoal"
  | "healthRecord"
  | "relationship"
  | "preference"
  | "task"
  | "knowledgeCache"
  | "agentRelationship";

/** 记忆主体类型：把健康 / 人际信息落到正确的人身上，避免亲属信息混进本人档案。 */
export type SubjectType = "self" | "relative" | "friend" | "other";

/** 敏感级别：普通 / 敏感 / 高敏感。高敏感永不写入（见 memoryPolicy）。 */
export type Sensitivity = "normal" | "sensitive" | "highSensitive";

/** 单条记忆条目结构（对齐 04 号第 6 节）。 */
export type MemoryEntry = {
  /** 唯一标识 */
  id: string;
  /** 所属分区 */
  memoryType: MemoryType;
  /** 主体类型 */
  subjectType: SubjectType;
  /** 具体人物名或关系名，如「用户本人」「母亲」 */
  subjectName: string;
  /** 记忆内容 */
  content: string;
  /** 置信度 0–1 */
  confidence: number;
  /** 来源：来自哪次对话或用户确认 */
  source: string;
  /** 敏感级别 */
  sensitivity: Sensitivity;
  /** 创建时间 epoch ms */
  createdAt: number;
  /** 更新时间 epoch ms */
  updatedAt: number;
  /** 可选：短期记忆过期时间 epoch ms */
  expiresAt?: number;
};

// ---------------------------------------------------------------------------
// 常量清单：既作为运行时合法值校验依据，也供 UI 遍历分组使用。顺序即 UI 展示顺序。
// ---------------------------------------------------------------------------

/** 全部合法分区（运行时校验 + UI 遍历） */
export const MEMORY_TYPES: readonly MemoryType[] = [
  "userProfile",
  "emotionTrend",
  "longTermGoal",
  "healthRecord",
  "relationship",
  "preference",
  "task",
  "knowledgeCache",
  "agentRelationship"
];

/** 全部合法主体类型 */
export const SUBJECT_TYPES: readonly SubjectType[] = ["self", "relative", "friend", "other"];

/** 全部合法敏感级别 */
export const SENSITIVITIES: readonly Sensitivity[] = ["normal", "sensitive", "highSensitive"];

/** 分区中文标签，供记忆管理面板展示 */
export const MEMORY_TYPE_LABELS: Record<MemoryType, string> = {
  userProfile: "用户画像",
  emotionTrend: "情绪状态",
  longTermGoal: "长期目标",
  healthRecord: "健康档案",
  relationship: "人际关系",
  preference: "偏好习惯",
  task: "任务待办",
  knowledgeCache: "专业知识缓存",
  agentRelationship: "VOID 与用户"
};

/** 主体类型中文标签 */
export const SUBJECT_TYPE_LABELS: Record<SubjectType, string> = {
  self: "用户本人",
  relative: "亲属",
  friend: "朋友",
  other: "其他"
};

/** 敏感级别中文标签 */
export const SENSITIVITY_LABELS: Record<Sensitivity, string> = {
  normal: "普通",
  sensitive: "敏感",
  highSensitive: "高敏感"
};

// ---------------------------------------------------------------------------
// 类型守卫：供 store 在反序列化本地数据时逐字段校验，隔离脏数据。
// ---------------------------------------------------------------------------

export function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === "string" && (MEMORY_TYPES as readonly string[]).includes(value);
}

export function isSubjectType(value: unknown): value is SubjectType {
  return typeof value === "string" && (SUBJECT_TYPES as readonly string[]).includes(value);
}

export function isSensitivity(value: unknown): value is Sensitivity {
  return typeof value === "string" && (SENSITIVITIES as readonly string[]).includes(value);
}
