# VOID 当前阶段执行拆分与验收文档

> 文档作用：把 `12_VOID_下一步开发主文档.md` 里的当前阶段主线，拆成可以直接交给新窗口 AI 执行的任务清单、实施顺序、完成步骤和验收方法。  
> 使用方式：新开窗口让 AI 开始任务时，先读 `12`，再严格按本文档顺序推进。  
> 文档边界：本文档只负责执行拆分与验收，不再承担产品定位、历史进度记录或多阶段路线说明。

## 1. 本阶段总目标

把当前 Web MVP 的文本模型体验稳定下来，让用户可以稳定完成下面这个闭环：

`配置模型 -> 发送文本 -> 获得回复 -> 阅读长回复 -> 刷新后保留当前会话 -> 继续下一轮请求`

## 2. 开发顺序

严格按这个顺序推进：

1. 真实模型链路稳定化
2. 流式回复与回复展示稳定化
3. 长文本承载检查
4. 当前会话本地持久化收尾
5. 模型配置面板继续收敛

不要跳过前面的基础链路，直接做后面的 UI 或扩展功能。

## 3. 任务 1：真实模型链路稳定化

### 3.1 目标

- 正确填写 `Base URL`、`API Key`、模型名后，请求能真正到达目标模型服务。
- 开发代理不可用时，不能只在浏览器层报 `ERR_CONNECTION_REFUSED` 就结束。
- 用户能分清是代理问题、CORS、401/403、404 模型错误、429 限流还是 5xx 服务端错误。

### 3.2 必做项

- 检查 `/void-model-proxy` 在开发环境中的工作方式。
- 检查代理不可用时的回退策略是否合理。
- 检查 OpenAI-compatible 场景下的 endpoint 拼接。
- 检查 Anthropic 原生接口路径拼接。
- 检查中转站场景下的鉴权头和请求头是否正确转发。
- 检查服务端错误信息是否被前端错误映射覆盖得过度。

### 3.3 涉及文件

- `src/lib/model-providers/providerUrl.ts`
- `src/lib/model-providers/openAiCompatibleProvider.ts`
- `src/lib/model-providers/anthropicProvider.ts`
- `vite.config.ts`

### 3.4 完成步骤

1. 验证 `buildProviderEndpointUrl()` 对根地址和完整接口地址都只拼接一次终点路径。
2. 验证开发环境请求是否先走 `/void-model-proxy`。
3. 如果代理不可用，决定是否自动回退直连，或给出明确错误提示。
4. 核对 OpenAI-compatible 请求头：`Authorization`、`Content-Type`。
5. 核对 Anthropic 请求头：`x-api-key`、`anthropic-version`、`Content-Type`。
6. 保留真实 HTTP 状态码和服务端 message，避免只显示模糊 fallback。

### 3.5 验收方法

- 构造一个正确的中转站 `Base URL`，确认不再先死在本地代理层。
- 构造一个错误模型名，确认能看到明确的 404 或服务端模型错误。
- 构造一个错误 Key，确认能看到明确的 401/403。
- 构造一个代理不可用场景，确认不是只有浏览器 `ERR_CONNECTION_REFUSED`。

## 4. 任务 2：流式回复与回复展示稳定化

### 4.1 目标

- 流式回复时，主界面预览和展开面板都能实时看到增量内容。
- 非流式回复保持原有完整体验。
- 流式过程不能出现空白消息、列表闪烁或整层反复重入场动画。

### 4.2 必做项

- 确保流式 token 能更新当前 assistant 消息占位。
- 确保展开面板消息 key 稳定，不因内容变化反复重挂载。
- 确保回复层动画依赖不会因为每个 token 重放整层动画。
- 确保失败时 assistant 占位能被明确错误消息替换。

### 4.3 涉及文件

- `src/features/agent/voidConversation.ts`
- `src/features/void-stage/VoidStage.tsx`
- `src/features/response-layer/VoidResponseLayer.tsx`
- `src/features/expanded-response/ExpandedResponseOverlay.tsx`
- `src/features/expanded-response/ExpandedDialogueLine.tsx`

### 4.4 完成步骤

1. 发送消息时先插入空的 assistant 占位。
2. 流式 token 到达时更新该占位内容。
3. 非流式完成后一次性写入最终 assistant 内容。
4. 失败时把占位改成错误消息，而不是保留空内容。
5. 检查展开面板复制、编辑、滚动到底部在流式更新时仍可用。

### 4.5 验收方法

- 开启流式，确认主界面和展开面板都实时更新。
- 关闭流式，确认仍然一次性显示完整回复。
- 故意制造错误，确认不会留下空白 assistant 消息。

