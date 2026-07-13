import type { ModelConfig } from "../settings/modelConfig";
import type { ProviderMessage } from "../../lib/model-providers/providerContract";
import { getModelProvider } from "../../lib/model-providers/providerRegistry";
import { VOID_SYSTEM_PROMPT } from "./voidSystemPrompt";
import { retrieveMemories } from "../memory/memoryRetriever";
import { projectMemories } from "../memory/memoryProjection";
import { runAgentToolLoop } from "./loop/agentToolLoop";
import type { ConfirmationDecision, ConfirmationRequest } from "./permissions";
import {
  resolveTurnCapability,
  type TurnCapability
} from "./turnRouting/turnCapabilityRouter";
import { stripStageDirections } from "./responseTextDisplay";
import { isVoidBridgeReachable } from "./bridge/bridgeHealthClient";
import {
  formatBehaviorToolRefusal,
  isBehaviorToolGateBlocked,
  type BehaviorDecision
} from "../emotion/behaviorPolicy";
import { appendExecutionLog } from "./observability";

export type VoidConversationAttachment = {
  id: string;
  name: string;
  mimeType: string;
  content: string;
};

export type VoidConversationMessage = {
  role: "user" | "assistant";
  content: string;
  attachments?: VoidConversationAttachment[];
};

export type VoidAssistantStreamState = {
  history: VoidConversationMessage[];
  assistantMessageIndex: number;
};

/** 对话层可选：工具循环的进度与确认宿主（语音/文本共用） */
export type VoidMessageRuntimeOptions = {
  requestConfirmation?: (
    request: ConfirmationRequest
  ) => Promise<ConfirmationDecision>;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
  /** 默认 true：支持 tools 的 provider 走 agent loop */
  enableTools?: boolean;
  /** P3 关系情绪门禁；缺省表示调用方没有启用主体情绪决策。 */
  behaviorDecision?: BehaviorDecision;
};

type StoredConversationPayload = {
  version: 1;
  messages: VoidConversationMessage[];
};

const CURRENT_CONVERSATION_STORAGE_KEY = "void.currentConversation";
const CURRENT_CONVERSATION_STORAGE_VERSION = 1;
const MAX_STORED_CONVERSATION_MESSAGES = 80;
const MAX_STORED_MESSAGE_CHARACTERS = 24000;
const MAX_STORED_TOTAL_CHARACTERS = 120000;
const MAX_REQUEST_HISTORY_MESSAGES = 20;
const MAX_REQUEST_HISTORY_CHARACTERS = 18000;
const MAX_ATTACHMENT_CONTENT_CHARACTERS = 18000;
const THINKING_MODE_SYSTEM_SUFFIX = [
  "当前处于思考模式。",
  "请先在内部理清问题结构，再给出结论。",
  "回复要更审慎、更结构化，优先明确前提、步骤和结论。",
  "不要为了显得有思考感而故意拖慢表达。"
].join("");

const TOOL_USE_COMMON_SUFFIX = [
  "任务边界：只执行「最新一条用户消息」里的请求；历史仅作背景，禁止顺带完成上一轮未完成的搜索/打开/下载。",
  "普通聊天不要调工具。参数缺失时先一句话确认，不要猜测。",
  "敏感步骤会请用户确认；拒绝后停止并如实说明。",
  "同一工具失败或空结果时不要死循环重试；换策略或向用户说明卡点。",
  "工具报「桥接不可达 / sidecar 未启动」时，如实告诉用户本机服务未连接，禁止含糊声称已操作。",
  "最终用简洁中文汇报，不要输出 JSON、内部字段名或 Markdown 控制符。"
];

