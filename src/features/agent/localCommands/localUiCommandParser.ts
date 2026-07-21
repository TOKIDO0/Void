/**
 * 本地 UI 指令识别（纯规则，不经模型）。
 *
 * 位置：文字与语音输入在 VoidStage.handleTextMessage 汇合处，先于对话链路执行。
 * 命中「纯控制指令」（开关模态框 / 麦克风 / 语音播报 / 单独的思考模式开关）时由 UI 直接执行并短路对话；
 * 命中「带要求的提问」（句中含深度思考类措辞）时只切换思考模式，原话继续进入对话。
 *
 * 设计约束：
 *   - 纯控制指令要求整句匹配（允许礼貌前缀与语气尾词），避免误伤正常聊天
 *     （如「帮我打开一个网站」不含面板目标词，不会命中，落入 browser 意图）。
 *   - 与 turnCapabilityRouter（agent 工具意图）完全分离，不新增 capability。
 */

export type LocalUiModalTarget = "settings" | "history" | "memory";

export type LocalUiCommand =
  | { kind: "modal"; target: LocalUiModalTarget; open: boolean }
  | { kind: "voiceInput"; enable: boolean }
  | { kind: "voiceOutput"; enable: boolean }
  /** standalone=true 表示整句就是开关指令（短路对话）；false 表示句中带要求，切换后继续对话。 */
  | { kind: "thinking"; enable: boolean; standalone: boolean };

/** 礼貌前缀：匹配前剥离，不参与语义。 */
const POLITE_PREFIX_PATTERN = /^(请|麻烦|帮我|帮忙|给我)+/;
/** 语气尾词与结尾标点：匹配前剥离。 */
const TRAILING_PARTICLE_PATTERN = /(吧|呀|啊|呢|哦|哈|喽|了)*[\s。．.!！?？~～，,]*$/;

const OPEN_VERBS = "打开|开启|调出|显示|开";
const CLOSE_VERBS = "关闭|关掉|收起|隐藏|关";

/** 模态框目标词 → 目标标识（长词在前，避免「记忆面板」被「记忆」截胡后剩余不匹配）。 */
const MODAL_TARGET_PATTERNS: Array<{ pattern: string; target: LocalUiModalTarget }> = [
  { pattern: "模型设置|设置", target: "settings" },
  { pattern: "历史记录|对话历史|历史", target: "history" },
  { pattern: "记忆面板|记忆", target: "memory" }
];

/** 目标词后允许的冗余后缀（「打开设置面板」「开历史记录窗口」）。 */
const MODAL_SUFFIX = "(?:面板|界面|窗口|页面|模态框)?";

/** 深度思考：关闭类措辞（含否定词，必须先于开启类检查）。 */
const THINKING_DISABLE_PHRASES = [
  "不要深度思考",
  "不用深度思考",
  "别深度思考",
  "无需深度思考",
  "不要想太多",
  "别想太多",
  "简单回复",
  "简短回复",
  "简短回答",
  "简单说",
  "直接说",
  "直接回答",
  "直接告诉我"
];

/** 深度思考：开启类措辞（句中出现即触发）。 */
const THINKING_ENABLE_PHRASES = [
  "深度思考",
  "仔细思考",
  "仔细想想",
  "仔细想",
  "认真想想",
  "认真思考",
  "好好想想",
  "好好思考",
  "深入分析",
  "仔细分析",
  "再考虑一下",
  "再想想",
  "分析"
];

export function parseLocalUiCommand(utterance: string): LocalUiCommand | null {
  const normalized = normalizeUtterance(utterance);
  if (!normalized) {
    return null;
  }

  return (
    parseModalCommand(normalized)
    ?? parseVoiceInputCommand(normalized)
    ?? parseVoiceOutputCommand(normalized)
    ?? parseThinkingCommand(normalized)
  );
}

function normalizeUtterance(utterance: string) {
  return utterance
    .trim()
    .replace(POLITE_PREFIX_PATTERN, "")
    .replace(TRAILING_PARTICLE_PATTERN, "")
    .trim();
}

function parseModalCommand(normalized: string): LocalUiCommand | null {
  for (const { pattern, target } of MODAL_TARGET_PATTERNS) {
    const openPattern = new RegExp(`^(?:${OPEN_VERBS})(?:一下)?(?:${pattern})${MODAL_SUFFIX}$`);
    if (openPattern.test(normalized)) {
      return { kind: "modal", target, open: true };
    }

    const closePattern = new RegExp(`^(?:${CLOSE_VERBS})(?:一下)?(?:${pattern})${MODAL_SUFFIX}$`);
    if (closePattern.test(normalized)) {
      return { kind: "modal", target, open: false };
    }
  }

  return null;
}

function parseVoiceInputCommand(normalized: string): LocalUiCommand | null {
  const inputTargets = "麦克风|音频输入|语音输入|麦";
  if (new RegExp(`^(?:${OPEN_VERBS})(?:一下)?(?:${inputTargets})$`).test(normalized)) {
    return { kind: "voiceInput", enable: true };
  }
  if (new RegExp(`^(?:${CLOSE_VERBS})(?:一下)?(?:${inputTargets})$`).test(normalized) || normalized === "别听") {
    return { kind: "voiceInput", enable: false };
  }
  return null;
}

function parseVoiceOutputCommand(normalized: string): LocalUiCommand | null {
  const outputTargets = "语音输出|音频输出|语音播报|声音|语音";
  if (new RegExp(`^(?:${OPEN_VERBS})(?:一下)?(?:${outputTargets})$`).test(normalized)) {
    return { kind: "voiceOutput", enable: true };
  }
  if (
    new RegExp(`^(?:${CLOSE_VERBS})(?:一下)?(?:${outputTargets})$`).test(normalized)
    || normalized === "静音"
    || normalized === "别说话"
  ) {
    return { kind: "voiceOutput", enable: false };
  }
  return null;
}

function parseThinkingCommand(normalized: string): LocalUiCommand | null {
  const thinkingTargets = "深度思考|思考模式";
  // 显式整句开关：「打开深度思考」「关闭思考模式」→ 纯控制指令。
  if (new RegExp(`^(?:${OPEN_VERBS})(?:一下)?(?:${thinkingTargets})(?:模式)?$`).test(normalized)) {
    return { kind: "thinking", enable: true, standalone: true };
  }
  if (new RegExp(`^(?:${CLOSE_VERBS})(?:一下)?(?:${thinkingTargets})(?:模式)?$`).test(normalized)) {
    return { kind: "thinking", enable: false, standalone: true };
  }

  // 关闭类措辞先查（「不要深度思考」内含「深度思考」，顺序颠倒会误判为开启）。
  const disablePhrase = THINKING_DISABLE_PHRASES.find((phrase) => normalized.includes(phrase));
  if (disablePhrase) {
    return { kind: "thinking", enable: false, standalone: normalized === disablePhrase };
  }

  const enablePhrase = THINKING_ENABLE_PHRASES.find((phrase) => normalized.includes(phrase));
  if (enablePhrase) {
    return { kind: "thinking", enable: true, standalone: normalized === enablePhrase };
  }

  return null;
}
