import { isSoftwareInstallerIntent } from "../software/softwareDownloadIntent";
import type { VoidConversationMessage } from "../voidConversation";
import { isResearchIntent } from "./researchIntent";

export type TurnCapability =
  | "conversation"
  | "agent"
  | "browser"
  | "file"
  | "desktop"
  | "clipboard"
  | "security"
  | "software";

export type TurnCapabilityRoute = {
  capability: TurnCapability;
  allowedToolNames: string[];
  resumedFromHistory: boolean;
};

/**
 * 浏览器/下载主路径工具。
 * T3.a：附带 list/createDirectory/move，使「下载并整理到子目录」可在同一能力回合完成，
 * 无需再切到纯 file 能力（纯 file 没有 download*）。
 * T3.c：附带 desktop.revealPath，使 place+verify 成功后可在同一回合打开落盘位置；
 * 不塞入 openKnownLocation 等其它桌面能力。
 */
const BROWSER_TOOL_NAMES = [
  "browser.open",
  "browser.search",
  "browser.selectTarget",
  "browser.revealInSystemBrowser",
  "browser.click",
  "browser.longPress",
  "browser.type",
  "browser.waitFor",
  "browser.extract",
  "browser.tabs",
  "browser.switchTab",
  "file.downloadToTemp",
  "file.downloadMediaPage",
  "file.downloadMedia",
  "file.placeDownload",
  "file.verify",
  "file.inspectPath",
  "file.findByName",
  "file.listRecentArtifacts",
  "file.listDirectory",
  "file.createDirectory",
  "file.move",
  "file.inspectWriteTarget",
  "file.writeText",
  "desktop.revealPath"
];

/**
 * T3.b：剪贴板 URL 下载。
 * 必须同时暴露 clipboard.read 与 download*；仅 clipboard 没有下载，仅 browser 读不到剪贴板。
 * 继承 BROWSER_TOOL_NAMES，因此同样含 T3.c 的 desktop.revealPath。
 */
const CLIPBOARD_DOWNLOAD_TOOL_NAMES = [
  "clipboard.read",
  ...BROWSER_TOOL_NAMES
];

const FILE_TOOL_NAMES = [
  "file.listDirectory",
  "file.inspectPath",
  "file.findByName",
  "file.listRecentArtifacts",
  "file.readText",
  "file.searchText",
  "file.inspectWriteTarget",
  "file.createDirectory",
  "file.move",
  "file.writeText",
  "file.verify",
  "desktop.revealPath"
];

const DESKTOP_TOOL_NAMES = [
  "desktop.openKnownLocation",
  "desktop.listInstalledApplications",
  "desktop.launchApplication",
  "desktop.revealPath"
];

const CLIPBOARD_TOOL_NAMES = [
  "clipboard.read",
  "clipboard.write"
];

const SECURITY_TOOL_NAMES = [
  "security.inspectLocalRuntime"
];

const FILE_WRITE_TARGET_INSPECT_TOOL_NAMES = [
  "file.inspectWriteTarget"
];

const FILE_PATH_INSPECT_TOOL_NAMES = [
  "file.inspectPath",
  "desktop.revealPath"
];

const FILE_FIND_BY_NAME_TOOL_NAMES = [
  "file.findByName",
  "file.inspectPath",
  "desktop.revealPath"
];

const FILE_RECENT_ARTIFACT_TOOL_NAMES = [
  "file.listRecentArtifacts",
  "desktop.revealPath"
];

const FILE_ORGANIZE_TOOL_NAMES = [
  "file.organizeDirectory",
  "desktop.revealPath"
];

const FILE_CREATE_EXCEL_TOOL_NAMES = [
  "browser.search",
  "browser.extract",
  "file.createExcel",
  "file.verify",
  "desktop.revealPath"
];

const FILE_CREATE_PPTX_TOOL_NAMES = [
  "browser.search",
  "browser.extract",
  "file.createPptx",
  "file.verify",
  "desktop.revealPath"
];

const FILE_CREATE_DOCX_TOOL_NAMES = [
  "browser.search",
  "browser.extract",
  "file.createDocx",
  "file.verify",
  "desktop.revealPath"
];

const FILE_LOCAL_EXCEL_TOOL_NAMES = [
  "file.searchText",
  "file.readText",
  "file.createExcel",
  "file.verify",
  "desktop.revealPath",
  "browser.search",
  "browser.extract"
];

const FILE_LOCAL_PPTX_TOOL_NAMES = [
  "file.searchText",
  "file.readText",
  "file.createPptx",
  "file.verify",
  "desktop.revealPath",
  "browser.search",
  "browser.extract"
];

const FILE_LOCAL_DOCX_TOOL_NAMES = [
  "file.searchText",
  "file.readText",
  "file.createDocx",
  "file.verify",
  "desktop.revealPath",
  "browser.search",
  "browser.extract"
];

const CONVERSATION_EXCEL_TOOL_NAMES = [
  "file.createExcel",
  "file.verify",
  "desktop.revealPath"
];

const CONVERSATION_PPTX_TOOL_NAMES = [
  "file.createPptx",
  "file.verify",
  "desktop.revealPath"
];

const CONVERSATION_DOCX_TOOL_NAMES = [
  "file.createDocx",
  "file.verify",
  "desktop.revealPath"
];

const CLIPBOARD_EXCEL_TOOL_NAMES = [
  "clipboard.read",
  "file.createExcel",
  "file.verify",
  "desktop.revealPath"
];

const CLIPBOARD_PPTX_TOOL_NAMES = [
  "clipboard.read",
  "file.createPptx",
  "file.verify",
  "desktop.revealPath"
];

