/**
 * ADV-01 / ADV-02 顾问式输出：决策意图识别 + 轮次层结构注入。
 *
 * 只决定“这一轮要不要按建议结构回答”，不改变工具路由、权限、安全规则。
 * 判定刻意保守：宁可普通对话不套结构，也不要把闲聊/查资料/情绪倾诉写成报告。
 */

export type AdviceIntent = "decision" | "decision_with_risk";

/** 急症/自伤/急救：不套建议结构，交给安全规则与关怀模式。 */
const EMERGENCY_PATTERN = /不想活|自杀|自残|伤害自己|胸痛|呼吸困难|意识模糊|剧烈头痛|肢体无力|药物过量|严重过敏|流血不止|急救/;

/** 明确在要一个判断，而不是要资料。 */
const DECISION_PATTERN = /要不要|该不该|值不值|值得吗|选哪个|哪个好|怎么选|如何选择|纠结|有必要吗|怎么办|怎么处理|拿不定主意|该选/;

/** 涉及健康/财务/法律/重大生活决定：必须说清做与不做的代价。 */
const RISK_DOMAIN_PATTERN = /健康|身体|症状|医院|看病|用药|吃药|手术|体检|心理|投资|理财|股票|基金|贷款|房贷|买房|卖房|保险|合同|法律|起诉|离婚|辞职|转行|跳槽|存款|钱/;

/** 长文本多是写作/资料任务；超过该长度不做决策意图猜测。 */
const MAX_ADVICE_INPUT_CHARS = 400;

export function resolveAdviceIntent(text: string): AdviceIntent | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed || trimmed.length > MAX_ADVICE_INPUT_CHARS) {
    return null;
  }
  if (EMERGENCY_PATTERN.test(trimmed)) {
    return null;
  }
  if (!DECISION_PATTERN.test(trimmed)) {
    return null;
  }
  return RISK_DOMAIN_PATTERN.test(trimmed) ? "decision_with_risk" : "decision";
}

/** 轮次层后缀：口语结构，不写标题、不套模板腔。 */
export function buildAdviceStructureSuffix(intent: AdviceIntent): string {
  const lines = [
    "【决策建议】",
    "用户这轮要的是判断，不是资料堆砌。用自然口语按顺序说清，不要写标题、不要套模板腔：",
    "1. 一句话复述现状与限制；关键信息不足时只问一个最关键的问题，不硬给建议。",
    "2. 给明确判断：你倾向哪个，为什么。",
    "3. 最多列两到三个真实可选项，说清各自代价。",
    "4. 给推荐，并说明推荐成立的前提。",
    "5. 说清做与不做的风险。",
    "闲聊、单纯查资料、情绪倾诉不套本结构；人身安全、急症、法律紧急情况优先走安全规则。"
  ];
  if (intent === "decision_with_risk") {
    lines.push(
      "【风险必说】这轮涉及健康、财务、法律或重大生活决定：必须明确说出做与不做的后果与代价，并说明哪些结论需要专业机构确认；不提供诊断、投资结论或法律结论。"
    );
  }
  return lines.join("\n");
}
