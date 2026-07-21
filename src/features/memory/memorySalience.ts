// VOID 记忆系统 —— 记忆准入闸（Salience Gate）
// 职责：只判「这句话值不值得长期记住」，返回 worth / skip；不分类、不写库、不召回。
//
// 产品口径（2026-07-21 收紧）：
// - 关键词只允许给 classifier 做「落哪个分区」，**绝不能**单独决定「要不要记」。
// - 只记「用户主动给出的可复用事实 / 明确要求记住的内容」。
// - 问句、闲聊、话题点名、对 AI 的盘问一律 skip。
//
// 反例（必须 skip）：
// - 「你知道我的偏好吗？」——只是在问，没有陈述任何偏好
// - 「你知道我的职业是什么吗？」——问句；不得因「我的职业是」子串误放行
//
// 正例（worth）：
// - 「我的工作是一名程序员」
// - 「我喜欢晚睡」
// - 「请记住以后叫我小陈」
// - 「提醒我周五前提交方案」
// - 长文夹一句「你知道我喜欢什么吗？」但仍含大量自述事实 → 整段放行，由提炼器丢掉问句

/** 无明确指令时，自述事实仍要求的最小信息量（字数）。 */
const MIN_STATEMENT_LENGTH = 4;

/** 准入判定结果。 */
export type SalienceResult = {
  worth: boolean;
  reason: string;
};

/**
 * 判定一条用户输入是否值得写入长期记忆。
 * 顺序：空 → 明确记住/提醒 → 第一人称陈述事实 → 纯社交 → 纯问句/非陈述 → skip。
 *
 * 重要：长句里夹一句「你知道吗？」不能否掉整段事实。
 * 所以「可建档陈述 / 明确记住」必须优先于「含问号就整句 skip」。
 * 纯问句（无陈述）仍会在后面被拦下。
 */
export function assessSalience(content: string): SalienceResult {
  const text = content.trim();
  if (!text) {
    return { worth: false, reason: "空内容" };
  }

  // 用户明确要求「记住 / 提醒」——指令本身即授权写入（可与夹杂问句并存）
  if (matchesExplicitRememberOrReminder(text)) {
    return { worth: true, reason: "命中明确记住/提醒指令" };
  }

  // 只在「去掉问句子句后的残留」上匹配自述，避免「你知道我喜欢什么吗」误放行
  // 长文夹问句：残留仍含「我讨厌香菜 / 叫我阿陈」等 → 放行，提炼器丢掉问句
  const declarativeResidue = stripQuestionLikeClauses(text);
  if (
    matchesDeclarativeSelfFact(declarativeResidue) &&
    declarativeResidue.replace(/\s+/g, "").length >= MIN_STATEMENT_LENGTH
  ) {
    return { worth: true, reason: "命中第一人称事实陈述" };
  }

  // 纯社交 / 附和 / 对 AI 评价：无长期档案价值
  if (isPureSocialOrChat(text)) {
    return { worth: false, reason: "纯社交/闲聊/评价，无长期价值" };
  }

  // 纯问句 / 求确认 / 点名话题：没有任何新事实，禁止落库
  if (isNonDeclarativeUtterance(text)) {
    return { worth: false, reason: "问句或非陈述，不含可建档事实" };
  }

  // 默认不记：包括仅含分区关键词、无断言的句子
  return { worth: false, reason: "无明确可建档事实（不按关键词写入）" };
}

// ---------------------------------------------------------------------------
// 问句 / 非陈述
// ---------------------------------------------------------------------------

/**
 * 判断是否为「没有在陈述事实」的话语。
 * 覆盖：疑问句、求确认、让 AI 回忆、只点名话题不给答案。
 *
 * 注意：此处只应拦截「整段主要是问句」的情况。
 * 长段落中夹一句「你知道我喜欢什么吗？」不能把整段判死——
 * 那种混合句应在 assessSalience 里靠陈述/记住规则先放行。
 */