const CLIPBOARD_DOCX_TOOL_NAMES = [
  "clipboard.read",
  "file.createDocx",
  "file.verify",
  "desktop.revealPath"
];

const CODE_OFFICE_EXCEL_TOOL_NAMES = [
  "agent.runCode",
  "file.createExcel",
  "file.verify",
  "desktop.revealPath"
];

const CODE_OFFICE_DOCX_TOOL_NAMES = [
  "agent.runCode",
  "file.createDocx",
  "file.verify",
  "desktop.revealPath"
];

const CODE_OFFICE_PPTX_TOOL_NAMES = [
  "agent.runCode",
  "file.createPptx",
  "file.verify",
  "desktop.revealPath"
];

const AGENT_TOOL_NAMES = [
  "agent.inspectCapabilities",
  "agent.inspectSkills"
];

const AGENT_TASK_PREFLIGHT_TOOL_NAMES = [
  "agent.planTaskRoute"
];

const AGENT_TOOL_CONTRACT_TOOL_NAMES = [
  "agent.inspectToolContract"
];

const AGENT_EXTENSION_POLICY_TOOL_NAMES = [
  "agent.inspectExtensionPolicy"
];

const AGENT_SAFETY_HOOK_TOOL_NAMES = [
  "agent.inspectSafetyHooks"
];

const AGENT_PRIVACY_BOUNDARY_TOOL_NAMES = [
  "agent.inspectPrivacyBoundaries"
];

const AGENT_TASK_PLAYBOOK_TOOL_NAMES = [
  "agent.inspectTaskPlaybooks"
];

const AGENT_RUN_CODE_TOOL_NAMES = [
  "agent.runCode"
];

// 阶段 Y（41 号文档）：本地技能库问询只暴露只读自检工具；必须先于 research/browser 判定，
// 否则「我有哪些技能」会被 RESEARCH_TOPIC_PATTERN 的「有哪些+？」句式劫持成网页检索。
const AGENT_SKILLS_TOOL_NAMES = [
  "agent.inspectSkills"
];

/**
 * 官方软件安装包自动化（通用领域，非某一站专线）。
 * list → resolve → downloadInstaller → 可选 revealPath。
 */
const SOFTWARE_TOOL_NAMES = [
  "software.listSupported",
  "software.resolveInstaller",
  "software.downloadInstaller",
  "desktop.revealPath"
];

const EXPLICIT_CONTINUATION_PATTERN = /^(?:继续|接着|接着做|继续刚才|接着刚才|把刚才|刚才那个|再试一次|重试)(?:[，。,.！!？?\s]|$)/;
const DESKTOP_APP_PATTERN = /(?:(?:打开|启动|运行|打开一下|启动一下).{0,10}(?:应用|程序|软件)|(?:应用|程序|软件).{0,8}(?:列表|有哪些|有什么))/;
const THIS_PC_PATTERN = /(?:打开|进入|显示|启动).{0,6}(?:我的电脑|此电脑|这台电脑)/;
const CLIPBOARD_PATTERN = /(?:(?:读取|查看|看看|写入|复制到|放到|清空).{0,6}(?:剪贴板|粘贴板)|(?:剪贴板|粘贴板).{0,6}(?:有什么|内容|读取|查看|写入|清空))/;
const FILE_PATTERN = /(?:(?:整理|列出|查看|读取|搜索|搜一下|查找|查一下|移动|重命名|新建|创建|保存|写入|写到|打开所在位置).{0,12}(?:本地文件|文本文件|文件夹|目录|路径|文件)|(?:本地文件|文本文件|文件夹|目录|路径|文件).{0,12}(?:有什么|里面|整理|列出|查看|读取|搜索|搜一下|查找|查一下|移动|重命名|新建|创建|保存|写入|写到|打开所在位置)|(?:保存|写入|写到).{0,16}(?:txt|md|markdown|json|csv|文本)|[A-Za-z]:\\[^\n]{0,80}(?:有什么|里面|列出|查看|整理|搜索|查找|保存|写入))/;
const LOCAL_KNOWLEDGE_SOURCE_PATTERN =
  /(?:(?:本地|电脑|磁盘|仓库|项目|目录|文件夹|路径).{0,16}(?:资料|文档|笔记|知识库|文件)|(?:资料|文档|笔记|知识库|文件).{0,16}(?:本地|电脑|磁盘|仓库|项目|目录|文件夹|路径))/i;
const LOCAL_KNOWLEDGE_ACTION_PATTERN =
  /(?:搜索|搜一下|搜一搜|查找|查一下|检索|找一下|读取|查看|总结|汇总|整理|归纳|提炼|保存|写入|写到|导出|输出)/i;
const TEXT_ARTIFACT_SAVE_PATTERN =
  /(?:(?:保存|写入|写到|存成|另存为|导出|输出).{0,24}(?:txt|md|markdown|json|csv|文本文件|文本|报告|清单|摘要|结果|资料|笔记|文件)|(?:txt|md|markdown|json|csv|文本文件).{0,16}(?:保存|写入|写到|存成|另存为|导出|输出))/i;
const FILE_WRITE_TARGET_INSPECT_PATTERN =
  /(?:(?:写入|保存|写到|输出|导出|file\.writeText).{0,32}(?:预检|检查|查看|看看|确认|评估).{0,32}(?:目标|路径|文件名|会不会覆盖|是否覆盖|是否存在|冲突|安全)|(?:预检|检查|查看|看看|确认|评估).{0,32}(?:写入|保存|写到|输出|导出).{0,32}(?:目标|路径|文件名|会不会覆盖|是否覆盖|是否存在|冲突|安全)|(?:会不会|是否).{0,8}(?:覆盖|冲突).{0,32}(?:保存|写入|写到|输出|导出|目标文件|文件名|路径))/i;