## 5. 任务 3：长文本承载检查

### 5.1 目标

- 长输入不撑坏底部输入框布局。
- 主界面继续只是预览层，不变成聊天页。
- 展开面板能承担长文本阅读。

### 5.2 必做项

- 检查多行输入高度增长和恢复。
- 检查主界面预览的行数裁剪和点击展开逻辑。
- 检查展开面板长内容滚动、复制、编辑、回到底部。

### 5.3 涉及文件

- `src/features/text-entry/LuminousTextEntry.tsx`
- `src/features/response-layer/VoidResponseLayer.tsx`
- `src/features/expanded-response/ExpandedResponseOverlay.tsx`
- `src/styles/base.css`

### 5.4 验收方法

- 粘贴长输入文本，确认输入框不会遮挡主体或入口按钮。
- 生成长回复，确认主界面仍然只显示克制预览。
- 在展开面板中阅读长回复，确认布局、滚动和按钮不失效。

## 6. 任务 4：当前会话本地持久化收尾

### 6.1 目标

- 页面刷新后当前会话可恢复。
- 恢复出来的历史不会把下一次模型请求上下文撑爆。
- 本地持久化和真正发送给模型的上下文长度必须分开控制。

### 6.2 必做项

- 本地只保存当前会话需要的基础消息。
- 对本地会话条数和单条长度做裁剪。
- 对真正请求模型的历史条数和总字符数做独立裁剪。

### 6.3 涉及文件

- `src/features/agent/voidConversation.ts`
- `src/features/void-stage/VoidStage.tsx`

### 6.4 验收方法

- 刷新页面，确认历史仍在。
- 保留一个较长会话后再继续提问，确认请求不因上下文爆炸而失效。
- 故意插入错误消息或空消息，确认不会被原样继续送回模型。

## 7. 任务 5：模型配置面板继续收敛

### 7.1 目标

- 用户改 `Base URL` 时，不丢失已经选中的厂商模型系列。
- 普通用户优先用预设和模型下拉完成配置。
- 自定义模型名保留为高级入口，不强迫普通用户手输。

### 7.2 必做项

- 将“服务预设”与 `Base URL` 解耦，不再靠 `baseUrl === preset.baseUrl` 反推。
- 将所选预设持久化为独立字段。
- 保持模型下拉跟随当前预设，而不是跟随当前 `Base URL` 是否完全相等。
- 自定义模型名只作为补充入口。

### 7.3 涉及文件

- `src/features/settings/modelConfig.ts`
- `src/features/settings/ModelSettingsModal.tsx`
- `src/features/settings/settingsI18n.ts`

### 7.4 验收方法

- 选择 `OpenAI` 后，将 `Base URL` 改成中转站地址，确认仍能选择 GPT 系列模型。
- 选择 `Anthropic` 后，将 `Base URL` 改成中转站地址，确认仍能选择 Claude 系列模型。
- 切换不同预设后，确认模型下拉、强度和高级入口状态保持可预期。

## 8. 本阶段明确不做

- 记忆系统
- 健康档案
- 完整 STT / TTS
- 主动监听唤醒
- 文件上传真实功能
- 电脑控制
- 桌面端打包
- 手机端适配

## 9. 新窗口直接执行提示

```text
你现在继续开发 VOID Web MVP。

请先阅读：
1. .md/12_VOID_下一步开发主文档.md
2. .md/16_VOID_当前阶段执行拆分与验收文档.md
3. .md/01_VOID_产品定位与边界文档.md
4. .md/07_VOID_技术架构与模型接入文档.md
5. .md/08_VOID_前端交互与动效设计文档.md
6. .md/09_VOID_MVP阶段任务拆分.md
7. .md/14_VOID_模型厂商与模型选择谱系文档.md

当前阶段只做：
- 真实模型链路稳定化
- 流式回复与回复展示稳定化
- 长文本承载检查
- 当前会话本地持久化收尾
- 模型配置面板继续收敛

不要做：
- 记忆系统
- 健康档案
- 完整 STT / TTS
- 文件上传真实功能
- 电脑控制
- 桌面打包

要求：
1. Provider 必须继续走统一 contract。
2. UI 不要直接依赖厂商 SDK。
3. 主界面回复层继续保持克制预览，不做聊天列表。
4. 长文本阅读交给展开面板承担。
5. 修改 Base URL 后，不能丢失当前厂商模型系列下拉。
6. 先修真实链路，再修展示层，再做持久化收尾。
7. 不写测试代码，除非用户明确要求。
```
