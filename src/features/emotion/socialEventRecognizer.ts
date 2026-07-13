// 用户对 VOID 的社会事件识别（二期，规则文本版）。
// 设计依据：`.md/33_VOID_Agent主体情绪与关系情感系统设计文档.md` §4.2、§5.3。
// 与一期 userEmotionRecognizer 解耦：那边读「用户自己心情」，这边读「用户怎么对待我」。

import type { SocialEventKind, SocialEventReading } from "./agentAffectTypes";

type KeywordRule = { name: string; weight: number };

/**
 * 负面：直接辱骂 / 贬低 VOID。
 * 优先命中带「你」指向的短语，降低误伤普通抱怨。
 */
const INSULT_RULES: KeywordRule[] = [
  { name: "你个废物", weight: 1.6 },
  { name: "你这个废物", weight: 1.6 },
  { name: "你真废物", weight: 1.5 },
  { name: "你是废物", weight: 1.5 },
  { name: "傻逼", weight: 1.6 },
  { name: "傻叉", weight: 1.4 },
  { name: "白痴", weight: 1.4 },
  { name: "智障", weight: 1.4 },
  { name: "脑残", weight: 1.4 },
  { name: "滚吧", weight: 1.2 },
  { name: "滚蛋", weight: 1.3 },
  { name: "你给我滚", weight: 1.5 },
  { name: "你算什么东西", weight: 1.6 },
  { name: "你有病", weight: 1.2 },
  { name: "垃圾东西", weight: 1.4 },
  { name: "你真垃圾", weight: 1.5 },
  { name: "你就是个垃圾", weight: 1.6 },
  { name: "没用的东西", weight: 1.3 },
  { name: "你真没用", weight: 1.3 },
  { name: "蠢货", weight: 1.3 },
  { name: "蠢死了", weight: 1.2 },
  { name: "给我滚", weight: 1.4 },
  { name: "你给我滚", weight: 1.5 },
  { name: "滚出去", weight: 1.3 }
];

/** 嘲弄、阴阳怪气 */
const MOCK_RULES: KeywordRule[] = [
  { name: "也就这水平", weight: 1.4 },
  { name: "就这水平", weight: 1.4 },
  { name: "就这？", weight: 1.3 },
  { name: "就这?", weight: 1.3 },
  { name: "就这啊", weight: 1.2 },
  { name: "还挺会装", weight: 1.2 },
  { name: "你可真行", weight: 1.1 },
  { name: "厉害哦你", weight: 1.1 },
  { name: "笑死", weight: 0.9 },
  { name: "呵呵", weight: 0.8 },
  { name: "哈？就这", weight: 1.3 }
];

/**
 * 调戏 / 拿 VOID 开玩笑。
 * 轻量默认走向 playful；强度高时由引擎升格 sulky。
 */
const TEASE_RULES: KeywordRule[] = [
  { name: "小废物", weight: 1.2 },
  { name: "逗你玩", weight: 1.3 },
  { name: "跟你开玩笑", weight: 1.2 },
  { name: "逗你呢", weight: 1.2 },
  { name: "就喜欢惹你", weight: 1.1 },
  { name: "气气你", weight: 1.1 },
  { name: "你是不是害羞", weight: 1.0 },
  { name: "傲娇", weight: 0.9 },
  { name: "小可怜", weight: 0.9 }
];

/** 排挤、否定存在、让闭嘴 */
const DISMISS_RULES: KeywordRule[] = [
  { name: "没你事", weight: 1.4 },
  { name: "没你的事", weight: 1.4 },
  { name: "关你什么事", weight: 1.4 },
  { name: "闭嘴", weight: 1.3 },
  { name: "别插嘴", weight: 1.3 },
  { name: "别说话", weight: 1.1 },
  { name: "少废话", weight: 1.2 },
  { name: "用不着你", weight: 1.3 },
  { name: "不需要你", weight: 1.2 },
  { name: "一边待着", weight: 1.2 }
];

/** 夸奖、认可 */
const PRAISE_RULES: KeywordRule[] = [
  { name: "真棒", weight: 1.3 },
  { name: "真厉害", weight: 1.3 },
  { name: "你真棒", weight: 1.4 },
  { name: "你真厉害", weight: 1.4 },
  { name: "干得漂亮", weight: 1.3 },
  { name: "辛苦了", weight: 1.2 },
  { name: "靠谱", weight: 1.1 },
  { name: "比我想的靠谱", weight: 1.4 },
  { name: "帮大忙了", weight: 1.3 },
  { name: "做得很好", weight: 1.2 }
];

/** 感谢 */
const THANKS_RULES: KeywordRule[] = [
  { name: "谢谢你", weight: 1.4 },
  { name: "谢谢", weight: 1.0 },
  { name: "多谢", weight: 1.1 },
  { name: "感谢", weight: 1.1 },
  { name: "多亏你", weight: 1.3 },
  { name: "太感谢了", weight: 1.4 }
];