const BROWSER_TOOL_USE_SUFFIX = [
  "本轮只允许使用浏览器、下载与下载后整理工具；若本轮工具列表含 clipboard.read，还可读取剪贴板；若含 desktop.revealPath，可在落盘成功后打开资源管理器展示位置。",
  "当用户要求搜索、打开网页、看视频、下载文件时，必须调用工具，禁止假装已经操作。",
  "剪贴板 URL 下载主路径（用户说从剪贴板/粘贴板下载链接、保存剪贴板网址等）：先 clipboard.read。读到文本后按主机分流，禁止跳过读取直接瞎猜 URL：① 空、非 http(s) URL、或明显不是链接 → 不要调用任何 download*，用中文说明剪贴板内容不是可下载链接；② B 站视频页（www/m.bilibili.com/video/BVxxx 或 avxxx，或 b23.tv 短链）→ file.downloadMediaPage(pageUrl) → 用户确认后 file.placeDownload → file.verify；禁止对 B 站视频页用 file.downloadToTemp；③ 可直接 GET 的文件直链（常见 .exe/.msi/.zip/.dmg 等）→ file.downloadToTemp → place → verify；④ YouTube 或其它未支持主机/普通 HTML 页 → 不要调用 download*，如实说明当前仅支持 B 站视频页与文件直链，并点名不支持的主机。未确认 place 前不得声称已保存到最终目录。",
  "下载主路径（安装包/任意文件通用）：先拿到可直接 GET 的 http(s) 文件直链（URL 常以 .exe/.msi/.zip/.dmg 等结尾，或 Content-Disposition 指向文件），再 file.downloadToTemp → 用户确认后 file.placeDownload → file.verify；默认最终目录 D:\\AI\\void-runtime\\downloads。",
  "下载后整理（用户要求归入子目录/按日期或任务名归档）：file.placeDownload 落到默认下载根后，file.createDirectory 在允许根内建一层子目录（父目录须已存在，不递归）→ file.move(sourcePath=place 的 finalPath, destinationPath=子目录\\文件名) → file.verify；需要时先 file.listDirectory 看现状。汇报最终 destinationPath。用户只要下载不要整理时，place+verify 后收口。",
  "落盘后打开位置（T3.c）：仅当 place 已成功且用户要求「打开所在位置 / 显示文件夹 / 在资源管理器里看 / 帮我打开下载目录」时，再调 desktop.revealPath(path=finalPath 或所在目录)。未确认 place 前禁止 reveal，也不得声称已打开目录。用户只要下载不要打开时，place+verify（及可选整理）后收口，不要强行 reveal。失败如实报 PATH_NOT_ALLOWED / PATH_NOT_FOUND / 桥接不可达等，禁止假装已打开。",
  "禁止把「在官网反复 click 下载按钮」当主路径：file.downloadToTemp 只认直链，不会自动捕获浏览器按钮触发的下载。",
  "找直链：browser.search 结果里优先挑文件直链；否则 open 后 browser.extract 找 href 含安装包扩展名的链接。拿不到直链时，立刻用中文说明「当前只能下载直链文件，官网按钮下载尚不支持」，并给出你看到的官网 URL；不要空转 click/open 耗尽预算。",
  "拒绝确认或 PATH_NOT_ALLOWED / DESTINATION_EXISTS / CROSS_DEVICE_MOVE / PATH_NOT_FOUND 时不得声称已保存、已整理或已打开位置。",
  "找 B 站博主/视频：browser.search 必须设 engine=bilibili；不要只用全网搜索碰运气。",
  "B 站视频下载主路径：browser.search(engine=bilibili) → 向用户确认目标视频 → file.downloadMediaPage(pageUrl=该视频页) → 用户确认后 file.placeDownload → file.verify。需要整理时再接 createDirectory+move。不要对 B 站视频页调用 file.downloadToTemp（那是直链专用）。若报 YTDLP_NOT_FOUND / FFMPEG_NOT_FOUND，如实告诉用户需要本机安装 yt-dlp 与 ffmpeg。",
  "browser.open 只打开 Playwright 自动化窗口（用户可能在任务栏另见一个浏览器图标，不是日常浏览器）；缺省每次 open 新建标签页并返回 pageId。",
  "多页时用 browser.tabs 列 pageId/url/title，用 browser.switchTab 切活动标签；后续未传 pageId 的动作走活动页。",
  "用户要「打开给我看 / 在我浏览器里看」时：拿到真实视频 URL 后必须再调 browser.revealInSystemBrowser，用系统默认浏览器打开；汇报时写明完整 URL，并说明请到常用浏览器查看。",
  "页面内操作顺序：看不清结构或 selector 不稳 → browser.extract → 再用返回的 suggestedSelector，或 extract 的 role+name 做 browser.click / browser.type；无稳定位时用 text/href 收窄，禁止空猜。",
  "browser.click / browser.type 定位二选一：selector，或 role+name（无障碍 getByRole）；必须唯一匹配。browser.waitFor 用于导航后等待；禁止假装已点击/已输入。",
  "不要空口说「打开了」——只有工具返回成功证据后才能那样说，并带上标题与 URL。"
];

