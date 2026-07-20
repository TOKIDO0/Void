/**
 * 通用「软件安装包」意图识别。
 * 按语义类分流，不绑定斗鱼/B站等具体产品名。
 */

/**
 * 安装包/客户端/桌面软件获取意图。
 * 注意：不含「下载这个视频/BV」——那是媒体能力。
 */
const SOFTWARE_INSTALLER_INTENT_PATTERN =
  /(?:下载|获取|拉取|保存|装|安装).{0,24}(?:客户端|安装包|电脑版|桌面版|Windows\s*版|Win(?:dows)?版|官方(?:客户端|安装包)|软件安装包)|(?:客户端|安装包|电脑版|桌面版|Windows\s*版|Win(?:dows)?版|官方客户端).{0,16}(?:下载|获取|拉取|保存|安装)|(?:帮我|给我|想|要).{0,12}(?:装|安装|下载).{0,16}(?:客户端|安装包)/i;

/** 明显媒体视频下载：应走 media，不能进 software */
const MEDIA_DOWNLOAD_OVERRIDE_PATTERN =
  /(?:BV[\w]+|av\d+|视频|番剧|直播回放|这一集|这一期|这部|这个视频|下载视频|下个视频|缓存视频)/i;

/**
 * 是否应按 software 能力处理本轮输入。
 */
export function isSoftwareInstallerIntent(userInput: string): boolean {
  const text = userInput.trim();
  if (!text) {
    return false;
  }
  if (MEDIA_DOWNLOAD_OVERRIDE_PATTERN.test(text) && !/(?:客户端|安装包|电脑版|桌面版)/.test(text)) {
    return false;
  }
  return SOFTWARE_INSTALLER_INTENT_PATTERN.test(text);
}