const FILE_PATH_INSPECT_PATTERN =
  /(?:(?:检查|查看|看看|确认|预检|识别|判断).{0,24}(?:路径|文件|目录).{0,24}(?:存在|类型|大小|字节|能不能读|能否读|能否读取|可读|是否可读|敏感|元数据|信息)|(?:路径|文件|目录).{0,24}(?:存在吗|是否存在|是什么类型|多大|多少字节|能不能读|能否读|能否读取|可读吗|是否敏感|元数据|信息)|[A-Za-z]:\\[^\n]{0,120}(?:存在吗|是否存在|是什么类型|类型|多大|多少字节|能不能读|能否读|能否读取|是否敏感|元数据|信息))/i;
const FILE_FIND_BY_NAME_PATTERN =
  /(?:(?:按|根据|用)?.{0,8}(?:文件名|目录名|名字|名称|name).{0,32}(?:找|查找|搜索|搜一下|定位|包含|含有|匹配)|(?:找|查找|搜索|搜一下|定位).{0,32}(?:文件名|目录名|名字|名称|name)|[A-Za-z]:\\[^\n]{0,120}(?:找|查找|搜索|搜一下|定位).{0,32}(?:文件名|目录名|名字|名称).{0,24}(?:包含|含有|匹配|叫|为)?)/i;
const FILE_RECENT_ARTIFACT_PATTERN =
  /(?:(?:刚才|最近|最新|上次).{0,16}(?:保存|下载|写入|导出|生成).{0,20}(?:文件|产物|报告|结果|位置|在哪|哪里)|(?:保存|下载|写入|导出|生成).{0,16}(?:的文件|的产物|的报告|的结果).{0,20}(?:在哪|哪里|位置|列表|列出|查看|看看|打开所在位置|显示)|(?:列出|查看|看看|显示).{0,16}(?:最近|最新).{0,16}(?:文件|下载|保存|产物|报告|结果))/i;
const FILE_ORGANIZE_PATTERN =
  /(?:整理|归档|分类).{0,12}下载(?:文件夹|目录|文件)?|下载(?:文件夹|目录|文件)?.{0,12}(?:整理|归档|分类)|(?:把|将).{0,12}下载.{0,12}(?:整理|归档|分类)/i;
const FILE_CREATE_EXCEL_PATTERN =
  /(?:生成|做成|创建|导出|整理).{0,16}(?:excel|xlsx|表格|报表)|(?:excel|xlsx|表格|报表).{0,16}(?:生成|做成|创建|导出|整理)/i;
const FILE_CREATE_PPTX_PATTERN =
  /(?:生成|做成|创建|导出).{0,16}(?:ppt|pptx|演示文稿|幻灯片|演示稿)|(?:ppt|pptx|演示文稿|幻灯片).{0,16}(?:生成|做成|创建|导出)/i;
const FILE_CREATE_DOCX_PATTERN =
  /(?:生成|做成|创建|导出).{0,16}(?:word|docx|文档|报告|方案|合同|说明书)|(?:word|docx|文档|报告).{0,16}(?:生成|做成|创建|导出)/i;
const LOCAL_OFFICE_EXCEL_PATTERN = /(?:excel|xlsx|表格|报表)/i;
const LOCAL_OFFICE_PPTX_PATTERN = /(?:ppt|pptx|演示文稿|幻灯片|演示稿)/i;
const LOCAL_OFFICE_DOCX_PATTERN = /(?:word|docx|文档|报告)/i;
const WEB_TEXT_ARTIFACT_SOURCE_PATTERN =
  /(?:网页|网站|网址|链接|URL|http:\/\/|https:\/\/|搜索结果|检索结果|查到的|搜到的|新闻|报道|来源|官网|页面摘要|网页摘要)/i;
const EXPLICIT_WEB_SOURCE_PATTERN =
  /(?:网页|网站|网址|链接|URL|http:\/\/|https:\/\/|官网|页面摘要|网页摘要)/i;
const EXPLICIT_HTTP_URL_ACTION_PATTERN =
  /(?:打开|访问|进入|查看|看一下|看下|下载|保存|抓取|读取|读一下).{0,24}https?:\/\//i;
const LOCAL_RUNTIME_SECURITY_PATTERN =
  /(?:(?:检查|自检|看看|看一下|确认|排查).{0,18}(?:本地|VOID|void|bridge|工具服务|sidecar|运行时|runtime).{0,24}(?:安全|端口|暴露|监听|token|CORS|Host|回环|资源限制|请求体|并发|会话上限)|(?:本地|VOID|void|bridge|工具服务|sidecar|运行时|runtime).{0,18}(?:安全自检|安全状态|安全配置|安全检查|端口暴露|监听安全|token 配置|CORS 配置|Host 校验|资源限制|代理并发|浏览器会话上限)|(?:端口|监听).{0,12}(?:有没有|是否|是否有|会不会|被|对外).{0,12}(?:暴露|开放|泄露)|(?:代理并发|请求体上限|资源限制|浏览器会话上限|会话上限).{0,16}(?:检查|自检|安全|配置|状态|有没有|是否))/i;
const AGENT_CAPABILITY_INSPECT_PATTERN =
  /(?:(?:你|VOID|void|agent|Agent).{0,16}(?:能做什么|会做什么|有哪些能力|有什么能力|有哪些工具|有什么工具|工具列表|能力列表|当前能力|当前工具)|(?:列出|查看|检查|说明|介绍).{0,12}(?:你的|VOID|void|agent|Agent).{0,12}(?:能力|工具)|(?:能力自检|工具自检|Agent 自检|agent 自检|grok inspect))/i;