const FILE_TOOL_USE_SUFFIX = [
  "本轮只允许操作白名单根目录内的本地文件。",
  "查看用 file.listDirectory（只列当前一层，不递归）与 file.readText；新建一层目录用 file.createDirectory；移动/重命名用 file.move（同盘原子移动，绝不覆盖）；展示位置用 desktop.revealPath。",
  "下载后整理（文件已在默认下载根如 D:\\AI\\void-runtime\\downloads）：file.createDirectory 建一层子目录（如按日期 yyyy-mm-dd 或任务名；父目录须已存在）→ file.move 把已落盘文件移入 → file.verify；冲突用 refuse 或 rename，绝不覆盖。",
  "路径一律使用绝对路径。失败时如实说明 PATH_NOT_ALLOWED / DESTINATION_EXISTS / CROSS_DEVICE_MOVE / FILE_NOT_FOUND 等错误码。"
];

const DESKTOP_TOOL_USE_SUFFIX = [
  "本轮只允许使用受限桌面工具。",
  "用户要求打开「我的电脑 / 此电脑」时，只能调用 desktop.openKnownLocation 且 location=this_pc。",
  "禁止请求或声称执行任意程序、Shell、命令行或未注册系统位置。"
];

const CLIPBOARD_TOOL_USE_SUFFIX = [
  "本轮只允许使用系统剪贴板工具。",
  "clipboard.read 只读；clipboard.write 会覆盖剪贴板并需用户确认，禁止写入密码或密钥。",
  "本轮没有下载工具：若用户其实要下载剪贴板里的链接，需明确下载意图后再执行；不要假装已下载。"
];

