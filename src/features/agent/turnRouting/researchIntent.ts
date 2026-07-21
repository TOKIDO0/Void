/**
 * 信息检索类意图识别（阶段 F）。
 *
 * 命中「搜集 / 检索 / 查一查 / 最火 / 最新」等收集类措辞时：
 * 1. 本轮强制深度思考（仅本轮，不改用户持久化的 thinking 开关）；
 * 2. 注入来源硬规则：结论必须基于工具返回的真实 URL，无来源不许下断言。
 *
 * 纯函数、无副作用，可代码级自测。
 */

/**
 * 检索/调研类动作词 + 时效/热度类目标词。
 * 覆盖口语「帮我查一下」「搜集一下最火的」「最新进展是什么」等，
 * 故意不覆盖「打开网页」「下载安装包」等非检索动作（那些由 browser/software 路由接管）。
 */
const RESEARCH_ACTION_PATTERN =
  /(?:搜集|收集|检索|调研|查证|核实|求证|查资料|找资料|找信息|整理资料|汇总一下|汇总下|帮我查|给我查|查一查|查一下|上网查|联网查|网上查|搜一搜|搜一下|帮我搜|给我搜|搜索一下|搜索下)/;

const RESEARCH_TOPIC_PATTERN =
  /(?:最火|最热|热门|流行|排行|榜单|最新|近况|进展|现状|趋势|口碑|评价|对比|区别|哪个好|有哪些|是什么|怎么回事|为什么|原因|资料|信息|新闻|消息|报道)/;

/**
 * 判断本轮用户输入是否为信息检索/收集类需求。
 * 动作词单独命中即可；仅有话题词时要求搭配疑问/收集语气，降低闲聊误伤。
 */
export function isResearchIntent(userInput: string): boolean {
  const text = userInput.trim();
  if (!text || text.length < 2) {
    return false;
  }

  if (RESEARCH_ACTION_PATTERN.test(text)) {
    return true;
  }

  // 「最火的 XX 是什么 / 最新进展」等：话题词 + 疑问/列举外壳
  if (RESEARCH_TOPIC_PATTERN.test(text) && /(?:是什么|有哪些|怎么样|如何|吗|呢|？|\?|介绍|说说|讲讲|告诉我)/.test(text)) {
    return true;
  }

  return false;
}

/**
 * 注入 system prompt 的来源硬规则（仅检索意图本轮）。
 * 与假成功护栏配合：无工具来源时禁止编造事实与 URL。
 */
export function buildResearchSourcePromptSuffix(): string {
  return [
    "【本轮信息检索硬规则】",
    "1. 本轮按深度思考处理：先理清要查什么、从哪查、如何核对，再给结论。",
    "2. 事实性结论必须基于本轮工具返回的真实来源（browser.search / browser.extract 等结果里的 title+url）。",
    "3. 逐条关键结论时附上来源 URL（完整 http(s) 链接，禁止省略成域名口号）；多条结果分别标注。",
    "4. 未取得来源、工具失败、结果为空时，必须如实说「未能确认来源」或「没查到可靠结果」，禁止编造事实、数字、排名或 URL。",
    "5. 禁止用训练记忆冒充刚查到的「最新/最火」信息；时效类结论没有工具证据就不能断言。",
    "6. 汇报用口语中文，不要 Markdown 列表符；可以说「一、二、三」并在每条后跟链接。"
  ].join("\n");
}