const AGENT_TOOL_CONTRACT_PATTERN =
  /(?:(?:file|browser|agent|security|software|clipboard|desktop)\.[A-Za-z][A-Za-z0-9.]*.{0,48}(?:契约|权限|风险|安全吗|安全|需要确认|确认|输出|来源|资源|审计|说明|介绍)|(?:解释|说明|查看|检查).{0,24}(?:file|browser|agent|security|software|clipboard|desktop)\.[A-Za-z][A-Za-z0-9.]*|(?:工具|tool|Tool).{0,28}(?:契约|权限|风险|安全吗|安全|需要确认|输出来源|资源|审计))/i;
const AGENT_EXTENSION_POLICY_PATTERN =
  /(?:(?:VOID|void|agent|Agent|你).{0,20}(?:插件|扩展|扩展机制|MCP|skills?|Skill|hooks?|Hook|subagents?|子\s*Agent).{0,32}(?:安全吗|安全|边界|权限|能力|有哪些|有没有|会不会|是否|执行|启用|禁用|暴露|接入|支持)|(?:插件|扩展|扩展机制|MCP|skills?|Skill|hooks?|Hook|subagents?|子\s*Agent).{0,32}(?:安全吗|安全边界|边界|权限|会不会执行|会不会泄露|会不会启动|有没有|有哪些|是否启用|是否禁用|是否暴露|执行入口|接入策略|白名单|审计|风险)|(?:检查|查看|说明|介绍|自检).{0,24}(?:插件|扩展|扩展机制|MCP|skills?|Skill|hooks?|Hook|subagents?|子\s*Agent).{0,24}(?:安全|边界|权限|策略|状态|入口)?)/i;
const AGENT_SAFETY_HOOK_PATTERN =
  /(?:(?:动态安全|安全\s*hook|安全规则|确认规则|风险\s*hook|风险规则).{0,40}(?:有哪些|是什么|说明|查看|检查|触发|需要确认|要求确认|升为|抬升|L2|风险)|(?:哪些|什么).{0,18}(?:操作|URL|网址|链接|路径|文件|情况).{0,32}(?:需要确认|要求确认|会触发确认|会升为\s*L2|会被拦截|有风险)|(?:为什么|为何).{0,30}(?:localhost|127\.0\.0\.1|私网|内网|\.env|SSH\s*私钥|密钥文件|敏感文件|\.pem|\.key).{0,30}(?:确认|L2|风险|拦截))/i;
const AGENT_PRIVACY_BOUNDARY_PATTERN =
  /(?:(?:VOID|void|agent|Agent|你).{0,24}(?:隐私|数据|资料|记忆|上下文|文件内容|API\s*Key|token|密钥|语音|音频).{0,40}(?:会不会泄露|会不会外发|会不会发到云端|是否离开本机|离开本机|发给谁|传到哪里|数据流|边界|安全吗|安全边界)|(?:哪些|什么).{0,20}(?:数据|资料|内容|上下文|记忆|文件|音频|语音).{0,40}(?:离开本机|发到云端|发给模型|发给语音服务|会外发|会泄露|会上传)|(?:检查|查看|说明|介绍|自检).{0,24}(?:隐私|数据边界|数据流|本地边界|本地优先|去中心化|泄露风险|模型上下文|语音数据|记忆隐私).{0,24}(?:安全|边界|策略|状态)?|(?:本地语义检索|embedding|向量|记忆原文).{0,36}(?:云端|离开本机|外发|上传|发给谁|隐私|安全吗))/i;
const AGENT_TASK_PLAYBOOK_PATTERN =
  /(?:(?:VOID|void|agent|Agent|你).{0,24}(?:任务模板|任务范式|工作流|playbook|recipes?|slash\s*commands?|组合任务|自动化流程|常用流程|用法示例|使用示例).{0,36}(?:有哪些|是什么|列出|查看|说明|介绍|推荐|示例|例子|清单|怎么用)|(?:有哪些|推荐|列出|查看|说明|介绍).{0,24}(?:任务模板|任务范式|工作流|playbook|recipes?|组合任务|自动化流程|常用流程|用法示例|使用示例)|(?:怎么|如何).{0,12}(?:使用|用好|更高效地用|让).{0,20}(?:VOID|void|agent|Agent|你).{0,24}(?:做任务|完成任务|自动化|工作流|组合任务))/i;
// 技能库问询：中文「技能」+ 列举/查看/用法语义；不含执行动作词，不误伤「用日报技能搜新闻」这类后续真实任务。
const AGENT_SKILLS_PATTERN =
  /(?:(?:我|你|VOID|void|agent|Agent).{0,8}(?:有哪些|有什么|装了|安装了|启用了?)(?:的)?技能|(?:列出|查看|看看|检查|说明|介绍|打开).{0,10}技能(?:库|列表|清单)|技能(?:库|列表|清单)(?:里|中|都有|有)?(?:有什么|有哪些|是什么|怎么样)|(?:怎么用|如何用|怎么使用).{0,8}技能)/;
const CODE_RUN_PATTERN =
  /(?:执行|运行).{0,12}(?:js|javascript|python|代码|脚本)|(?:代码沙箱|受限执行|沙箱|runCode)|(?:帮我|请).{0,12}(?:计算|算一下|算下|统计|求和|求平均|跑一下).{0,12}(?:代码|js|python|公式|数据|平均值|总和|表格|数值|结果)|(?:用\s*(?:js|javascript|python).{0,16}(?:算|计算|执行|运行|统计|转换|清洗|处理))|(?:算一下|计算一下|统计一下|求和|求平均).{0,16}(?:平均值|总和|数据|表格|数值|结果|公式|CSV|JSON|Excel)|(?:CSV|JSON|表格).{0,16}(?:转换|清洗|处理).{0,16}(?:js|javascript|python)|(?:用\s*(?:js|javascript|python).{0,16}转换)/i;