export async function sendVoidMessage(
  userInput: string,
  conversationHistory: VoidConversationMessage[],
  modelConfig: ModelConfig,
  attachments: VoidConversationAttachment[] = [],
  onToken?: (token: string) => void,
  emotionContext?: string,
  affectContext?: string,
  runtimeOptions: VoidMessageRuntimeOptions = {}
) {
  const provider = getModelProvider(modelConfig.provider);
  const normalizedUserInput = buildUserInputWithAttachments(userInput, attachments);
  // 记忆召回：按本轮用户输入的话题只取相关分区的少量长期记忆，投影成一段可注入文本。
  // 空召回时 projectMemories 返回空串，buildSystemPrompt 据此跳过注入，零副作用。
  const memoryContext = projectMemories(retrieveMemories(userInput));
  const turnRoute = resolveTurnCapability(userInput, conversationHistory);
  const taskGate = runtimeOptions.behaviorDecision?.taskGate;
  const blockedByAffect = taskGate ? isBehaviorToolGateBlocked(taskGate) : false;
  const routeHasTools = turnRoute.allowedToolNames.length > 0;
  const relationshipToolRefusal = blockedByAffect && routeHasTools;
  const enableTools = runtimeOptions.enableTools !== false
    && Boolean(provider.supportsTools)
    && routeHasTools
    && !blockedByAffect;

  if (runtimeOptions.behaviorDecision) {
    appendTaskGateAudit(runtimeOptions.behaviorDecision, relationshipToolRefusal);
  }

  if (enableTools && !(await isVoidBridgeReachable(runtimeOptions.signal))) {
    const content = turnRoute.capability === "desktop"
      ? "本机控制组件未连接，所以现在不能打开“此电脑”。请启动 VOID 桌面端或本机控制服务后再试。"
      : "本机工具服务未连接，所以现在无法执行这项操作。请启动 VOID 桌面端或本机控制服务后再试。";
    onToken?.(content);
    return { content };
  }
  const messages: ProviderMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt(
        modelConfig,
        emotionContext,
        affectContext,
        memoryContext,
        enableTools,
        turnRoute.capability,
        normalizedUserInput,
        taskGate
      )
    },
    ...buildRequestConversationHistory(conversationHistory),
    { role: "user", content: normalizedUserInput }
  ];

  // soft/hard refuse 的工具回合仍让模型生成自然边界表达，但不暴露任何工具，
  // 并强制非流式后做事实校验，避免流式阶段先展示“已执行”的错误声称。
  if (relationshipToolRefusal && runtimeOptions.behaviorDecision) {
    try {
      const response = await provider.sendMessage(
        { messages, signal: runtimeOptions.signal },
        { ...modelConfig, streamEnabled: false }
      );
      const content = enforceRelationshipRefusalReply(
        response.content,
        runtimeOptions.behaviorDecision
      );
      onToken?.(content);
      return { content };
    } catch (error) {
      throw provider.mapError(error);
    }
  }

  // 支持 tools 的 provider：走 agent loop（非流式拿 tool_calls，最终回复一次性返回）
  if (enableTools) {
    try {
      const loopResult = await runAgentToolLoop({
        messages,
        modelConfig: {
          ...modelConfig,
          // 工具循环内部统一非流式；避免半截 tool_calls
          streamEnabled: false
        },
        requestConfirmation: runtimeOptions.requestConfirmation,
        onProgress: runtimeOptions.onProgress,
        signal: runtimeOptions.signal,
        allowedToolNames: turnRoute.allowedToolNames,
        taskGate
      });
      // 兼容旧调用方：若有 onToken，把最终文本整段推一次，便于显示层刷新
      if (onToken && loopResult.content) {
        onToken(loopResult.content);
      }
      return { content: loopResult.content };
    } catch (error) {
      throw provider.mapError(error);
    }
  }

  try {
    if (modelConfig.streamEnabled && provider.streamMessage) {
      return await provider.streamMessage({
        messages,
        onToken,
        signal: runtimeOptions.signal
      }, modelConfig);
    }

    return await provider.sendMessage({ messages, signal: runtimeOptions.signal }, modelConfig);
  } catch (error) {
    throw provider.mapError(error);
  }
}

