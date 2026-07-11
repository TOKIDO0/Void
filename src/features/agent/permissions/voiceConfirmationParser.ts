/**
 * 语音口头确认解析（阶段 F2）。
 *
 * 产品约束：
 * - 确认条仍是辅路径；主路径是用户说「好 / 取消」。
 * - 只在「当前确有 pending confirmation」时调用本解析器。
 * - 解析不到明确意图时返回 null，交给正常对话，禁止瞎批准。
 *
 * 设计取舍：
 * - 规则解析即可，不引入第二模型（低延迟、可审计、不重复造轮子）。
 * - 先剥口语填充，再整句匹配；避免「还好吧」被误判为批准。
 */

export type VoiceConfirmationIntent = "approve" | "reject";

const APPROVE_EXACT = new Set([
  "好",
  "好的",
  "好哒",
  "好啊",
  "好吧",
  "行",
  "行的",
  "行啊",
  "可以",
  "可以的",
  "确认",
  "确定",
  "同意",
  "批准",
  "通过",
  "继续",
  "执行",
  "开干",
  "没问题",
  "没有问题",
  "是的",
  "是",
  "对",
  "对的",
  "要",
  "要的",
  "下载",
  "打开",
  "ok",
  "okay",
  "yes",
  "yep",
  "yeah",
  "y"
]);

const REJECT_EXACT = new Set([
  "不",
  "不要",
  "不用",
  "不行",
  "不可以",
  "不好",
  "别",
  "别了",
  "算了",
  "取消",
  "拒绝",
  "停止",
  "停下",
  "暂停",
  "先别",
  "先不要",
  "不要下载",
  "不要打开",
  "no",
  "nope",
  "cancel",
  "stop"
]);

/**
 * 将用户语音/文本定稿解析为确认意图。
 * @returns approve | reject | null（无法判断则 null）
 */
export function parseVoiceConfirmationIntent(rawText: string): VoiceConfirmationIntent | null {
  const normalized = normalizeVoiceConfirmationText(rawText);
  if (!normalized) {
    return null;
  }

  // 明确拒绝优先：避免「不要好了」类歧义句误批
  if (isRejectPhrase(normalized)) {
    return "reject";
  }
  if (isApprovePhrase(normalized)) {
    return "approve";
  }
  return null;
}

/** 供 UI / 日志展示的规范化文本 */
export function normalizeVoiceConfirmationText(rawText: string): string {
  return rawText
    .trim()
    .toLowerCase()
    // 去掉空白与常见中英文标点，保留汉字/字母/数字
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function isApprovePhrase(text: string): boolean {
  if (APPROVE_EXACT.has(text)) {
    return true;
  }
  // 「好的谢谢」「确认执行」等短扩展：必须以批准核为整句主干
  if (/^(?:好的?|确认|确定|同意|可以|继续|执行|批准)(?:吧|啊|呀|了|的)?(?:谢谢|感谢|请)?$/.test(text)) {
    return true;
  }
  if (/^(?:yes|ok|okay)(?:please)?$/.test(text)) {
    return true;
  }
  return false;
}

function isRejectPhrase(text: string): boolean {
  if (REJECT_EXACT.has(text)) {
    return true;
  }
  if (/^(?:不要|不用|不行|不可以|别|取消|拒绝|停止|停下|算了)(?:了|吧|啊|呀)?(?:谢谢|感谢)?$/.test(text)) {
    return true;
  }
  if (/^(?:no|nope|cancel|stop)(?:please)?$/.test(text)) {
    return true;
  }
  // 「先不要下载 / 先别打开」
  if (/^先?(?:不要|别|不用).{0,6}$/.test(text) && /(?:下载|打开|执行|确认|继续|了|吧)?$/.test(text)) {
    return true;
  }
  return false;
}
