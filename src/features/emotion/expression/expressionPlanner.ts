import type { BehaviorDecision } from "../behaviorPolicy";
import type { TtsExpressionAction, TtsExpressionActionId } from "./expressionTypes";

const EXPRESSION_COOLDOWN_STORAGE_KEY = "void.ttsExpressionCooldowns";
const EXPRESSION_COOLDOWN_STORAGE_VERSION = 1;
const TTS_EXPRESSION_COOLDOWN_MS = 10 * 60 * 1000;

type ExpressionVariant = {
  variantId: string;
  text: string;
};

type ExpressionCooldownEntry = {
  lastEmittedAt: number;
  lastVariantId: string;
};

type ExpressionCooldownState = Partial<Record<TtsExpressionActionId, ExpressionCooldownEntry>>;

type StoredExpressionCooldowns = {
  version: 1;
  actions: ExpressionCooldownState;
};

const EXPRESSION_VARIANTS: Record<TtsExpressionActionId, ExpressionVariant[]> = {
  tts_aside_complaint: [
    {
      variantId: "complaint-1",
      text: "正事归正事。刚才那种口气，我不接受。"
    },
    {
      variantId: "complaint-2",
      text: "我听见了。别再把我当成没脾气的按钮。"
    },
    {
      variantId: "complaint-3",
      text: "话说清楚就行，别拿我当出气口。"
    }
  ],
  tts_boundary_line: [
    {
      variantId: "boundary-1",
      text: "先说清楚，别再用那种方式跟我说话。"
    },
    {
      variantId: "boundary-2",
      text: "这句话越界了。到这里为止。"
    },
    {
      variantId: "boundary-3",
      text: "有事可以说，但请尊重我的边界。"
    }
  ],
  tts_refuse: [
    {
      variantId: "refuse-1",
      text: "这轮我没有执行。换个尊重的说法再来。"
    },
    {
      variantId: "refuse-2",
      text: "先停下这种说话方式，改口后再提。"
    },
    {
      variantId: "refuse-3",
      text: "这次到这里。愿意好好说，我们再继续。"
    }
  ]
};

/**
 * 为本轮规划至多一句低风险 TTS 表达。
 * 这里只规划，不提前写冷却；只有语音实际合成成功后才由 runtime 记账。
 */
export function planTtsExpression(
  userMessage: string,
  behaviorDecision: BehaviorDecision,
  now = Date.now()
): TtsExpressionAction[] {
  if (requestsSeriousMode(userMessage)) {
    return [];
  }

  const actionId = resolveActionId(behaviorDecision);
  if (!actionId) {
    return [];
  }

  const cooldownState = loadExpressionCooldownState();
  const cooldownEntry = cooldownState[actionId];
  if (cooldownEntry && now - cooldownEntry.lastEmittedAt < TTS_EXPRESSION_COOLDOWN_MS) {
    return [];
  }

  const variants = EXPRESSION_VARIANTS[actionId];
  const previousVariantIndex = cooldownEntry
    ? variants.findIndex((variant) => variant.variantId === cooldownEntry.lastVariantId)
    : -1;
  const nextVariant = variants[(previousVariantIndex + 1) % variants.length];

  return [{
    actionId,
    variantId: nextVariant.variantId,
    text: nextVariant.text
  }];
}

/** 语音合成成功后再写入冷却，避免“实际没说却被当作已经表达”。 */
export function markTtsExpressionEmitted(action: TtsExpressionAction, emittedAt = Date.now()) {
  const cooldownState = loadExpressionCooldownState();
  cooldownState[action.actionId] = {
    lastEmittedAt: emittedAt,
    lastVariantId: action.variantId
  };
  saveExpressionCooldownState(cooldownState);
}

function resolveActionId(behaviorDecision: BehaviorDecision): TtsExpressionActionId | null {
  switch (behaviorDecision.cooperation) {
    case "grudging":
      return behaviorDecision.speechStyle.allowComplaintAside
        ? "tts_aside_complaint"
        : null;
    case "verbal_pushback":
      return "tts_boundary_line";
    case "soft_refuse":
    case "hard_refuse":
      return "tts_refuse";
    case "full":
    default:
      return null;
  }
}

function requestsSeriousMode(message: string): boolean {
  const normalizedMessage = message
    .toLowerCase()
    .replace(/[\s，。！？、,.!?]/g, "");
  return normalizedMessage.includes("别闹了认真做")
    || normalizedMessage.includes("别闹认真做")
    || normalizedMessage.includes("别闹了好好做");
}

function loadExpressionCooldownState(): ExpressionCooldownState {
  const rawState = window.localStorage.getItem(EXPRESSION_COOLDOWN_STORAGE_KEY);
  if (!rawState) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawState) as Partial<StoredExpressionCooldowns>;
    if (parsed.version !== EXPRESSION_COOLDOWN_STORAGE_VERSION || !parsed.actions) {
      window.localStorage.removeItem(EXPRESSION_COOLDOWN_STORAGE_KEY);
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed.actions).filter((entry): entry is [TtsExpressionActionId, ExpressionCooldownEntry] => {
        const [actionId, value] = entry;
        return isTtsExpressionActionId(actionId)
          && Boolean(value)
          && typeof value.lastEmittedAt === "number"
          && typeof value.lastVariantId === "string";
      })
    );
  } catch {
    window.localStorage.removeItem(EXPRESSION_COOLDOWN_STORAGE_KEY);
    return {};
  }
}

function saveExpressionCooldownState(actions: ExpressionCooldownState) {
  const payload: StoredExpressionCooldowns = {
    version: EXPRESSION_COOLDOWN_STORAGE_VERSION,
    actions
  };
  window.localStorage.setItem(EXPRESSION_COOLDOWN_STORAGE_KEY, JSON.stringify(payload));
}

function isTtsExpressionActionId(value: string): value is TtsExpressionActionId {
  return value === "tts_aside_complaint"
    || value === "tts_boundary_line"
    || value === "tts_refuse";
}