function buildSystemPrompt(
  modelConfig: ModelConfig,
  emotionContext?: string,
  affectContext?: string,
  memoryContext?: string,
  enableTools = false,
  capability: TurnCapability = "conversation",
  latestUserInput = "",
  taskGate?: BehaviorDecision["taskGate"]
) {
  const sections = [VOID_SYSTEM_PROMPT];

  sections.push([
    "【本轮边界】",
    `只处理最新用户消息：「${clipForBoundaryHint(latestUserInput)}」。`,
    capability === "conversation"
      ? "本轮是普通对话，不调用任何工具，也不补做历史中的搜索、打开、下载或桌面操作。"
      : "历史仅用于理解指代，不得顺带补做上一轮未完成任务。"
  ].join(""));

  // 长期记忆召回上下文（可选）：排在人格之后、情绪与思考模式之前，
  // 让模型先建立「关于用户的已知事实」底座，再叠加本轮情绪与思考策略。缺省则不注入。
  if (memoryContext && memoryContext.trim()) {
    sections.push(memoryContext.trim());
  }

  if (modelConfig.thinkingModeEnabled) {
    sections.push(THINKING_MODE_SYSTEM_SUFFIX);
  }

  // 情绪系统的本轮情绪上下文（可选）。缺省则完全退回原有行为，零副作用。
  if (emotionContext && emotionContext.trim()) {
    sections.push(emotionContext.trim());
  }

  // 二期关系情感上下文（可选）：排在用户短时情绪之后、工具约束之前。
  // P3 同时消费 taskGate；Prompt 负责表达，硬 gate 负责真实行为。
  if (affectContext && affectContext.trim()) {
    sections.push(affectContext.trim());
  }

  if (taskGate && isBehaviorToolGateBlocked(taskGate)) {
    sections.push([
      "【本轮关系门禁】",
      "本轮普通、非安全工具已被真实关闭，任何下载、打开、移动、保存或写入都没有发生。",
      "请用简短、克制的中文表达边界，并明确本轮没有执行；禁止声称操作已完成，也不要输出工具协议。",
      taskGate.refuseMessageHint
    ].filter(Boolean).join("\n"));
  }

  // 工具短约束：仅在本轮启用 tools 时注入，不罗列全部参数 schema
  if (enableTools) {
    sections.push(buildToolUseSystemSuffix(capability));
  }

  return sections.join("\n\n");
}

function appendTaskGateAudit(
  behaviorDecision: BehaviorDecision,
  blockedTools: boolean
) {
  const taskGate = behaviorDecision.taskGate;
  const gateClosed = isBehaviorToolGateBlocked(taskGate);
  appendExecutionLog({
    taskId: `affect_gate_${Date.now().toString(36)}`,
    level: gateClosed ? "warn" : "info",
    event: "affect.task_gate.decided",
    message: blockedTools
      ? "关系情绪门禁已拦截非安全工具"
      : gateClosed
        ? "关系情绪门禁已关闭，本轮没有路由工具"
        : "关系情绪门禁允许本轮继续",
    data: {
      layer: "conversation",
      mood: taskGate.mood,
      grievance: taskGate.grievance,
      cooperation: behaviorDecision.cooperation,
      taskContext: taskGate.taskContext,
      blockedTools,
      reason: taskGate.reason
    }
  });
}

/** 拒绝回合没有工具证据；模型若仍声称完成操作，直接改成诚实边界回复。 */
function enforceRelationshipRefusalReply(
  content: string,
  behaviorDecision: BehaviorDecision
): string {
  const text = content.trim();
  const claimsExecution =
    /(?:已|已经|成功)(?:经)?(?:下载|打开|移动|保存|写入|创建|执行|完成)|(?:下载|打开|移动|保存|写入|创建|操作)(?:完成|成功|好了)/.test(text);
  if (text && !claimsExecution) {
    return text;
  }

  return formatBehaviorToolRefusal(behaviorDecision.taskGate);
}

function buildToolUseSystemSuffix(capability: TurnCapability) {
  const capabilityRules = capability === "browser"
    ? BROWSER_TOOL_USE_SUFFIX
    : capability === "file"
      ? FILE_TOOL_USE_SUFFIX
      : capability === "desktop"
        ? DESKTOP_TOOL_USE_SUFFIX
        : capability === "clipboard"
          ? CLIPBOARD_TOOL_USE_SUFFIX
          : [];
  return [...TOOL_USE_COMMON_SUFFIX, ...capabilityRules].join("");
}

export function createPendingAssistantConversation(
  conversationHistory: VoidConversationMessage[],
  userInput: string,
  attachments: VoidConversationAttachment[] = []
): VoidAssistantStreamState {
  const nextHistory: VoidConversationMessage[] = [
    ...conversationHistory,
    {
      role: "user",
      content: userInput.trim(),
      attachments: normalizeAttachments(attachments)
    },
    { role: "assistant", content: "" }
  ];

  return {
    history: nextHistory,
    assistantMessageIndex: nextHistory.length - 1
  };
}