function isNonDeclarativeUtterance(text: string): boolean {
  const normalized = text.replace(/\s+/g, "");

  // 按句切分：去掉问句子句后若几乎没剩，才算「整段非陈述」
  const declarativeResidue = stripQuestionLikeClauses(text);
  const residueNormalized = declarativeResidue.replace(/\s+/g, "");

  // 短问句 / 以问号为主的整句
  if (/[？?]/.test(normalized) || /[吗呢么]\s*[。.!！…]*\s*$/.test(text)) {
    // 去掉问句后几乎没剩实质内容 → 纯问
    if (residueNormalized.length < MIN_STATEMENT_LENGTH) {
      return true;
    }
    // 仍有较长残留但上面的陈述匹配已失败 → 按非陈述处理
    // （混合长句若含「我讨厌…」等会在 assessSalience 更早放行，到不了这里）
  }

  // 向 AI 求知 / 求确认 / 求回忆（整段以这类话头起，且去掉问句后仍短）
  if (
    residueNormalized.length < 24 &&
    /^(那)?(你|您)?(知不知道|还记得|记不记得|清不清楚|晓不晓得|能不能告诉|可不可以告诉|可以告诉|告诉我|请问|想问|问一下|问你)/.test(
      residueNormalized || normalized
    )
  ) {
    return true;
  }
  if (
    residueNormalized.length < 24 &&
    /^(你|您)(知道|还知道|清楚|了解|记得|还记得)/.test(residueNormalized || normalized)
  ) {
    return true;
  }

  // 「……是什么/是谁/怎么样」类：只在「去掉问句后仍主要是询问」时拦截
  if (
    residueNormalized.length < 24 &&
    /(是什么|是谁|是哪|有哪些|有什么|怎么样|怎么了|如何|为何|为什么|哪一个|哪些|哪里|哪儿|多少|几点|何时)/.test(
      residueNormalized || normalized
    )
  ) {
    return true;
  }

  // 仅点名「我的 X」却无断言谓词：如「我的偏好」「关于我的职业」
  if (
    /^(那)?(关于|有关)?(我的|自己的)?(偏好|习惯|职业|工作|专业|名字|目标|计划|健康|过敏|作息|口味)([啊呀呢吧]*)$/.test(
      normalized
    )
  ) {
    return true;
  }

  // 整段去掉问句后仍为空/极短
  if (/[？?]/.test(normalized) && residueNormalized.length < MIN_STATEMENT_LENGTH) {
    return true;
  }

  return false;
}

/**
 * 去掉问句味道的子句，留下可能含事实的残留。
 * 用于区分「纯问」与「长文夹问」。
 */
function stripQuestionLikeClauses(text: string): string {
  const parts = text.split(/(?<=[。！？?；;\n])/);
  const kept: string[] = [];
  for (const part of parts) {
    const piece = part.trim();
    if (!piece) {
      continue;
    }
    // 子句自身是问句：含问号，或以 吗/呢/么 收尾
    if (/[？?]/.test(piece)) {
      continue;
    }
    if (/[吗呢么]\s*[。.!！…]*\s*$/.test(piece)) {
      continue;
    }
    // 「你知道/还记得…」类求问子句（即使无问号）
    const compact = piece.replace(/\s+/g, "");
    if (/^(对了)?(你|您)(知不知道|知道|还知道|记得|还记得|清不清楚|了解)/.test(compact)) {
      continue;
    }
    kept.push(piece);
  }
  // 无标点长句兜底：去掉「…吗」片段
  if (kept.length === 0 && text.trim()) {
    return text
      .replace(/[^。！？?\n]*[？?][^。！？?\n]*/g, " ")
      .replace(/[^。！？?\n]*[吗呢么]\s*/g, " ")
      .trim();
  }
  return kept.join("");
}

// ---------------------------------------------------------------------------
// 纯社交 / 闲聊
// ---------------------------------------------------------------------------