const AGENT_TASK_PREFLIGHT_PATTERN =
  /(?:(?:先别执行|不要执行|不执行|别真的执行|只做计划|只说计划|只看计划|预演|干跑|dry[-\s]?run).{0,28}(?:会用哪些工具|用哪些工具|需要哪些工具|怎么做|会怎么做|怎么执行|风险|需要确认)|(?:如果我要|假如我要|这个任务|这件事).{0,48}(?:会用哪些工具|用哪些工具|需要哪些工具|会怎么做|怎么执行|有什么风险|需要确认吗)|(?:会用哪些工具|需要哪些工具).{0,32}(?:下载|保存|搜索|读取|打开|整理|写入|安装|检查))/i;
const REQUEST_SAFETY_PREFLIGHT_PATTERN =
  /(?:(?:这个|这条|这个操作|这件事|这个请求|这一步|链接|URL|路径|文件).{0,48}(?:安全吗|是否安全|风险|会不会泄露|需要确认|为什么要确认)|(?:打开|访问|下载|读取|读|保存|写入).{0,80}(?:https?:\/\/|localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.|\.env|id_rsa|\.pem|\.key).{0,48}(?:安全吗|是否安全|风险|需要确认|会不会)|(?:检查|评估|看看|看下).{0,80}(?:https?:\/\/|localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.|\.env|id_rsa|\.pem|\.key).{0,80}(?:安全|风险|需要确认|泄露))/i;

const BRIDGE_REQUIRED_CAPABILITIES: ReadonlySet<TurnCapability> = new Set([
  "browser",
  "file",
  "desktop",
  "clipboard",
  "software",
  "security"
]);

/**
 * 浏览器/网页/平台动作意图。
 * 覆盖口语「打开快手」「打开最新视频」「在 Edge 打开」「点赞/三连/评论」等，
 * 避免被误判为普通聊天后模型只能空口解释或教用户手动命令。
 * 仍不覆盖「打开此电脑」——那条由 THIS_PC_PATTERN 优先接管。
 */
const KNOWN_WEB_PLATFORM_PATTERN =
  /(?:B\s*站|哔哩哔哩|bilibili|抖音|快手|小红书|微博|知乎|YouTube|youtu\.be|淘宝|京东|拼多多|百度|谷歌|google|推特|twitter|x\.com|instagram|tiktok)/i;
const BROWSER_PATTERN = new RegExp(
  [
    // 显式搜索 / 下载 / 网页
    "(?:搜索|搜一下|搜一搜|帮我搜|给我搜|查一下|上网查|联网查|网上查|官网|网址|下载|安装包)",
    // 显式浏览器/网页打开
    "(?:打开网页|打开网站|用浏览器打开|在浏览器(?:里|中)?打开|浏览器里打开)",
    // 指定浏览器品牌打开（系统默认浏览器 reveal；不能保证一定是 Edge，但必须进工具路径）
    "(?:(?:用|在)?(?:edge|chrome|微软?edge|谷歌(?:浏览器)?|chrome浏览器).{0,12}打开|打开.{0,12}(?:edge|chrome|微软?edge))",
    // 打开已知平台 / App 名 / 主页 / 最新视频
    `(?:(?:打开|进入|访问|去|看看|看一下|看下).{0,16}${KNOWN_WEB_PLATFORM_PATTERN.source})`,
    `(?:${KNOWN_WEB_PLATFORM_PATTERN.source}.{0,16}(?:打开|搜索|搜|找|进入|主页|首页|视频|直播|博主|up主))`,
    // 视频/博主导航口语
    "(?:打开.{0,16}(?:视频|主页|首页|博主|up主|直播间)|(?:最新|最近).{0,8}(?:一期|一集|视频)|(?:这个|该|那个).{0,8}(?:博主|up主|视频).{0,12}(?:打开|最新|主页))",
    // 找视频/博主
    "(?:找.{0,8}(?:视频|博主|up主|主播)|(?:B站|哔哩哔哩).{0,8}(?:搜索|找|打开|看))",
    // 社交互动意图（先进入 browser 工具组；具体能力后续切片实现，至少不再当闲聊）
    "(?:点赞|三连|收藏|投币|转发|关注|评论区|评论一下|评论这个|写评论|发评论)"
  ].join("|"),
  "i"
);

/**
 * 进行中的下载/拉取意图（区别于「下载目录」「下载好的文件」这类本地整理指代）。
 * 命中时即使也匹配 FILE_PATTERN，也必须走 browser，否则没有 download* 工具。
 */
const ACTIVE_DOWNLOAD_INTENT_PATTERN =
  /(?:帮我|请)?(?:去)?(?:下载|抓取|拉取)(?!目录|文件夹|路径|好|完|过的?)(?:一[个下]|这个|该|到|并|视频|文件|安装包|[，。！？\s]|$)|(?:把|将).{0,12}下载到|(?:B\s*站|哔哩哔哩|视频页|BV[\w]+).{0,16}下载/i;

/**
 * T3.b：明确「从剪贴板/粘贴板取链接并下载」。
 * 覆盖「下载剪贴板里的链接」「把剪贴板的 URL 下载下来」等；纯查看剪贴板不命中。
 */
const CLIPBOARD_DOWNLOAD_INTENT_PATTERN =
  /(?:剪贴板|粘贴板).{0,20}(?:下载|拉取|抓取|保存)|(?:下载|拉取|抓取|保存).{0,20}(?:剪贴板|粘贴板)|(?:把|将).{0,10}(?:剪贴板|粘贴板).{0,16}(?:下载|保存|拉取|抓取)|(?:剪贴板|粘贴板).{0,12}(?:链接|网址|url|URL).{0,12}(?:下载|拉取|抓取|保存)/i;