export function applyAssistantStreamContent(
  streamState: VoidAssistantStreamState,
  content: string
): VoidConversationMessage[] {
  const nextHistory = [...streamState.history];
  nextHistory[streamState.assistantMessageIndex] = {
    role: "assistant",
    content: stripStageDirections(content).trimStart()
  };

  return nextHistory;
}

export function finalizeAssistantStreamContent(
  streamState: VoidAssistantStreamState,
  content: string
): VoidConversationMessage[] {
  const normalizedContent = stripStageDirections(content).trim();
  if (!normalizedContent) {
    return removeAssistantMessageAt(streamState.history, streamState.assistantMessageIndex);
  }

  const nextHistory = [...streamState.history];
  nextHistory[streamState.assistantMessageIndex] = {
    role: "assistant",
    content: normalizedContent
  };

  return nextHistory;
}

export function removeAssistantMessageAt(
  conversationHistory: VoidConversationMessage[],
  assistantMessageIndex: number
): VoidConversationMessage[] {
  return conversationHistory.filter((_, index) => index !== assistantMessageIndex);
}

export function clearCurrentConversationHistory() {
  window.localStorage.removeItem(CURRENT_CONVERSATION_STORAGE_KEY);
}

export function loadCurrentConversationHistory(): VoidConversationMessage[] {
  const rawHistory = window.localStorage.getItem(CURRENT_CONVERSATION_STORAGE_KEY);
  if (!rawHistory) {
    return [];
  }

  try {
    const parsedHistory = JSON.parse(rawHistory) as unknown;
    const storedMessages = extractStoredConversationMessages(parsedHistory);
    if (!storedMessages) {
      clearCurrentConversationHistory();
      return [];
    }

    return storedMessages
      .filter(isVoidConversationMessage)
      .map(normalizeStoredConversationMessage)
      .filter((message) => message.content);
  } catch {
    clearCurrentConversationHistory();
    return [];
  }
}

export function saveCurrentConversationHistory(conversationHistory: VoidConversationMessage[]) {
  const normalizedHistory = conversationHistory
    .filter(isVoidConversationMessage)
    .map(normalizeStoredConversationMessage)
    .filter((message) => message.content)
    .slice(-MAX_STORED_CONVERSATION_MESSAGES);

  if (!normalizedHistory.length) {
    clearCurrentConversationHistory();
    return;
  }

  const storedHistory = clipConversationByTotalCharacters(normalizedHistory, MAX_STORED_TOTAL_CHARACTERS);
  const payload: StoredConversationPayload = {
    version: CURRENT_CONVERSATION_STORAGE_VERSION,
    messages: storedHistory
  };

  window.localStorage.setItem(CURRENT_CONVERSATION_STORAGE_KEY, JSON.stringify(payload));
}

function extractStoredConversationMessages(value: unknown) {
  if (Array.isArray(value)) {
    return value;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const payload = value as Partial<StoredConversationPayload>;
  if (payload.version !== CURRENT_CONVERSATION_STORAGE_VERSION || !Array.isArray(payload.messages)) {
    return null;
  }

  return payload.messages;
}

function isVoidConversationMessage(value: unknown): value is VoidConversationMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const message = value as Partial<VoidConversationMessage>;
  return (message.role === "user" || message.role === "assistant") && typeof message.content === "string";
}

function normalizeStoredConversationMessage(message: VoidConversationMessage): VoidConversationMessage {
  const content = message.content.trim();
  const attachments = normalizeAttachments(message.attachments);

  return {
    role: message.role,
    content: content.length > MAX_STORED_MESSAGE_CHARACTERS
      ? content.slice(content.length - MAX_STORED_MESSAGE_CHARACTERS)
      : content,
    attachments
  };
}