function isPureSocialOrChat(text: string): boolean {
  const normalized = text.replace(/\s+/g, "");

  // 极短附和
  if (normalized.length <= 4 && /^(嗯+|啊+|哦+|噢+|额+|好+|行+|嗯嗯|好好|哈哈+|呵呵+|嘿嘿+)$/.test(normalized)) {
    return true;
  }

  // 问候 / 寒暄
  if (/^(你好|您好|在吗|在不在|嗨|哈喽|hello|hi|早上好|中午好|晚上好|晚安)([啊呀呢吧！!。.]*)?$/i.test(normalized)) {
    return true;
  }

  // 对 AI 的即时评价 / 调侃（非关系显著事件；关系事件走 P6 专线）
  if (/^(你|您).{0,12}(真|好|太|有点|有些)?(虚伪|烦|啰嗦|多话|无聊|厉害|聪明|笨|傻|可爱)/.test(normalized)) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// 明确「记住 / 提醒」指令（用户主动授权）
// ---------------------------------------------------------------------------

function matchesExplicitRememberOrReminder(text: string): boolean {
  // 记住/记一下 + 后续内容
  if (/(请)?(帮我)?(记住|记一下|记着|记下来|记好)([:：，,\s]|我|：)/.test(text)) {
    return text.length >= 6;
  }
  // 提醒类待办
  if (/(提醒我|叫我记得|别忘了(提醒)?我|记得提醒我)/.test(text)) {
    return text.length >= 6;
  }
  // 「以后/之后 + 叫我/不要」类约束指令
  if (/(以后|之后|从今|往后).{0,8}(叫我|喊我|称呼我|不要|别再|别叫)/.test(text)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 第一人称陈述事实（断言式，不是关键词表）
// ---------------------------------------------------------------------------

/**
 * 必须像「主谓完整的自述」，而不是句子里碰巧出现「喜欢」「工作」等词。
 * 每条模式都要求断言后方有实质内容。
 */
const DECLARATIVE_SELF_FACT_PATTERNS: readonly RegExp[] = [
  // 身份 / 名字
  /我叫[一-鿿A-Za-z0-9·]{1,20}/,
  /我的名字是[一-鿿A-Za-z0-9·]{1,20}/,
  /我今年\d{1,3}\s*[岁歲]/,
  /我.{0,2}生日是.{2,20}/,
  /我(住在|家住|家在|来自)[一-鿿A-Za-z0-9]{2,30}/,
  /我在[一-鿿A-Za-z0-9]{1,20}(市|区|县|省|工作|上班|上学|读书|任职)/,
  // 「我是…」限职业/身份尾词，避免「我是不是」「我是谁」类（问句已先拦）
  /我是.{1,16}(人|生|师|员|工程师|医生|护士|老师|学生|程序员|开发|设计师|经理|老板|作家|律师|会计|自由职业|无业)/,
  /我(的)?(职业|工作|专业)是.{2,40}/,
  /我的工作是.{2,40}/,
  // 恒常偏好（要求「喜欢/讨厌」后仍有宾语）
  /我(很|最|超|特别|真的|比较|有点|有些)?(喜欢|讨厌|爱|不喜欢|不爱|受不了|害怕|怕)[一-鿿A-Za-z0-9]{1,40}/,
  /我的(偏好|习惯|口味|作息)是.{2,40}/,
  // 称呼要求
  /(请)?(你)?(以后|之后)?(叫我|喊我|称呼我)[一-鿿A-Za-z0-9]{1,20}/,
  // 长期目标
  /我(想要|想成为|想当|打算|计划|立志|梦想)[一-鿿A-Za-z0-9]{2,40}/,
  /我的(目标|梦想|愿望|计划)是.{2,40}/,
  // 健康自述
  /我(有|得了|患有?|检查出|查出).{0,12}(病|症|炎|癌|糖尿|高血压|抑郁|焦虑症|失眠)/,
  /我对[一-鿿A-Za-z0-9]{1,20}过敏/,
  /我(在|正在)?(吃|服用)[一-鿿A-Za-z0-9]{1,20}药/,
  // 人际关系陈述（「我朋友/我妈…」+ 断言；含血压高等简写健康）
  /我(的)?(朋友|同事|同学|伴侣|对象|男友|女友|母亲|妈妈|妈|父亲|爸爸|爸|老婆|老公).{1,40}(是|在|喜欢|讨厌|住|工作|生病|住院|血压|血糖|过敏)/,
  // 作息改口常见说法（「以前我晚睡，现在尽量十一点前睡」）
  /我.{0,8}(晚睡|早睡|熬夜|早起)/,
  /现在.{0,8}(尽量)?\d{1,2}\s*点.{0,6}(前)?睡/,
  // 宠物 / 饲养态度（金鱼可以、猫不想养）
  /(金鱼|猫|狗|犬).{0,8}(可以|想养|不想养|不养|不喜欢养)/,
  /我(现在)?(不想|不打算|不准备)?养[一-鿿]{1,10}/,
  // 明确时间待办自述（非问句）
  /我([今明后]天|这周|下周|周[一二三四五六日天]|星期[一二三四五六日天]).{0,12}(要|得|必须|需要).{2,40}/
];

function matchesDeclarativeSelfFact(text: string): boolean {
  return DECLARATIVE_SELF_FACT_PATTERNS.some((pattern) => pattern.test(text));
}