/**
 * 只判断“本轮允许暴露哪些能力”，不执行工具，也不做副作用。
 * 高置信动作词才进入工具路径；其余输入默认按普通对话处理。
 */
export function resolveTurnCapability(
  userInput: string,
  history: VoidConversationMessage[]
): TurnCapabilityRoute {
  const normalizedInput = userInput.trim();
  const directRoute = classifyDirectCapability(normalizedInput);
  if (directRoute.capability !== "conversation") {
    return directRoute;
  }

  if (EXPLICIT_CONTINUATION_PATTERN.test(normalizedInput)) {
    const previousUserMessage = [...history]
      .reverse()
      .find((message) => message.role === "user" && message.content.trim());
    if (previousUserMessage) {
      const previousRoute = classifyDirectCapability(previousUserMessage.content);
      if (previousRoute.capability !== "conversation") {
        return { ...previousRoute, resumedFromHistory: true };
      }
    }
  }

  return directRoute;
}

function classifyDirectCapability(userInput: string): TurnCapabilityRoute {
  if (AGENT_TOOL_CONTRACT_PATTERN.test(userInput)) {
    return createRoute("agent", AGENT_TOOL_CONTRACT_TOOL_NAMES);
  }

  // 阶段 Y：技能库问询先于 research/browser 判定，防「有哪些+？」句式被劫持成网页检索
  if (AGENT_SKILLS_PATTERN.test(userInput)) {
    return createRoute("agent", AGENT_SKILLS_TOOL_NAMES);
  }

  if (AGENT_EXTENSION_POLICY_PATTERN.test(userInput)) {
    return createRoute("agent", AGENT_EXTENSION_POLICY_TOOL_NAMES);
  }

  if (AGENT_SAFETY_HOOK_PATTERN.test(userInput)) {
    return createRoute("agent", AGENT_SAFETY_HOOK_TOOL_NAMES);
  }

  if (AGENT_PRIVACY_BOUNDARY_PATTERN.test(userInput)) {
    return createRoute("agent", AGENT_PRIVACY_BOUNDARY_TOOL_NAMES);
  }

  // 代码结果一键落盘为办公文档：算完直接生成表格/报告/演示
  if (isCodeOfficeIntent(userInput, LOCAL_OFFICE_EXCEL_PATTERN)) {
    return createRoute("file", CODE_OFFICE_EXCEL_TOOL_NAMES);
  }
  if (isCodeOfficeIntent(userInput, LOCAL_OFFICE_PPTX_PATTERN)) {
    return createRoute("file", CODE_OFFICE_PPTX_TOOL_NAMES);
  }
  if (isCodeOfficeIntent(userInput, LOCAL_OFFICE_DOCX_PATTERN)) {
    return createRoute("file", CODE_OFFICE_DOCX_TOOL_NAMES);
  }

  if (CODE_RUN_PATTERN.test(userInput)) {
    return createRoute("agent", AGENT_RUN_CODE_TOOL_NAMES);
  }

  if (AGENT_TASK_PLAYBOOK_PATTERN.test(userInput)) {
    return createRoute("agent", AGENT_TASK_PLAYBOOK_TOOL_NAMES);
  }

  if (AGENT_TASK_PREFLIGHT_PATTERN.test(userInput) || REQUEST_SAFETY_PREFLIGHT_PATTERN.test(userInput)) {
    return createRoute("agent", AGENT_TASK_PREFLIGHT_TOOL_NAMES);
  }

  if (AGENT_CAPABILITY_INSPECT_PATTERN.test(userInput)) {
    return createRoute("agent", AGENT_TOOL_NAMES);
  }

  if (LOCAL_RUNTIME_SECURITY_PATTERN.test(userInput)) {
    return createRoute("security", SECURITY_TOOL_NAMES);
  }

  if (DESKTOP_APP_PATTERN.test(userInput)) {
    return createRoute("desktop", DESKTOP_TOOL_NAMES);
  }

  if (THIS_PC_PATTERN.test(userInput)) {
    return createRoute("desktop", DESKTOP_TOOL_NAMES);
  }

  // 已废弃：白名单自动下载改为通用“打开官网下载页”；software 能力保留作兼容，不再作为主路径。
  // 客户端/安装包类请求统一走 browser（搜索官网→打开页面让用户自行下载），避免白名单的普遍性缺陷。
  if (isSoftwareInstallerIntent(userInput)) {
    return createRoute("browser", BROWSER_TOOL_NAMES);
  }

  // T3.b：剪贴板 URL 下载优先于纯剪贴板；capability 仍为 browser（下载主路径 + 整理）
  if (CLIPBOARD_DOWNLOAD_INTENT_PATTERN.test(userInput)) {
    return createRoute("browser", CLIPBOARD_DOWNLOAD_TOOL_NAMES);
  }

  // 剪贴板表格/内容一键整理为办公文档：复制后直接整理成 Excel/PPT/Word
  if (isClipboardOfficeIntent(userInput, LOCAL_OFFICE_EXCEL_PATTERN)) {
    return createRoute("file", CLIPBOARD_EXCEL_TOOL_NAMES);
  }
  if (isClipboardOfficeIntent(userInput, LOCAL_OFFICE_PPTX_PATTERN)) {
    return createRoute("file", CLIPBOARD_PPTX_TOOL_NAMES);
  }
  if (isClipboardOfficeIntent(userInput, LOCAL_OFFICE_DOCX_PATTERN)) {
    return createRoute("file", CLIPBOARD_DOCX_TOOL_NAMES);
  }

  if (CLIPBOARD_PATTERN.test(userInput)) {
    // 「读取剪贴板并下载」等：CLIPBOARD 命中但含下载意图 → 升级为剪贴板+下载工具组
    if (ACTIVE_DOWNLOAD_INTENT_PATTERN.test(userInput)) {
      return createRoute("browser", CLIPBOARD_DOWNLOAD_TOOL_NAMES);
    }
    return createRoute("clipboard", CLIPBOARD_TOOL_NAMES);
  }

  if (EXPLICIT_HTTP_URL_ACTION_PATTERN.test(userInput)) {
    return createRoute("browser", BROWSER_TOOL_NAMES);
  }

  if (FILE_WRITE_TARGET_INSPECT_PATTERN.test(userInput)) {
    return createRoute("file", FILE_WRITE_TARGET_INSPECT_TOOL_NAMES);
  }

  if (FILE_PATH_INSPECT_PATTERN.test(userInput)) {
    return createRoute("file", FILE_PATH_INSPECT_TOOL_NAMES);
  }

  if (FILE_FIND_BY_NAME_PATTERN.test(userInput)) {
    return createRoute("file", FILE_FIND_BY_NAME_TOOL_NAMES);
  }

  if (
    FILE_RECENT_ARTIFACT_PATTERN.test(userInput)
    && !shouldRouteTextArtifactThroughBrowser(userInput)
  ) {
    return createRoute("file", FILE_RECENT_ARTIFACT_TOOL_NAMES);
  }

  if (FILE_ORGANIZE_PATTERN.test(userInput)) {
    return createRoute("file", FILE_ORGANIZE_TOOL_NAMES);
  }

  // 对话历史一键整理为办公文档：把本轮聊天/讨论直接导出为 Excel/PPT/Word，无需再搜本地或网页
  if (isConversationDigestIntent(userInput, LOCAL_OFFICE_EXCEL_PATTERN)) {
    return createRoute("file", CONVERSATION_EXCEL_TOOL_NAMES);
  }
  if (isConversationDigestIntent(userInput, LOCAL_OFFICE_PPTX_PATTERN)) {
    return createRoute("file", CONVERSATION_PPTX_TOOL_NAMES);
  }
  if (isConversationDigestIntent(userInput, LOCAL_OFFICE_DOCX_PATTERN)) {
    return createRoute("file", CONVERSATION_DOCX_TOOL_NAMES);
  }

  // 健康档案/记忆清单一键导出为办公文档：本地敏感/任务数据直达办公生成，不走网页检索
  if (isHealthMemoryOfficeIntent(userInput, LOCAL_OFFICE_EXCEL_PATTERN)) {
    return createRoute("file", CONVERSATION_EXCEL_TOOL_NAMES);
  }
  if (isHealthMemoryOfficeIntent(userInput, LOCAL_OFFICE_PPTX_PATTERN)) {
    return createRoute("file", CONVERSATION_PPTX_TOOL_NAMES);
  }
  if (isHealthMemoryOfficeIntent(userInput, LOCAL_OFFICE_DOCX_PATTERN)) {
    return createRoute("file", CONVERSATION_DOCX_TOOL_NAMES);
  }

  // 本地资料聚合生成办公产物：先于通用办公与纯本地检索，使“把本地销售数据整理成Excel/报表”等可一轮同时搜本地+生成
  if (isLocalOfficeIntent(userInput, LOCAL_OFFICE_EXCEL_PATTERN)) {
    return createRoute("file", FILE_LOCAL_EXCEL_TOOL_NAMES);
  }
  if (isLocalOfficeIntent(userInput, LOCAL_OFFICE_PPTX_PATTERN)) {
    return createRoute("file", FILE_LOCAL_PPTX_TOOL_NAMES);
  }
  if (isLocalOfficeIntent(userInput, LOCAL_OFFICE_DOCX_PATTERN)) {
    return createRoute("file", FILE_LOCAL_DOCX_TOOL_NAMES);
  }

  // 写作/模板直出办公文档：无网页/本地/剪贴板/代码线索时，不做检索，直接生成
  if (isDirectOfficeIntent(userInput, LOCAL_OFFICE_EXCEL_PATTERN)) {
    return createRoute("file", CONVERSATION_EXCEL_TOOL_NAMES);
  }
  if (isDirectOfficeIntent(userInput, LOCAL_OFFICE_PPTX_PATTERN)) {
    return createRoute("file", CONVERSATION_PPTX_TOOL_NAMES);
  }
  if (isDirectOfficeIntent(userInput, LOCAL_OFFICE_DOCX_PATTERN)) {
    return createRoute("file", CONVERSATION_DOCX_TOOL_NAMES);
  }

  if (FILE_CREATE_EXCEL_PATTERN.test(userInput)) {
    return createRoute("file", FILE_CREATE_EXCEL_TOOL_NAMES);
  }

  if (FILE_CREATE_PPTX_PATTERN.test(userInput)) {
    return createRoute("file", FILE_CREATE_PPTX_TOOL_NAMES);
  }

  if (FILE_CREATE_DOCX_PATTERN.test(userInput)) {
    return createRoute("file", FILE_CREATE_DOCX_TOOL_NAMES);
  }

  // 本地资料/文档检索闭环：让「在本地资料里搜并整理成报告」稳定进入 file 工具组。
  if (isLocalKnowledgeFileIntent(userInput)) {
    return createRoute("file", FILE_TOOL_NAMES);
  }

  // 先看 file 模式，但「下载并整理」类必须升级到 browser（含 createDirectory/move）
  if (FILE_PATTERN.test(userInput)) {
    if (
      ACTIVE_DOWNLOAD_INTENT_PATTERN.test(userInput)
      || shouldRouteTextArtifactThroughBrowser(userInput)
    ) {
      return createRoute("browser", BROWSER_TOOL_NAMES);
    }
    return createRoute("file", FILE_TOOL_NAMES);
  }
  if (BROWSER_PATTERN.test(userInput)) {
    return createRoute("browser", BROWSER_TOOL_NAMES);
  }
  // 阶段 F：信息检索/搜集类意图需要 search/extract 拿真实来源，不能当纯闲聊。
  if (isResearchIntent(userInput)) {
    return createRoute("browser", BROWSER_TOOL_NAMES);
  }
  return createRoute("conversation", []);
}

