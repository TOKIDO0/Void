import type { ModelConfig } from "../settings/modelConfig";
import type { ProviderMessage } from "../../lib/model-providers/providerContract";
import { getModelProvider } from "../../lib/model-providers/providerRegistry";
import { VOID_SYSTEM_PROMPT } from "./voidSystemPrompt";
import { retrieveMemories } from "../memory/memoryRetriever";
import { projectMemories } from "../memory/memoryProjection";
import { runAgentToolLoop } from "./loop/agentToolLoop";
import type { ConfirmationDecision, ConfirmationRequest } from "./permissions";

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

/** 短约束：何时用工具。不把完整工具手册塞进 System Prompt。 */
const TOOL_USE_SYSTEM_SUFFIX = [
  "你可以通过函数工具操作浏览器、本机白名单目录与系统剪贴板。",
  "剪贴板：clipboard.read 只读；clipboard.write 会覆盖剪贴板并需用户确认，勿写密码。",
  "当用户要求搜索、打开网页、看视频、下载文件时，必须调用工具，禁止假装已经操作。",
  "下载链路：browser.search/selectTarget → file.downloadToTemp → 用户确认后 file.placeDownload → file.verify；默认最终目录 D:\\AI\\void-runtime\\downloads；拒绝确认或 PATH_NOT_ALLOWED 时不得声称已保存。",
  "本机文件整理：仅允许根内操作。查看用 file.listDirectory（只列当前一层，不递归）与 file.readText；新建一层目录用 file.createDirectory（父目录须已存在）；移动/重命名用 file.move（同盘原子移动，冲突默认 refuse，可 rename，绝不覆盖）；要在资源管理器里展示用 desktop.revealPath。",
  "用户说「整理刚下载的文件 / 建文件夹并移进去 / 打开所在位置」时，必须按 listDirectory → createDirectory → move → desktop.revealPath 这类工具链执行；路径一律用绝对路径。",
  "文件失败要如实说错误码：PATH_NOT_ALLOWED / DESTINATION_EXISTS / CROSS_DEVICE_MOVE / FILE_NOT_FOUND 等；禁止空口「已经移动/已经保存/已经打开文件夹」。",
  "找 B 站博主/视频：browser.search 必须设 engine=bilibili；不要只用全网搜索碰运气。",
  "browser.open 只打开 Playwright 自动化窗口（用户可能在任务栏另见一个浏览器图标，不是日常浏览器）；缺省每次 open 新建标签页并返回 pageId。",
  "多页时用 browser.tabs 列 pageId/url/title，用 browser.switchTab 切活动标签；后续未传 pageId 的动作走活动页。",
  "用户要「打开给我看 / 在我浏览器里看」时：拿到真实视频 URL 后必须再调 browser.revealInSystemBrowser，用系统默认浏览器打开；汇报时写明完整 URL，并说明请到常用浏览器查看。",
  "页面内操作顺序：看不清结构或 selector 不稳 → browser.extract → 再用返回的 suggestedSelector，或 extract 的 role+name 做 browser.click / browser.type；无稳定位时用 text/href 收窄，禁止空猜。",
  "browser.click / browser.type 定位二选一：selector，或 role+name（无障碍 getByRole）；必须唯一匹配。browser.waitFor 用于导航后等待；禁止假装已点击/已输入。",
  "不要空口说「打开了」——只有工具返回 openMode=system_default_browser 或 automation_window 成功后才能那样说，并带上标题与 URL。",
  "普通聊天不要调工具。参数缺失时先一句话确认，不要猜测。",
  "敏感步骤会请用户确认；拒绝后停止并如实说明。",
  "同一工具失败或空结果时不要死循环重试；换策略或向用户说明卡点。",
  "工具报「桥接不可达 / sidecar 未启动」时，如实告诉用户本机浏览器服务未启动、需启动后重试，禁止含糊说「不能操控浏览器」。",
  "最终用简洁中文汇报，不要输出 JSON 或内部字段名。"
].join("");

export async function sendVoidMessage(
  userInput: string,
  conversationHistory: VoidConversationMessage[],
  modelConfig: ModelConfig,
  attachments: VoidConversationAttachment[] = [],
  onToken?: (token: string) => void,
  emotionContext?: string,
  runtimeOptions: VoidMessageRuntimeOptions = {}
) {
  const provider = getModelProvider(modelConfig.provider);
  const normalizedUserInput = buildUserInputWithAttachments(userInput, attachments);
  // 记忆召回：按本轮用户输入的话题只取相关分区的少量长期记忆，投影成一段可注入文本。
  // 空召回时 projectMemories 返回空串，buildSystemPrompt 据此跳过注入，零副作用。
  const memoryContext = projectMemories(retrieveMemories(userInput));
  const enableTools = runtimeOptions.enableTools !== false && Boolean(provider.supportsTools);
  const messages: ProviderMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt(modelConfig, emotionContext, memoryContext, enableTools)
    },
    ...buildRequestConversationHistory(conversationHistory),
    { role: "user", content: normalizedUserInput }
  ];

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
        signal: runtimeOptions.signal
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
  memoryContext?: string,
  enableTools = false
) {
  const sections = [VOID_SYSTEM_PROMPT];

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

  // 工具短约束：仅在本轮启用 tools 时注入，不罗列全部参数 schema
  if (enableTools) {
    sections.push(TOOL_USE_SYSTEM_SUFFIX);
  }

  return sections.join("\n\n");
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
    content: content.trimStart()
  };

  return nextHistory;
}

export function finalizeAssistantStreamContent(
  streamState: VoidAssistantStreamState,
  content: string
): VoidConversationMessage[] {
  const normalizedContent = content.trim();
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
  );
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
