// VOID 记忆系统 —— 规则版分类器
// 职责单一：从一条候选记忆内容，判出「落哪个分区 + 主体类型 + 敏感级别」。
// 只做规则匹配，不写库、不召回、不接对话链路。规则表独立成常量便于维护（21 号第 6 节）。
// 关键红线（04 号第 5 节）：亲属健康必须落到 subjectType=relative，绝不混进用户本人档案。

import type { MemoryType, SubjectType } from "./memoryTypes";
import { assessSensitivity } from "./memoryPolicy";
import type { Sensitivity } from "./memoryTypes";

/** 分类结果：分区 + 主体 + 主体名 + 敏感级别。 */
export type ClassifyResult = {
  memoryType: MemoryType;
  subjectType: SubjectType;
  subjectName: string;
  sensitivity: Sensitivity;
};

// ---------------------------------------------------------------------------
// 分区规则表：按优先级从上到下匹配，命中即定分区。
// 顺序有意义：健康 / 任务这类强特征分区排在偏好之前，避免被泛词抢走。
// ---------------------------------------------------------------------------

type MemoryTypeRule = {
  memoryType: MemoryType;
  keywords: readonly string[];
};

const MEMORY_TYPE_RULES: readonly MemoryTypeRule[] = [
  {
    memoryType: "healthRecord",
    keywords: ["病", "疾", "诊断", "药", "血压", "血糖", "抑郁", "失眠", "睡眠", "手术", "住院", "体检", "过敏"]
  },
  {
    memoryType: "task",
    keywords: ["提醒", "待办", "截止", "deadline", "明天要", "记得", "别忘", "要交", "预约", "安排", "计划做"]
  },
  {
    memoryType: "longTermGoal",
    keywords: ["目标", "梦想", "长期", "打算", "想做", "想成为", "愿望", "规划", "立志"]
  },
  {
    memoryType: "relationship",
    keywords: ["朋友", "同事", "同学", "伴侣", "对象", "男友", "女友", "闹矛盾", "吵架", "关系", "相处"]
  },
  {
    memoryType: "emotionTrend",
    keywords: ["焦虑", "压力", "难过", "低落", "情绪", "崩溃", "烦躁", "开心", "孤独", "疲惫"]
  },
  {
    memoryType: "preference",
    keywords: ["喜欢", "讨厌", "偏好", "习惯", "不喜欢", "作息", "口味", "风格", "叫我", "称呼"]
  },
  {
    memoryType: "knowledgeCache",
    keywords: ["资料", "来源", "文档", "科普", "研究", "官网", "参考", "查到", "结论"]
  }
];

/** 默认分区：无强特征命中时归入用户画像（最宽泛的身份 / 描述类信息）。 */
const DEFAULT_MEMORY_TYPE: MemoryType = "userProfile";

// ---------------------------------------------------------------------------
// 主体识别规则表：先判亲属，再判朋友，最后默认本人。
// 亲属词表直接决定 subjectType=relative，是「亲属健康不混本人档案」的落点。
// ---------------------------------------------------------------------------

type SubjectRule = {
  subjectType: SubjectType;
  /** 关系词 → 主体名，命中即取该主体名 */
  terms: readonly string[];
};

const RELATIVE_RULE: SubjectRule = {
  subjectType: "relative",
  terms: ["母亲", "妈妈", "妈", "父亲", "爸爸", "爸", "爷爷", "奶奶", "外公", "外婆", "哥哥", "姐姐", "弟弟", "妹妹", "儿子", "女儿", "老婆", "老公", "妻子", "丈夫", "家人", "亲戚"]
};

const FRIEND_RULE: SubjectRule = {
  subjectType: "friend",
  terms: ["朋友", "同事", "同学", "室友", "闺蜜", "兄弟"]
};

/** 第一人称信号：命中则强制归为用户本人。 */
const SELF_TERMS: readonly string[] = ["我", "自己", "本人", "我的"];

/**
 * 对一条候选记忆内容做规则分类。
 * @param content 候选记忆文本
 * @param source  来源标记（哪次对话 / 用户确认），透传，不参与分类
 */
export function classifyMemory(content: string): ClassifyResult {
  const memoryType = resolveMemoryType(content);
  const { subjectType, subjectName } = resolveSubject(content);
  const sensitivity = assessSensitivity(memoryType, content);

  return { memoryType, subjectType, subjectName, sensitivity };
}

// ---------------------------------------------------------------------------
// 内部：分区判定
// ---------------------------------------------------------------------------

function resolveMemoryType(content: string): MemoryType {
  for (const rule of MEMORY_TYPE_RULES) {
    if (rule.keywords.some((keyword) => content.includes(keyword))) {
      return rule.memoryType;
    }
  }
  return DEFAULT_MEMORY_TYPE;
}

// ---------------------------------------------------------------------------
// 内部：主体判定
// 优先级：亲属 > 朋友 > 本人。命中亲属 / 朋友即取具体关系名作 subjectName；
// 否则若含第一人称或无任何主体词，归为用户本人。
// ---------------------------------------------------------------------------

function resolveSubject(content: string): { subjectType: SubjectType; subjectName: string } {
  const relativeTerm = RELATIVE_RULE.terms.find((term) => content.includes(term));
  if (relativeTerm) {
    return { subjectType: "relative", subjectName: relativeTerm };
  }

  const friendTerm = FRIEND_RULE.terms.find((term) => content.includes(term));
  if (friendTerm) {
    return { subjectType: "friend", subjectName: friendTerm };
  }

  if (SELF_TERMS.some((term) => content.includes(term))) {
    return { subjectType: "self", subjectName: "用户本人" };
  }

  // 无任何主体线索：默认归用户本人（画像类信息通常描述用户自己）。
  return { subjectType: "self", subjectName: "用户本人" };
}
