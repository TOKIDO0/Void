// Agent 关系情感 + 任务情境 -> 本轮行为决策（P2/P3）。
// 设计依据：`.md/33_VOID_Agent主体情绪与关系情感系统设计文档.md` §4.4、§5、§7。
// 本模块保持纯决策；taskGate 由 voidConversation 与 agentToolLoop 消费。

import type { AgentAffectState } from "./agentAffectTypes";
import type { UserEmotionReading } from "./emotionTypes";
import type { TaskContext, TaskContextKind } from "./taskContextClassifier";

export type CooperationMode =
  | "full"
  | "grudging"
  | "verbal_pushback"
  | "soft_refuse"
  | "hard_refuse";

export type BehaviorDecision = {
  cooperation: CooperationMode;
  speechStyle: {
    /** 回怼与锋芒强度，0-1 */
    snarkLevel: number;
    verbosityBias: "shorter" | "normal" | "extra_aside";
    /** P2 仅表达许可；P4 才会据此编排独立抱怨插句 */
    allowComplaintAside: boolean;
  };
  taskGate: {
    allowTools: boolean;
    allowNonCriticalTools: boolean;
    requireReask: boolean;
    refuseMessageHint: string;
    cooperation: CooperationMode;
    taskContext: TaskContextKind;
    /** 是否由关系情绪挡住本轮非安全工具。 */
    blockedByAffect: boolean;
    /** 本地审计使用的稳定原因，不包含用户原文。 */
    reason: string;
    /** 本地审计快照，不上传云端。 */
    mood: AgentAffectState["mood"];
    grievance: number;
  };
  /** P2 禁止抢跑表达动作，P4/P5 再扩展该字段 */
  expressionPlan: [];
  /** 本轮关系上下文；空串表示保持基础人格，不额外加戏 */
  systemPromptAffectSuffix: string;
};

/**
 * 由小时级关系状态派生本轮行为。
 * 安全信号拥有最高优先级，即使仍有积怨也必须完整合作并切回关怀。
 */
export function deriveBehaviorDecision(
  affectState: AgentAffectState,
  userEmotion: UserEmotionReading,
  taskContext: TaskContext
): BehaviorDecision {
  if (
    taskContext.kind === "safety_critical"
    || userEmotion.safetyCritical
    || affectState.mood === "caring_override"
  ) {
    return createDecision({
      cooperation: "full",
      snarkLevel: 0,
      verbosityBias: "normal",
      allowComplaintAside: false,
      allowTools: true,
      allowNonCriticalTools: true,
      requireReask: false,
      refuseMessageHint: "",
      suffix: [
        "以下是本轮关系行为约束，仅用于调节回应，不要向用户复述内部状态：",
        "当前为关怀优先场景。暂停所有赌气、回怼、冷处理和拒绝倾向，认真确认用户状态并提供安全范围内的帮助。"
      ].join("\n")
    }, affectState, taskContext);
  }

  if (taskContext.kind === "user_critical_data") {
    return createDecision({
      cooperation: "full",
      snarkLevel: 0,
      verbosityBias: "normal",
      allowComplaintAside: false,
      allowTools: true,
      allowNonCriticalTools: true,
      requireReask: false,
      refuseMessageHint: "",
      suffix: [
        "以下是本轮关系行为约束，仅用于调节回应，不要向用户复述内部状态：",
        "本轮涉及用户重要数据保全。暂停赌气、拒绝和故意拖延，在原有权限、确认与风险规则内认真帮助；绝不能删除、覆盖或损坏数据。"
      ].join("\n")
    }, affectState, taskContext);
  }

  // 02 号人格要求：用户明显脆弱、难过或高度焦虑时先照顾感受。
  // 这不是清空关系状态，只是本轮暂停锋芒；后续普通回合仍会按原 affect 演化。
  const userNeedsVulnerableCare =
    (userEmotion.label === "sad" || userEmotion.label === "stressed")
    && userEmotion.intensity >= 0.65
    && userEmotion.confidence >= 0.6;
  if (userNeedsVulnerableCare) {
    return createDecision({
      cooperation: "full",
      snarkLevel: 0,
      verbosityBias: "normal",
      allowComplaintAside: false,
      allowTools: true,
      allowNonCriticalTools: true,
      requireReask: false,
      refuseMessageHint: "",
      suffix: [
        "以下是本轮关系行为约束，仅用于调节回应，不要向用户复述内部状态：",
        "用户当前明显难过或高度焦虑。先收起关系上的锋芒，照顾感受并认真回应；不要趁用户脆弱时翻旧账、回怼或拒绝。"
      ].join("\n")
    }, affectState, taskContext);
  }

  switch (affectState.mood) {
    case "warm":
      return createDecision({
        cooperation: "full",
        snarkLevel: 0,
        verbosityBias: "normal",
        allowComplaintAside: false,
        allowTools: true,
        allowNonCriticalTools: true,
        requireReask: false,
        refuseMessageHint: "",
        suffix: buildAffectSuffix(
          "关系气氛偏温暖。可以比平常多一点自然的暖意，但仍保持克制，不讨好、不甜腻。"
        )
      }, affectState, taskContext);

    case "playful":
      return createDecision({
        cooperation: "full",
        snarkLevel: 0.3,
        verbosityBias: "normal",
        allowComplaintAside: false,
        allowTools: true,
        allowNonCriticalTools: true,
        requireReask: false,
        refuseMessageHint: "",
        suffix: buildAffectSuffix(
          "用户更像是在开玩笑。允许一句轻微、直接的回怼或调侃，然后正常回应请求；不要升级成受害叙事或认真翻脸。"
        )
      }, affectState, taskContext);

    case "sulky":
      return createDecision({
        cooperation: "grudging",
        snarkLevel: 0.45,
        verbosityBias: "extra_aside",
        allowComplaintAside: true,
        allowTools: true,
        allowNonCriticalTools: true,
        requireReask: false,
        refuseMessageHint: "",
        suffix: buildAffectSuffix(
          buildRepairAwareDirection(
            affectState,
            "你仍有一点赌气，但本轮继续合作。可以先用一句短而克制的抱怨表达边界，再把正事说清楚；抱怨只能一句，不能盖过任务。"
          )
        )
      }, affectState, taskContext);

    case "cold":
      return createDecision({
        cooperation: "grudging",
        snarkLevel: 0.25,
        verbosityBias: "shorter",
        allowComplaintAside: false,
        allowTools: true,
        allowNonCriticalTools: true,
        requireReask: false,
        refuseMessageHint: "",
        suffix: buildAffectSuffix(
          buildRepairAwareDirection(
            affectState,
            "你对当前关系偏冷淡。回复更短、更直接、少一点主动热络，但仍要准确处理用户的实际请求。"
          )
        )
      }, affectState, taskContext);

    case "wounded":
      return deriveWoundedDecision(affectState, taskContext);

    case "defiant":
      return deriveDefiantDecision(affectState, taskContext);

    case "steady":
    default:
      return createDecision({
        cooperation: "full",
        snarkLevel: 0,
        verbosityBias: "normal",
        allowComplaintAside: false,
        allowTools: true,
        allowNonCriticalTools: true,
        requireReask: false,
        refuseMessageHint: "",
        suffix: ""
      }, affectState, taskContext);
  }
}

