# VOID 文本模型体验稳定化阶段目标

> 文档作用：在正式写代码前，明确本阶段开发目标、范围、优先级和验收标准，避免把当前任务扩散到记忆系统、语音系统、电脑控制或桌面打包。  
> 来源依据：`15_VOID_下一步开发方案.md` 的 `## 4. 下一步开发目标`。  
> 当前产品方向：MVP 阶段继续使用 Web 形态开发；正式产品方向是电脑端可安装 Agent；手机端 App 当前不做。

## 1. 本阶段一句话目标

把当前 Web MVP 的文本模型体验稳定下来，让用户可以稳定完成“配置模型、发送长短文本、接收真实回复、阅读完整内容、刷新后保留当前会话”的核心闭环。

## 2. 本阶段必须完成

1. 真实流式回复渲染稳定化。
2. 长文本输入和长文本回复承载检查。
3. 当前会话历史本地持久化。
4. 模型配置面板信息结构继续收敛，减少误填。
5. Provider 错误提示继续精简和可读化。

## 3. 本阶段不做

- 不做完整长期记忆系统。
- 不做健康档案。
- 不做完整 STT / TTS。
- 不做主动监听唤醒。
- 不做电脑控制。
- 不做定时任务。
- 不做文件上传。
- 不做桌面端打包。
- 不做手机端适配或手机端 App。

## 4. 开发优先级

### 4.1 真实流式回复渲染

目标：

- 用户开启流式输出后，回复内容应边生成边显示。
- 主界面回复预览可以实时追加内容，但仍保持克制，不变成完整聊天列表。
- 展开回复面板打开后，可以看到当前回复的完整内容。
- 流式失败时，界面显示清晰、可读的错误提示。
- 非流式请求保持原有完整回复体验。

涉及文件：

- `src/features/agent/voidConversation.ts`
- `src/lib/model-providers/openAiCompatibleProvider.ts`
- `src/features/void-stage/VoidStage.tsx`
- `src/features/response-layer/VoidResponseLayer.tsx`
- `src/features/expanded-response/ExpandedResponseOverlay.tsx`

验收标准：

- OpenAI-compatible provider 开启流式后能实时显示增量内容。
- 豆包 Ark 不被前端禁用流式开关。
- 非流式请求仍然一次性显示完整回复。
- Anthropic 暂未实现流式时，不伪装成可用流式 provider。

### 4.2 长文本承载检查

目标：

- 底部输入框输入长文本时不撑坏主界面布局。
- 主界面回复预览只承担摘要式展示，不承担读长文。
- 展开回复面板承担长文本阅读。
- 复制、编辑最近问题、重新生成和滚动到底部在长内容下仍然可用。

涉及文件：

- `src/features/text-entry/LuminousTextEntry.tsx`
- `src/features/response-layer/VoidResponseLayer.tsx`
- `src/features/expanded-response/ExpandedResponseOverlay.tsx`

验收标准：

- 长输入不会遮挡 Blob 主体、设置入口或回复预览。
- 长回复不会让主界面变成聊天记录页。
- 展开面板可以稳定阅读较长回复。

### 4.3 当前会话历史本地持久化

目标：

- 刷新页面后，当前会话历史不会立即丢失。
- 只做轻量本地持久化，不引入复杂数据库。
- 只保存当前会话需要的基础数据，不提前设计完整长期记忆。

涉及文件：

- `src/features/void-stage/VoidStage.tsx`
- `src/features/agent/voidConversation.ts`

验收标准：

- 页面刷新后可以恢复当前会话历史。
- 清空或覆盖逻辑清晰，不制造隐藏的长期记忆。
- 后续迁移到 Tauri 或正式记忆系统时，有明确替换边界。

### 4.4 模型配置继续收敛

目标：

- 自定义模型名改为高级入口，避免普通用户误填。
- OpenAI / Anthropic 模型列表继续按官方可用模型校准。
- 豆包 Ark 后续新增模型时，先记录真实 `model` ID，再进入下拉。
- 保留中转站和自定义 Base URL 能力，但不干扰默认官方预设。

涉及文件：

- `src/features/settings/modelConfig.ts`
- `src/features/settings/ModelSettingsModal.tsx`
- `.md/14_VOID_模型厂商与模型选择谱系文档.md`

验收标准：

- 普通用户优先通过预设完成配置。
- 高级用户仍可配置自定义 Base URL 和模型名。
- 错误提示指向具体配置问题，而不是泛泛提示失败。

## 5. 产品边界确认

- VOID 不是网页产品，Web 只是当前 MVP 阶段最适合快速开发和验证的形态。
- VOID 的正式目标是电脑端可安装 Agent。
- 电脑端版本需要保留当前 Web MVP 的视觉方向、GSAP 动效和 R3F 动效。
- 手机端 App 当前不做，不为手机端单独设计交互、布局或功能路线。
- 当前阶段不因为未来桌面端目标而提前打包 Tauri；先稳定文本模型主链路。

## 6. 开始写代码前的检查清单

1. 是否仍围绕文本模型体验稳定化，而不是扩散到记忆、语音或电脑控制。
2. 是否保留极简主界面，长内容交给展开面板承载。
3. 是否没有新增手机端适配目标。
4. 是否没有提前引入复杂数据库或长期记忆结构。
5. 是否没有破坏当前 GSAP 和 R3F 动效链路。
