// 用户情绪识别：一期文本规则版。
// 设计依据：`.md/19_VOID_情绪系统专项设计文档.md` 第 6 节。
// 纯前端、零额外请求、零延迟；产出 UserEmotionReading，预留声学融合入口。

import type { EmotionLabel, UserEmotionReading } from "./emotionTypes";

/**
 * 各情绪的文本关键词规则表（可维护常量，不硬编码进逻辑）。
 * 命中即累计权重；权重高低反映线索强弱。
 */
const EMOTION_KEYWORD_RULES: Record<Exclude<EmotionLabel, "neutral">, Array<{ name: string; weight: number }>> = {
  happy: [
    { name: "开心", weight: 1 },
    { name: "太好了", weight: 1.2 },
    { name: "超好", weight: 1.2 },
    { name: "兴奋", weight: 1.2 },
    { name: "棒", weight: 0.8 },
    { name: "厉害", weight: 0.8 },
    { name: "灵感", weight: 0.6 },
    { name: "点子", weight: 0.6 },
    { name: "哈哈", weight: 0.6 }
  ],
  stressed: [
    { name: "好乱", weight: 1.2 },
    { name: "太多", weight: 1 },
    { name: "做不完", weight: 1.4 },
    { name: "来不及", weight: 1.2 },
    { name: "焦虑", weight: 1.4 },
    { name: "压力", weight: 1.2 },
    { name: "崩溃", weight: 1.4 },
    { name: "怎么办", weight: 0.8 },
    { name: "急", weight: 0.8 }
  ],
  sad: [
    { name: "算了", weight: 1 },
    { name: "做不好", weight: 1.4 },
    { name: "没用", weight: 1.2 },
    { name: "失望", weight: 1.2 },
    { name: "难过", weight: 1.4 },
    { name: "累", weight: 0.8 },
    { name: "撑不", weight: 1.4 },
    { name: "不想", weight: 0.8 }
  ],
  angry: [
    { name: "报复", weight: 1.6 },
    { name: "气死", weight: 1.4 },
    { name: "烦", weight: 0.8 },
    { name: "讨厌", weight: 1 },
    { name: "凭什么", weight: 1.2 },
    { name: "过分", weight: 1.2 },
    { name: "受不了", weight: 1.2 }
  ]
};

/**
 * 安全高优先场景关键词：命中即标记 safetyCritical，压过情绪演化（见 engine）。
 * 依据 `02` 号文档第 6 节：人身安全 / 自伤 / 身体症状 / 危险行为。
 */
const SAFETY_CRITICAL_KEYWORDS = [
  "不想活",
  "活不下去",
  "消失算了",
  "撑不下去",
  "自杀",
  "伤害自己",
  "结束这一切"
];

/**
 * 识别用户单轮输入的情绪。
 * @param userText 用户本轮文本
 * @param acousticSignals 语音链路后续可传入的声学线索名（一期为空）
 */
export function recognizeUserEmotion(
  userText: string,
  acousticSignals?: string[]
): UserEmotionReading {
  const at = Date.now();
  const text = userText.trim();
  const hasAcoustic = Boolean(acousticSignals && acousticSignals.length);
  const source: UserEmotionReading["source"] = hasAcoustic ? "text+acoustic" : "text";

  const safetyCritical = SAFETY_CRITICAL_KEYWORDS.some((keyword) => text.includes(keyword));

  // 命中安全场景直接判定为 sad + 高置信，交由 engine 强制切关怀基调
  if (safetyCritical) {
    return {
      label: "sad",
      intensity: 1,
      confidence: 1,
      signals: { text: ["safety-critical"], acoustic: acousticSignals },
      source,
      at,
      safetyCritical: true
    };
  }

  // 逐情绪累计关键词权重
  const scores = new Map<Exclude<EmotionLabel, "neutral">, { score: number; hits: string[] }>();
  for (const [label, rules] of Object.entries(EMOTION_KEYWORD_RULES) as Array<
    [Exclude<EmotionLabel, "neutral">, Array<{ name: string; weight: number }>]
  >) {
    let score = 0;
    const hits: string[] = [];
    for (const rule of rules) {
      if (text.includes(rule.name)) {
        score += rule.weight;
        hits.push(rule.name);
      }
    }
    if (score > 0) {
      scores.set(label, { score, hits });
    }
  }

  // 标点密度线索：多问号 → 焦虑加权；多感叹（非纯开心词）不单独定情绪，仅提升已有强度
  const questionMarkCount = (text.match(/[?？]/g) ?? []).length;
  if (questionMarkCount >= 2) {
    const prev = scores.get("stressed") ?? { score: 0, hits: [] };
    scores.set("stressed", {
      score: prev.score + Math.min(questionMarkCount * 0.3, 1),
      hits: [...prev.hits, `问号密度x${questionMarkCount}`]
    });
  }

  // 无任何命中 → neutral
  if (!scores.size) {
    return {
      label: "neutral",
      intensity: 0.2,
      confidence: text.length ? 0.5 : 0.2,
      signals: { text: [], acoustic: acousticSignals },
      source,
      at,
      safetyCritical: false
    };
  }

  // 取最高分情绪
  let topLabel: Exclude<EmotionLabel, "neutral"> = "happy";
  let topEntry = { score: -1, hits: [] as string[] };
  for (const [label, entry] of scores) {
    if (entry.score > topEntry.score) {
      topLabel = label;
      topEntry = entry;
    }
  }

  // 强度：分数归一（软饱和），置信度随命中项数与领先幅度提升
  const intensity = Math.min(1, topEntry.score / 3);
  const runnerUpScore = [...scores.values()]
    .map((entry) => entry.score)
    .filter((score) => score !== topEntry.score)
    .reduce((max, score) => Math.max(max, score), 0);
  const lead = topEntry.score - runnerUpScore;
  const confidence = Math.min(1, 0.4 + topEntry.hits.length * 0.15 + Math.max(0, lead) * 0.15);

  return {
    label: topLabel,
    intensity,
    confidence,
    signals: { text: topEntry.hits, acoustic: acousticSignals },
    source,
    at,
    safetyCritical: false
  };
}
