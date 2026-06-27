# VOID 下一步开发方案

> 文档作用：记录当前 Web MVP 已完成内容、已闭环验证项、下一步开发目标和暂缓任务。  
> 当前阶段：模型配置、文本对话、展开回复、模型选择和 OpenAI-compatible 流式链路已经进入可继续打磨阶段；下一步不直接跳到记忆系统、语音系统或桌面端。

## 1. 当前已完成的前置决策

- 产品定位已归档到 `01_VOID_产品定位与边界文档.md`。
- Web MVP 阶段拆分已归档到 `09_VOID_MVP阶段任务拆分.md`。
- 当前 TODO 主索引参考 `todo.md` 和 `12_VOID_当前进度索引与TODO.md`。

当前结论：

- VOID 的第一阶段仍然以 Web MVP 为主。
- 长文本输入、长文本输出和模型接入是基础能力，不是产品最终定位本身。
- 当前阶段优先稳定文本对话、模型配置、回复承载和真实模型链路。
- 暂不提前进入完整记忆系统、完整语音系统、健康档案或桌面端打包。

## 2. 当前已完成的模型配置和文本对话能力

### 2.1 Provider 基础链路

已完成：

- 建立统一 provider contract。
- OpenAI-compatible provider 已支持 `/chat/completions`。
- Anthropic provider 已支持 `/messages`。
- DeepSeek、智谱、豆包 Ark 当前通过 OpenAI-compatible 预设接入。
- Provider 会校验 API Key、Base URL、Model Name。
- Base URL 会自动避免重复拼接 `/chat/completions` 或 `/messages`。
- 开发环境使用 `/void-model-proxy` 转发，避免浏览器直连第三方 API 的 CORS 问题。
- API Key 只保存在 `sessionStorage`，普通模型配置保存在 `localStorage`。

### 2.2 模型设置面板

已完成：

- 支持服务预设、接口格式、API Key、Base URL、模型选择、自定义模型名。
- 支持回应风格、输出规模、模型强度、流式输出开关。
- 豆包 Ark 已补入当前确认可用的真实模型 ID。
- OpenAI 和 Anthropic 下拉已补入当前阶段需要展示的模型清单。
- “模型强度”不再切换模型，只保存为强度配置并映射到厂商请求参数。

### 2.3 回复展示链路

已完成：

- 文本发送后会进入 thinking 状态。
- 模型返回后会进入 speaking 状态。
- 主界面只显示克制的回复预览。
- 回复可以展开到长文本阅读面板。
- 展开面板支持会话历史查看、复制、编辑最近问题并重新生成。

## 3. 已完成：真实凭据验证和模型链路修正

本节原本是“仍需真实凭据验证的链路”，当前已完成第一轮真实验证和修正，标记为完成。

已完成内容：

- 豆包 Ark 401 问题已定位：原因是使用了错误的模型名，而不是 Ark API 接入示例里的真实 `model` ID。
- 已确认豆包 Ark 需要使用 API 接入示例中的 `model` 值，例如 `doubao-seed-character-260628` 这类真实 ID。
- 已将豆包 Ark 下拉模型替换为当前已确认可用的真实模型 ID。
- OpenAI-compatible provider 已统一清理用户误粘贴的 `Bearer ` 前缀，避免生成 `Bearer Bearer xxx`。
- OpenAI-compatible provider 已支持 SSE 流式读取。
- 流式输出开关已解开，不再因为豆包 Ark 的 `volces.com` 地址被禁用。
- 模型强度已从“切换模型”改为“保持当前模型不变，只影响请求强度参数”。

仍需后续继续验证：

- OpenAI 官方模型 ID 是否全部可直接调用。
- Anthropic 当前展示模型 ID 是否全部可直接调用。
- Anthropic 的 thinking 参数在不同模型上的兼容性。
- 豆包 Ark 流式输出在当前所选模型上的实际稳定性。
- DeepSeek、智谱等 OpenAI-compatible 厂商是否接受当前请求参数。

## 4. 下一步开发目标

下一步目标是把当前 Web MVP 的文本模型体验稳定下来，具体目标如下：

1. 真实流式回复渲染稳定化。
2. 模型配置面板信息结构继续收敛，减少用户误填。
3. 长文本输入和长文本回复承载检查。
4. 当前会话历史本地持久化。
5. Provider 错误提示继续精简和可读化。
6. 再进入记忆系统前，先确保文本对话主链路稳定。

## 5. 下一步开发拆分

### 5.1 第一优先级：真实流式回复渲染

目标：

- 用户开启流式输出后，回复应该边生成边显示。
- 主界面预览层能实时追加内容。
- 展开面板打开后能看到完整结果。
- 流式失败时能回退成清晰错误提示。

涉及文件：

- `src/features/agent/voidConversation.ts`
- `src/lib/model-providers/openAiCompatibleProvider.ts`
- `src/features/void-stage/VoidStage.tsx`
- `src/features/response-layer/VoidResponseLayer.tsx`
- `src/features/expanded-response/ExpandedResponseOverlay.tsx`

验收标准：

- OpenAI-compatible provider 开启流式后能实时显示 token。
- 豆包 Ark 不再被前端禁用流式开关。
- 非流式请求仍然保持原有完整回复体验。
- Anthropic 暂未实现流式时，不显示为可用流式 provider，避免假开关。

### 5.2 第二优先级：长文本承载检查

目标：

- 底部输入框输入长文本时不撑坏布局。
- 主界面回复预览不变成聊天列表。
- 展开面板承担长文本阅读。
- 复制、编辑最近问题、重新生成、滚动到底部在长内容下仍然可用。

涉及文件：

- `src/features/text-entry/LuminousTextEntry.tsx`
- `src/features/response-layer/VoidResponseLayer.tsx`
- `src/features/expanded-response/ExpandedResponseOverlay.tsx`

### 5.3 第三优先级：本地会话持久化

目标：

- 刷新页面后当前会话历史不立即丢失。
- 先做轻量本地持久化，不引入复杂数据库。
- 后续进入 Tauri 或正式记忆系统时再迁移到更稳定的数据层。

涉及文件：

- `src/features/void-stage/VoidStage.tsx`
- `src/features/agent/voidConversation.ts`

### 5.4 第四优先级：模型配置继续收敛

目标：

- 自定义模型名改为高级入口，避免普通用户误填。
- OpenAI / Anthropic 模型列表继续按官方可用模型校准。
- 豆包 Ark 后续新增模型时，先记录真实 `model` ID，再进入下拉。
- 保留中转站和自定义 Base URL 能力，但不让它干扰默认官方预设。

涉及文件：

- `src/features/settings/modelConfig.ts`
- `src/features/settings/ModelSettingsModal.tsx`
- `.md/14_VOID_模型厂商与模型选择谱系文档.md`

## 6. 暂缓任务

当前阶段暂缓：

- 完整长期记忆系统。
- 健康档案。
- 完整 STT / TTS。
- 主动监听唤醒。
- 电脑控制。
- 定时任务。
- 文件上传。
- Tauri 打包。

## 7. 推荐下一次开发入口

下一次开发建议从这里开始：

```text
先验证真实流式回复渲染，再检查长文本输入和展开回复承载，然后做当前会话历史本地持久化。
```

不要下一步直接写完整记忆系统、语音系统或电脑控制。