function buildRequestConversationHistory(conversationHistory: VoidConversationMessage[]): ProviderMessage[] {
  const requestMessages: ProviderMessage[] = [];
  let remainingCharacters = MAX_REQUEST_HISTORY_CHARACTERS;

  for (const message of conversationHistory.slice(-MAX_REQUEST_HISTORY_MESSAGES).reverse()) {
    const content = message.content.trim();
    if (!content || shouldSkipRequestHistoryMessage(message.role, content)) {
      continue;
    }

    if (remainingCharacters <= 0) {
      break;
    }

    const clippedContent = content.length > remainingCharacters
      ? content.slice(content.length - remainingCharacters)
      : content;

    requestMessages.unshift({
      role: message.role,
      content: message.role === "user"
        ? buildUserInputWithAttachments(clippedContent, normalizeAttachments(message.attachments))
        : clippedContent
    });
    remainingCharacters -= clippedContent.length;
  }

  return requestMessages;
}

function clipConversationByTotalCharacters(conversationHistory: VoidConversationMessage[], maxTotalCharacters: number) {
  const clippedHistory: VoidConversationMessage[] = [];
  let totalCharacters = 0;

  for (const message of conversationHistory.slice().reverse()) {
    if (totalCharacters >= maxTotalCharacters) {
      break;
    }

    const remainingCharacters = maxTotalCharacters - totalCharacters;
    const clippedContent = message.content.length > remainingCharacters
      ? message.content.slice(message.content.length - remainingCharacters)
      : message.content;

    clippedHistory.unshift({
      role: message.role,
      content: clippedContent,
      attachments: normalizeAttachments(message.attachments)
    });
    totalCharacters += clippedContent.length;
  }

  return clippedHistory;
}

function shouldSkipRequestHistoryMessage(role: VoidConversationMessage["role"], content: string) {
  if (role !== "assistant") {
    return false;
  }

  return (
    content.startsWith("模型请求失败：")
    || content.startsWith("模型网络请求失败。")
    || content.startsWith("模型连接失败")
    || content.startsWith("正式模型代理不可用")
    // 工具预算耗尽/友好收口也跳过，避免下一轮被失败长文带偏
    || content.startsWith("工具循环超过")
    || content.startsWith("这轮工具操作没能完成")
  );
}

/** 边界提示里的用户原文截断，避免 system 提示过长 */
function clipForBoundaryHint(text: string, maxLength = 240): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength)}…`;
}

function buildUserInputWithAttachments(userInput: string, attachments?: VoidConversationAttachment[]) {
  const trimmedInput = userInput.trim();
  const normalizedAttachments = normalizeAttachments(attachments) ?? [];
  if (!normalizedAttachments.length) {
    return trimmedInput;
  }

  const attachmentBlock = normalizedAttachments.map((attachment) => {
    const clippedContent = attachment.content.length > MAX_ATTACHMENT_CONTENT_CHARACTERS
      ? attachment.content.slice(0, MAX_ATTACHMENT_CONTENT_CHARACTERS)
      : attachment.content;

    return [
      `文件名：${attachment.name}`,
      `文件类型：${attachment.mimeType || "text/plain"}`,
      "文件内容：",
      clippedContent
    ].join("\n");
  }).join("\n\n---\n\n");

  if (!trimmedInput) {
    return `以下是本轮附加文件内容，请结合文件内容回答：\n\n${attachmentBlock}`;
  }

  return `${trimmedInput}\n\n以下是本轮附加文件内容，请结合文件内容回答：\n\n${attachmentBlock}`;
}

function normalizeAttachments(attachments: VoidConversationAttachment[] | undefined) {
  if (!attachments?.length) {
    return undefined;
  }

  return attachments
    .filter((attachment) => attachment.name.trim() && attachment.content.trim())
    .map((attachment) => ({
      id: attachment.id,
      name: attachment.name.trim(),
      mimeType: attachment.mimeType.trim(),
      content: attachment.content.trim()
    }));
}