function createRoute(
  capability: TurnCapability,
  allowedToolNames: string[]
): TurnCapabilityRoute {
  return {
    capability,
    allowedToolNames: [...allowedToolNames],
    resumedFromHistory: false
  };
}

function shouldRouteTextArtifactThroughBrowser(userInput: string): boolean {
  if (!TEXT_ARTIFACT_SAVE_PATTERN.test(userInput)) {
    return false;
  }

  return (
    isResearchIntent(userInput)
    || BROWSER_PATTERN.test(userInput)
    || WEB_TEXT_ARTIFACT_SOURCE_PATTERN.test(userInput)
  );
}

function isLocalKnowledgeFileIntent(userInput: string): boolean {
  if (!LOCAL_KNOWLEDGE_SOURCE_PATTERN.test(userInput)) {
    return false;
  }
  if (EXPLICIT_WEB_SOURCE_PATTERN.test(userInput)) {
    return false;
  }
  return LOCAL_KNOWLEDGE_ACTION_PATTERN.test(userInput);
}

function isLocalOfficeIntent(userInput: string, officePattern: RegExp): boolean {
  const hasLocalHint =
    LOCAL_KNOWLEDGE_SOURCE_PATTERN.test(userInput) ||
    /(?:本地|整理|汇总|统计).{0,12}(?:资料|文件|数据|记录)/i.test(userInput);
  if (!hasLocalHint) return false;
  if (EXPLICIT_WEB_SOURCE_PATTERN.test(userInput)) return false;
  return officePattern.test(userInput);
}

