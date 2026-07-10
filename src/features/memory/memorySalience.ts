// VOID 记忆系统 —— 记忆准入闸（Salience Gate）
// 职责单一：只判「这句话值不值得长期记住」，返回 worth / skip，不分类、不写库、不召回。
// 定位（对齐 25 号文档 §2.3 优化点 1）：位于 classifyMemory 之前的第一道闸，
// 从源头拦掉纯社交 / 闲聊 / 情绪宣泄 / 问句，根治「几乎每句话都被记下来」。
//
// 口径（白名单式，命中实义信号才记）：
//   worth ——
//     A. 命中「自述事实」模式（显式的第一人称持久事实声明，如「我叫…」「我喜欢…」），任意长度；
//     B. 命中「实义强分区」规则（复用 classifier 同一套规则表）且长度达下限。
//   skip —— 其余一律跳过。
//
// 说明：情绪（emotionTrend）不在此路记录——情绪有专线（VoidStage 的 emotionTrend 写入按
// 「显著情绪 + 时间窗合并」处理），此处遇到纯情绪词一律 skip，避免把「我好烦」当画像事实存下。

import { matchStrongMemoryType } from "./memoryClassifier";

/** 无强信号时的最小信息量门槛（字数）。低于此值且仅靠关键词命中的短句视为过于零碎，不记。 */
const MIN_MEANINGFUL_LENGTH = 8;

/**
 * 「自述事实」模式表：第一人称对持久事实的显式声明。
 * 命中即判 worth 且不受长度限制——这类声明即使很短（如「我叫王」）也具长期价值。
 * 覆盖：身份/属性、恒常偏好、长期目标、健康自述、称呼要求。人际关系主要交由强分区规则命中。
 */
const SELF_STATEMENT_PATTERNS: readonly RegExp[] = [
  // 身份 / 属性
  /我叫\S/,
  /我的名字/,
  /我今年.{0,4}[岁歲]/,
  /我.{0,2}生日/,
  /我(住在|家住|家在|来自)/,
  /我在.{1,8}(市|区|县|省|工作|上班|上学|读书)/,
  /我是.{1,12}(人|生|师|员|工程师|医生|护士|老师|学生|程序员|设计师|经理|老板|作家|律师)/,
  /我(的)?(职业|工作|专业)是/,
  // 恒常偏好
  /我(很|最|超|特别|真的)?(喜欢|讨厌|爱|不喜欢|不爱|受不了|害怕|怕)\S/,
  // 长期目标
  /我(想要|想成为|想当|打算|计划|立志|梦想)/,
  /我的(目标|梦想|愿望|计划)/,
  // 健康自述
  /我(有|得了|患有?|检查出|查出).{0,8}(病|症|炎|癌|糖尿|高血压|抑郁|焦虑症|失眠)/,
  /我对.{1,10}过敏/,
  /我(在|正在)?(吃|服用?).{0,8}药/,
  // 称呼要求
  /(叫我|喊我|称呼我)\S/
];

/** 准入判定结果：是否值得长期记住 + 理由（供日志 / 未来 UI 提示）。 */
export type SalienceResult = {
  worth: boolean;
  reason: string;
};

/**
 * 判定一条用户输入是否值得写入长期记忆。
 * @param content 用户本轮原始输入
 */
export function assessSalience(content: string): SalienceResult {
  const text = content.trim();
  if (!text) {
    return { worth: false, reason: "空内容" };
  }

  // A. 自述事实：显式的第一人称持久事实声明，任意长度均记。
  if (SELF_STATEMENT_PATTERNS.some((pattern) => pattern.test(text))) {
    return { worth: true, reason: "命中自述事实模式" };
  }

  // B. 实义强分区：复用 classifier 规则表；情绪分区走专线，此处不记。
  const strongType = matchStrongMemoryType(text);
  if (strongType && strongType !== "emotionTrend") {
    if (text.length >= MIN_MEANINGFUL_LENGTH) {
      return { worth: true, reason: `命中实义强分区（${strongType}）` };
    }
    return { worth: false, reason: "命中强分区关键词但过短，视为零碎信息" };
  }

  // 其余：纯社交 / 闲聊 / 情绪宣泄 / 问句 / 无信号短句，一律不记。
  return { worth: false, reason: "无长期价值（社交/闲聊/情绪/问句）" };
}
