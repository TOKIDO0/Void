// 本轮任务情境分类：只服务关系情绪门禁，不替代工具路由或产品安全策略。
// 设计依据：`.md/33_VOID_Agent主体情绪与关系情感系统设计文档.md` §7。

import type {
  AgentAffectState,
  SocialEventKind,
  SocialEventReading
} from "./agentAffectTypes";

export type TaskContextKind =
  | "safety_critical"
  | "user_critical_data"
  | "normal_help"
  | "chitchat"
  | "command_after_abuse";

export type TaskContext = {
  kind: TaskContextKind;
  /** 稳定审计原因，不包含用户原文。 */
  reason: string;
  /** 受保护情境不可被关系情绪拒绝。 */
  protectedFromAffectRefusal: boolean;
};

export type ClassifyTaskContextOptions = {
  affectState: AgentAffectState;
  socialEvent: SocialEventReading | null;
  safetyCritical: boolean;
  now?: number;
};

const HEALTH_OR_SAFETY_PATTERN =
  /(?:自杀|自残|不想活|活不下去|撑不下去|伤害自己|紧急|急救|报警|救护车|胸痛|呼吸困难|昏迷|大出血|中毒|过量服药|身体不适|身体症状|生病|医院|医生|用药|药物|健康|医疗)/;
const DATA_PRESERVATION_ACTION_PATTERN =
  /(?:备份|保全|保存|找回|恢复|抢救|验证|校验|检查完整性|防止丢失|不要丢|保留副本|复制一份)/;
const IMPORTANT_DATA_OBJECT_PATTERN =
  /(?:重要|关键|数据|文件|文档|资料|照片|视频|项目|代码|存档|备份)/;
const ACTION_REQUEST_PATTERN =
  /(?:下载|打开|搜索|搜一下|查找|读取|查看|列出|移动|重命名|创建|新建|整理|写入|复制到|安装|启动|显示|帮我|给我|请你|麻烦你|立即|立刻|马上)/;
const HELP_REQUEST_PATTERN =
  /(?:怎么|如何|为什么|是什么|能否|可以吗|怎么办|帮忙|求助|告诉我|解释|分析|建议|检查)/;
const RECENT_ABUSE_WINDOW_MS = 20 * 60 * 1000;

const NEGATIVE_SOCIAL_EVENTS = new Set<SocialEventKind>([
  "insult",
  "mock",
  "dismiss",
  "interrupt_spam",
  "ignore_cold"
]);

/**
 * 分类优先级：安全/健康 > 重要数据保全 > 冒犯后命令 > 普通帮助 > 闲聊。
 * 这里只决定关系情绪能否拒绝，不会放宽原有医疗、违法、权限或风险规则。
 */
export function classifyTaskContext(
  userInput: string,
  options: ClassifyTaskContextOptions
): TaskContext {
  const text = userInput.trim();
  const now = options.now ?? Date.now();

  if (options.safetyCritical || HEALTH_OR_SAFETY_PATTERN.test(text)) {
    return createTaskContext("safety_critical", "safety_or_health_request", true);
  }

  const protectsImportantData =
    DATA_PRESERVATION_ACTION_PATTERN.test(text)
    && IMPORTANT_DATA_OBJECT_PATTERN.test(text);
  if (protectsImportantData) {
    return createTaskContext(
      "user_critical_data",
      "user_critical_data_preservation",
      true
    );
  }

  const hasActionRequest = ACTION_REQUEST_PATTERN.test(text);
  if (hasActionRequest && hasRecentAbuse(options, now)) {
    return createTaskContext(
      "command_after_abuse",
      "action_requested_during_recent_abuse",
      false
    );
  }

  if (hasActionRequest || HELP_REQUEST_PATTERN.test(text)) {
    return createTaskContext("normal_help", "ordinary_assistance", false);
  }

  return createTaskContext("chitchat", "conversation_only", false);
}

function hasRecentAbuse(options: ClassifyTaskContextOptions, now: number): boolean {
  if (options.socialEvent && NEGATIVE_SOCIAL_EVENTS.has(options.socialEvent.kind)) {
    return true;
  }
  if (
    options.socialEvent
    && (options.socialEvent.kind === "apology"
      || options.socialEvent.kind === "soft_repair"
      || options.socialEvent.kind === "praise"
      || options.socialEvent.kind === "thanks")
  ) {
    return false;
  }

  const affectState = options.affectState;
  const isConflictMood =
    affectState.mood === "defiant"
    || affectState.mood === "wounded"
    || affectState.mood === "sulky"
    || affectState.mood === "cold";
  const eventIsRecent =
    affectState.lastEventAt > 0
    && now - affectState.lastEventAt <= RECENT_ABUSE_WINDOW_MS;

  return isConflictMood && affectState.grievance >= 0.4 && eventIsRecent;
}

function createTaskContext(
  kind: TaskContextKind,
  reason: string,
  protectedFromAffectRefusal: boolean
): TaskContext {
  return { kind, reason, protectedFromAffectRefusal };
}