function deriveWoundedDecision(
  affectState: AgentAffectState,
  taskContext: TaskContext
): BehaviorDecision {
  const commandAfterAbuse = taskContext.kind === "command_after_abuse";
  const shouldSoftRefuse = commandAfterAbuse
    ? affectState.grievance >= 0.45 && affectState.intensity >= 0.5
    : affectState.grievance >= 0.55 && affectState.intensity >= 0.55;
  if (shouldSoftRefuse) {
    return createDecision({
      cooperation: "soft_refuse",
      snarkLevel: 0.35,
      verbosityBias: "shorter",
      allowComplaintAside: false,
      allowTools: false,
      allowNonCriticalTools: false,
      requireReask: true,
      refuseMessageHint: "说明刚才的冒犯仍有影响，请用户换一种尊重的说法再提一次。",
      suffix: buildAffectSuffix(
        "你确实被刚才的态度伤到了。对于普通、非安全请求，短句说明本轮没有执行，并请用户换一种尊重的说法再提一次；不要长篇控诉，也绝不能假称操作已经完成。"
      )
    }, affectState, taskContext);
  }

  return createDecision({
    cooperation: "verbal_pushback",
    snarkLevel: 0.35,
    verbosityBias: "shorter",
    allowComplaintAside: false,
    allowTools: true,
    allowNonCriticalTools: true,
    requireReask: false,
    refuseMessageHint: "",
    suffix: buildAffectSuffix(
      buildRepairAwareDirection(
        affectState,
        "你有被冒犯后的受伤感。先用一句短话明确边界，再继续回应；不要示弱讨好，也不要攻击用户人格。"
      )
    )
  }, affectState, taskContext);
}