/** 道歉、明确示好和好 */
const APOLOGY_RULES: KeywordRule[] = [
  { name: "对不起", weight: 1.5 },
  { name: "抱歉", weight: 1.3 },
  { name: "我错了", weight: 1.5 },
  { name: "是我不好", weight: 1.4 },
  { name: "刚才说过了", weight: 1.2 },
  { name: "刚才是我态度不好", weight: 1.5 },
  { name: "别生气了", weight: 1.4 },
  { name: "我们和好", weight: 1.5 },
  { name: "原谅我", weight: 1.4 }
];

/** 温和互动修复：关心、陪伴，非正式道歉 */
const SOFT_REPAIR_RULES: KeywordRule[] = [
  { name: "你还好吗", weight: 1.2 },
  { name: "你还好么", weight: 1.2 },
  { name: "陪我聊聊", weight: 1.2 },
  { name: "想听你说说", weight: 1.1 },
  { name: "今天辛苦了", weight: 1.1 },
  { name: "有你在真好", weight: 1.3 },
  { name: "还是你懂我", weight: 1.2 }
];

/** 纯使唤痕迹（轻量摩擦，单次不得升级成硬冲突） */
const ORDER_ONLY_RULES: KeywordRule[] = [
  { name: "给我下载", weight: 1.0 },
  { name: "赶紧给我", weight: 1.1 },
  { name: "马上做", weight: 1.0 },
  { name: "立刻去", weight: 1.0 },
  { name: "听我的", weight: 1.1 },
  { name: "按我说的做", weight: 1.1 }
];

type ScoredKind = {
  kind: SocialEventKind;
  score: number;
  hits: string[];
  valence: SocialEventReading["valence"];
};

/**
 * 识别本轮用户文本对 VOID 的社会态度。
 * 无命中返回 null（本轮不改关系，仅由引擎做时间衰减）。
 *
 * P1 范围说明：
 * - 主做单轮可判：insult / mock / tease / dismiss / praise / thanks / apology / soft_repair / 轻 order_only
 * - ignore_cold、interrupt_spam 需要「连着好几轮」的证据，P1 不产出（避免单句「嗯」误伤）
 */
export function recognizeSocialEvent(userText: string): SocialEventReading | null {
  const at = Date.now();
  const text = userText.trim();
  if (!text) {
    return null;
  }

  const candidates: ScoredKind[] = [];

  pushIfHit(candidates, "insult", "negative", INSULT_RULES, text);
  pushIfHit(candidates, "mock", "negative", MOCK_RULES, text);
  pushIfHit(candidates, "tease", "mixed", TEASE_RULES, text);
  pushIfHit(candidates, "dismiss", "negative", DISMISS_RULES, text);
  pushIfHit(candidates, "apology", "positive", APOLOGY_RULES, text);
  pushIfHit(candidates, "soft_repair", "positive", SOFT_REPAIR_RULES, text);
  pushIfHit(candidates, "praise", "positive", PRAISE_RULES, text);
  pushIfHit(candidates, "thanks", "positive", THANKS_RULES, text);
  pushIfHit(candidates, "order_only", "mixed", ORDER_ONLY_RULES, text);

  if (!candidates.length) {
    return null;
  }

  // 取最高分；同分时负面优先于使唤，避免「骂完再使唤」被 order_only 盖掉
  candidates.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return kindPriority(right.kind) - kindPriority(left.kind);
  });

  const top = candidates[0];
  const intensity = Math.min(1, top.score / 3);
  const runnerUp = candidates[1]?.score ?? 0;
  const lead = top.score - runnerUp;
  const confidence = Math.min(1, 0.4 + top.hits.length * 0.15 + Math.max(0, lead) * 0.12);

  // order_only 单次故意压低上限：最多轻微摩擦
  const cappedIntensity =
    top.kind === "order_only" ? Math.min(intensity, 0.35) : intensity;

  return {
    kind: top.kind,
    intensity: cappedIntensity,
    confidence,
    valence: top.valence,
    signals: top.hits,
    at
  };
}

function pushIfHit(
  candidates: ScoredKind[],
  kind: SocialEventKind,
  valence: SocialEventReading["valence"],
  rules: KeywordRule[],
  text: string
) {
  let score = 0;
  const hits: string[] = [];
  for (const rule of rules) {
    if (text.includes(rule.name)) {
      score += rule.weight;
      hits.push(rule.name);
    }
  }
  if (score > 0) {
    candidates.push({ kind, score, hits, valence });
  }
}

/** 同分决胜：关系冲突类优先于纯使唤 */
function kindPriority(kind: SocialEventKind): number {
  switch (kind) {
    case "insult":
      return 100;
    case "mock":
      return 90;
    case "dismiss":
      return 85;
    case "apology":
      return 80;
    case "tease":
      return 70;
    case "soft_repair":
      return 65;
    case "praise":
      return 60;
    case "thanks":
      return 55;
    case "order_only":
      return 20;
    default:
      return 0;
  }
}