function isConversationDigestIntent(userInput: string, officePattern: RegExp): boolean {
  const hasConversation = /(?:刚才|最近|本次|这轮|聊天|对话|讨论|会话)/i.test(userInput);
  const hasDigest = /(?:整理|汇总|总结|导出|生成)/i.test(userInput);
  if (!hasConversation || !hasDigest) return false;
  if (EXPLICIT_WEB_SOURCE_PATTERN.test(userInput)) return false;
  return officePattern.test(userInput);
}

function isHealthMemoryOfficeIntent(userInput: string, officePattern: RegExp): boolean {
  const hasHealthOrMemory = /(?:健康档案|健康记录|体检|健康数据|待办|任务清单|记忆清单|偏好清单)/i.test(userInput);
  const hasDigest = /(?:导出|生成|整理|做成|汇总|总结)/i.test(userInput);
  if (!hasHealthOrMemory || !hasDigest) return false;
  if (EXPLICIT_WEB_SOURCE_PATTERN.test(userInput)) return false;
  return officePattern.test(userInput);
}

function isClipboardOfficeIntent(userInput: string, officePattern: RegExp): boolean {
  const hasClipboard = /(?:剪贴板|粘贴板)/i.test(userInput);
  const hasAction = /(?:整理|生成|做成|转换|导出|汇总|做一下|做个)/i.test(userInput);
  if (!hasClipboard || !hasAction) return false;
  return officePattern.test(userInput);
}

function isCodeOfficeIntent(userInput: string, officePattern: RegExp): boolean {
  const hasCodeHint = /(?:js|javascript|python|代码|沙箱|计算|统计|平均值|求和|清洗|转换)/i.test(userInput);
  const hasOfficeAction = /(?:生成|做成|导出|整理|转换|做一下|做个)/i.test(userInput);
  if (!hasCodeHint || !hasOfficeAction) return false;
  return officePattern.test(userInput);
}

function isDirectOfficeIntent(userInput: string, officePattern: RegExp): boolean {
  if (!officePattern.test(userInput)) return false;
  if (!/(?:生成|做成|创建|导出|整理|写|做一下|做个)/i.test(userInput)) return false;
  if (!/(?:写|请假条|清单|台账|费用|计划书|说明|纪要|提纲|模版|模板|报表)/i.test(userInput)) return false;
  if (LOCAL_KNOWLEDGE_SOURCE_PATTERN.test(userInput)) return false;
  if (EXPLICIT_WEB_SOURCE_PATTERN.test(userInput)) return false;
  if (WEB_TEXT_ARTIFACT_SOURCE_PATTERN.test(userInput) && isResearchIntent(userInput)) return false;
  if (/(?:剪贴板|粘贴板)/i.test(userInput)) return false;
  if (/(?:刚才|最近|本次|这轮|聊天|对话|讨论|会话)/i.test(userInput)) return false;
  if (/(?:健康档案|健康记录|体检|健康数据|待办|任务清单|记忆清单|偏好清单)/i.test(userInput)) return false;
  if (/(?:js|javascript|python|代码|沙箱|平均值|求和)/i.test(userInput) && /(?:计算|统计|清洗|转换)/i.test(userInput)) return false;
  if (isResearchIntent(userInput)) return false;
  return FILE_CREATE_EXCEL_PATTERN.test(userInput) || FILE_CREATE_PPTX_PATTERN.test(userInput) || FILE_CREATE_DOCX_PATTERN.test(userInput);
}

export function doesTurnCapabilityRequireBridge(capability: TurnCapability): boolean {
  return BRIDGE_REQUIRED_CAPABILITIES.has(capability);
}