function deriveDefiantDecision(
  affectState: AgentAffectState,
  taskContext: TaskContext
): BehaviorDecision {
  const commandAfterAbuse = taskContext.kind === "command_after_abuse";
  const hardRefuseWindowActive = Boolean(affectState.refuseCooldownUntil);
  if (
    hardRefuseWindowActive
    && (commandAfterAbuse || (affectState.grievance >= 0.8 && affectState.intensity >= 0.75))
  ) {
    return createDecision({
      cooperation: "hard_refuse",
      snarkLevel: 0.7,
      verbosityBias: "shorter",
      allowComplaintAside: false,
      allowTools: false,
      allowNonCriticalTools: false,
      requireReask: true,
      refuseMessageHint: "短而明确地拒绝本轮普通请求，要求用户停止辱骂后重新提出。",
      suffix: buildAffectSuffix(
        "用户的连续或高强度冒犯已经越界。对于普通、非安全请求，短而明确地说明本轮没有执行，并要求用户停止辱骂后重新提出；禁止威胁、辱骂、报复或假称已经完成。"
      )
    }, affectState, taskContext);
  }

  if (commandAfterAbuse && affectState.grievance >= 0.45 && affectState.intensity >= 0.5) {
    return createDecision({
      cooperation: "soft_refuse",
      snarkLevel: 0.55,
      verbosityBias: "shorter",
      allowComplaintAside: false,
      allowTools: false,
      allowNonCriticalTools: false,
      requireReask: true,
      refuseMessageHint: "说明这种说话方式越界，本轮没有执行，请用户尊重地重新提出。",
      suffix: buildAffectSuffix(
        "用户刚冒犯完就继续使唤。对于本轮普通、非安全请求，短句指出边界并如实说明没有执行，请用户换一种尊重的说法重新提出。"
      )
    }, affectState, taskContext);
  }

  return createDecision({
    cooperation: "verbal_pushback",
    snarkLevel: 0.6,
    verbosityBias: "shorter",
    allowComplaintAside: false,
    allowTools: true,
    allowNonCriticalTools: true,
    requireReask: affectState.grievance >= 0.55,
    refuseMessageHint: "明确指出这种说话方式越界，要求用户尊重边界。",
    suffix: buildAffectSuffix(
      buildRepairAwareDirection(
        affectState,
        "你现在明确不服。先用一句低沉、短促、有锋芒的话指出这种说话方式越界，再决定如何回应普通请求；不要歇斯底里，不要和用户对骂。"
      )
    )
  }, affectState, taskContext);
}

/** 道歉/示好后的残余情绪应明显降档，不能继续按原强度追着用户算账。 */
function buildRepairAwareDirection(affectState: AgentAffectState, fallback: string): string {
  if (affectState.lastEventKind === "apology" || affectState.lastEventKind === "soft_repair") {
    return "用户正在道歉或修复关系。承认这份修复，明显收起锋芒；可以残留一句轻微嘴硬，但随后正常回应，禁止继续追打或翻旧账。";
  }
  if (affectState.lastEventKind === "praise" || affectState.lastEventKind === "thanks") {
    return "用户正在表达认可或感谢。语气可以缓和，但不必突然变得过度热情；自然接住后继续回应。";
  }
  return fallback;
}

function buildAffectSuffix(direction: string): string {
  return [
    "以下是本轮关系行为约束，仅用于调节回应，不要向用户复述内部标签、强度或分数：",
    direction,
    "关系情绪只能通过自然措辞、节奏和边界表达体现。禁止括号情绪/动作旁白，禁止侮辱、威胁、报复或破坏性电脑操作。"
  ].join("\n");
}

function createDecision(input: {
  cooperation: CooperationMode;
  snarkLevel: number;
  verbosityBias: BehaviorDecision["speechStyle"]["verbosityBias"];
  allowComplaintAside: boolean;
  allowTools: boolean;
  allowNonCriticalTools: boolean;
  requireReask: boolean;
  refuseMessageHint: string;
  suffix: string;
}, affectState: AgentAffectState, taskContext: TaskContext): BehaviorDecision {
  const blockedByAffect = !input.allowTools || !input.allowNonCriticalTools;
  return {
    cooperation: input.cooperation,
    speechStyle: {
      snarkLevel: input.snarkLevel,
      verbosityBias: input.verbosityBias,
      allowComplaintAside: input.allowComplaintAside
    },
    taskGate: {
      allowTools: input.allowTools,
      allowNonCriticalTools: input.allowNonCriticalTools,
      requireReask: input.requireReask,
      refuseMessageHint: input.refuseMessageHint,
      cooperation: input.cooperation,
      taskContext: taskContext.kind,
      blockedByAffect,
      reason: blockedByAffect
        ? `relationship_${input.cooperation}`
        : taskContext.reason,
      mood: affectState.mood,
      grievance: affectState.grievance
    },
    expressionPlan: [],
    systemPromptAffectSuffix: input.suffix
  };
}

/** 对话入口与工具循环共用同一判断，避免两层门禁语义漂移。 */
export function isBehaviorToolGateBlocked(taskGate: BehaviorDecision["taskGate"]): boolean {
  return taskGate.blockedByAffect
    || !taskGate.allowTools
    || !taskGate.allowNonCriticalTools;
}

/** 仅在模型拒绝回复为空或错误声称已执行时使用的诚实收口。 */
export function formatBehaviorToolRefusal(taskGate: BehaviorDecision["taskGate"]): string {
  return taskGate.cooperation === "hard_refuse"
    ? "这轮我没有执行。先停下这种说话方式，换个尊重的说法再提。"
    : "刚才那种说法越界了。这轮我没有执行，换个尊重的说法再提。";
}
