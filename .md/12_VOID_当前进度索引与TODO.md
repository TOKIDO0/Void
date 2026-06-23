# 2026-06-21 视觉优化补充记录

本轮已完成：
- 回复展开 beam 裂隙已从偏宽的左右双裂缝，调整为单体窄裂隙：中段略粗，上下两端收细，整体不再像大面积撕开。
- 裂隙生命周期已改为“出现 -> 推开模态 -> 向内坍缩消失”，模态框稳定展开后不再持续保留中央裂缝。
- 横向能量 ripple 已收敛范围，避免在展开后左右延伸成“触手”。
- agent 展开态保留现有粉色高激活效果，只优化中间空洞形态：空洞边缘加入有机扰动和更柔的透明过渡，减少被竖向光柱切开的观感。
- 已执行 `cmd.exe /c npm run build`，构建通过。

下一步建议：
1. 启动本地页面做真实浏览器视觉验收，重点看回复框点击展开、History 展开、关闭回流、裂隙坍缩消失和 agent 中空形态是否符合截图反馈。
2. 如果视觉验收通过，再进入真实模型请求链路验证，按 provider 逐个记录 HTTP 状态、Base URL、Model Name 和服务端错误。
3. 不要在视觉确认前继续叠加新光效，否则容易把当前已经满意的粉色高激活状态带偏。

---
# VOID 当前进度索引与 TODO

> 本文档是 VOID 当前阶段的主进度文档。后续新窗口继续开发时，先读本文档，再按本文档指向读取对应详情文档。
> 本文档负责记录“现在做到哪里、下一步做什么、细节去哪份文档看”，不替代各专项设计文档。

## 1. 当前产品边界

当前主线仍然是 Web MVP。

当前阶段只允许推进：
- 黑色全屏主界面
- 中央 agent 流体主体
- 前端视觉状态机
- 麦克风音量驱动的前端状态变化
- 模型配置与文本对话闭环
- 极简对话回复呈现
- 多模型服务预设与开发环境模型请求代理
- 设置面板中英文 i18n 基础结构
- 回复框点击展开的电影式长回复模态
- 展开模态时 agent 粉色环状高激活形变

当前阶段不要接入：
- 完整 STT
- 完整 TTS
- 长期记忆系统
- 健康档案系统
- Tauri 桌面端

详情参考：
- `01_VOID_产品定位与边界文档.md`
- `07_VOID_技术架构与模型接入文档.md`
- `09_VOID_MVP阶段任务拆分.md`

## 2. 当前已完成进度

### 2.1 主界面

已完成：
- 纯黑全屏舞台
- 移除旧 0/1 面部主体
- 移除底部胶囊输入区
- 移除底部接地蓝光
- 页面视觉焦点只保留中央 agent

当前入口：
- `src/features/void-stage/VoidStage.tsx`
- `src/features/blob-scene/BlobScene.tsx`

详情参考：
- `08_VOID_前端交互与动效设计文档.md`
- `11_VOID_面部主体开发交接文档.md`

### 2.2 agent 流体主体

说明：后续本文档和开发沟通中，`agent` 默认指中央的 R3F + GLSL 流体主体，不是 LLM 编排层。

已完成：
- React Three Fiber Canvas
- `IcosahedronGeometry`
- `detail: 100`
- 自定义 `ShaderMaterial`
- 3D simplex noise
- 两层 FBM
- 内部流动噪声
- Fresnel 边缘光
- Bloom 后处理
- 状态切换时短暂增强涌动感

当前文件：
- `src/features/blob-scene/VoidBlob.tsx`
- `src/features/blob-scene/blobShader.ts`
- `src/features/blob-scene/useBlobStateAnimation.ts`
- `src/features/void-state/voidVisualState.ts`

#### agent 形态拓展硬约束

后续增加 agent 形态时，必须遵守：
- 不允许明显改变 agent 本体基础大小。
- 状态差异优先通过颜色、Shader 参数、内部流动、边缘光、轻微非等比形变体现。
- 如果必须改变大小，只允许非常小的呼吸级变化，不能出现冲出页面或缩成小点的效果。
- 不允许在 `useFrame` 中读取已经应用非等比形态后的 `mesh.scale.x/y/z`，再把 `shapeScale` 乘回 `mesh.scale`。
- 基础缩放必须独立保存，例如使用单独的 `baseScaleRef` 或同类基础尺寸变量。
- `shapeScale` 只能作为最终渲染时的一次性乘法使用，不能反向参与下一帧基础 scale 的计算。
- 状态切换时的流体速度增强必须使用缓入缓出的曲线，不能在 0.5 秒内突然冲到高峰再突然回落。
- `transitionEnergy` 只允许作为轻微增强参数使用，不要大幅叠加到 `uNoiseSpeed`、内部噪声频率或内部流动强度上。

已发生过的事故：
- `listening` 状态使用 `shapeScale: [1.03, 0.98, 1.02]`。
- 渲染循环读取 `mesh.scale.x` 作为下一帧基础 scale。
- 由于 `mesh.scale.x` 已经乘过 `shapeScale.x`，下一帧再次乘入，导致 scale 指数级放大。
- `thinking` 状态同理，因为 `shapeScale.x < 1`，导致主体逐帧缩小。
- 修复方式：基础 scale 改为独立 `baseScaleRef`，不再从 `mesh.scale.x` 反推。

### 2.3 前端状态机

已完成状态：
- `idle`
- `listening`
- `thinking`
- `speaking`

当前状态视觉：
- `idle`：蓝色，稳定呼吸
- `listening`：淡橙色，流体不规则性和强度稍微增加
- `thinking`：淡紫色，整体更内收，形体略纵向，内部流动更明显
- `speaking`：蓝色系，保留后续 TTS 音量驱动空间

当前仍保留快捷键模拟：
- `1` idle
- `2` listening
- `3` thinking
- `4` speaking

详情参考：
- `08_VOID_前端交互与动效设计文档.md`
- `09_VOID_MVP阶段任务拆分.md`

### 2.4 麦克风音量驱动

已完成：
- 浏览器本地 `getUserMedia`
- 本地 `AnalyserNode` 音量检测
- 只根据音量驱动视觉状态
- 不做 STT
- 不上传音频
- 不保存音频

当前流程：
```text
用户授权麦克风
  -> 检测到说话音量
  -> agent 进入 listening
  -> 静音一小段时间
  -> agent 进入 thinking
  -> 短暂 thinking 预览后回到 idle
```

当前文件：
- `src/features/voice/useMicrophoneVoiceActivity.ts`

详情参考：
- `06_VOID_主动监听与唤醒判定策略.md`
- `08_VOID_前端交互与动效设计文档.md`

### 2.5 底部 WebGL 辉光文本输入框

已完成：
- 新增独立 `features/text-entry` 输入组件，不复用旧 `voice-capsule` 结构。
- 输入框可根据鼠标靠近底部显现，hover / focus 时保持展开。
- 强辉光、胶囊本体、边缘能量流、左右端点、lens flare、内部流体光雾全部由 R3F + GLSL 实现。
- 已移除局部 `EffectComposer/Bloom`，避免 canvas 透明区域出现矩形底板。
- DOM 只保留透明 textarea 和左右透明点击热区，不使用 SVG 图片作为按钮。
- textarea 支持多行输入，胶囊高度随内容自适应增长，发送后通过同一高度动画恢复默认形态。
- 默认胶囊高度已略增，避免看起来像过低的横条。
- 左端点点击后打开 agent 操作栏，操作栏包含“思考模式 / 上传文件 / 历史 / 设置”。点击“设置”后再进入设置入口。
- agent 操作栏支持点击页面其他位置自动收起。
- agent 操作栏已调整为更贴近底部胶囊的玻璃质感样式。

当前文件：
- `src/features/text-entry/LuminousTextEntry.tsx`
- `src/features/text-entry/luminousCapsuleShader.ts`
- `src/styles/base.css`

后续注意：
- 输入框强光效不要用 CSS box-shadow、SVG 图片或组件库图标实现。
- 端点、边缘流动、发送扫光、内部流体纹理均有独立 shader 变量或局部逻辑，后续如果效果不好应按模块删改，不要混在一起补丁式修改。
- 左端 agent 操作栏当前只完成入口结构，“思考模式”和“上传文件”尚未接真实功能。

### 2.6 设置模态框与模型配置

已完成：
- 从左端 agent 操作栏点击 `Settings` 打开设置模态框。
- 设置模态框使用半透明玻璃质感。
- 当前优先实现“模型”分组。
- 支持 Provider、API Key、Base URL、Model Name、请求方式、温度、最大输出长度、流式输出开关。
- Provider 支持 `OpenAI-compatible` 和 `Anthropic`。
- 设置中已增加 OpenAI、FreeModel 默认线路、FreeModel openai-t1-sg、DeepSeek、豆包 Ark、智谱 GLM、Anthropic Claude 预设。
- 设置面板已增加中英文 i18n 基础结构，默认中文，可切换 English。
- 模型面板中的技术字段保留英文原词，但通过中文标签和说明降低理解成本。
- 普通模型配置保存到 `localStorage`。
- API Key 只保存到当前浏览器会话 `sessionStorage`，不做长期明文持久化。
- OpenAI-compatible provider 请求已接入 `temperature` 和 `max_tokens`。
- OpenAI-compatible Base URL 已做规范化：用户可以填根地址，例如 `https://vip-sg.freemodel.dev/v1`，也可以填完整 `.../chat/completions`，不会再重复拼接成 `.../chat/completions/chat/completions`。
- 开发环境已增加 Vite 同源模型请求代理 `/void-model-proxy`，用于绕过浏览器直连第三方模型服务时的 CORS 阻断。
- 当前 Web MVP 模型请求主线已收敛为 `development-proxy`，设置面板不再暴露浏览器直连入口，避免 API Key 暴露和 CORS 误导。
- Anthropic provider 已接入原生 Messages API 请求结构，`system` 单独传递，消息历史排除 system 消息。

当前文件：
- `src/features/settings/ModelSettingsModal.tsx`
- `src/features/settings/modelConfig.ts`
- `src/lib/model-providers/anthropicProvider.ts`
- `src/lib/model-providers/openAiCompatibleProvider.ts`
- `src/lib/model-providers/providerUrl.ts`
- `src/lib/model-providers/providerContract.ts`
- `src/lib/model-providers/providerRegistry.ts`
- `vite.config.ts`
- `src/features/void-stage/VoidStage.tsx`
- `src/styles/base.css`

后续注意：
- `streamEnabled` 当前只是配置项，真实流式回复还未实现。
- 后续新增 MiniMax、Ollama、自定义 JSON 请求模板时必须继续走 provider contract。
- UI 不允许直接依赖厂商 SDK 或在组件里拼厂商私有请求结构。
- 当前 `/void-model-proxy` 只解决 Vite 开发环境。生产 Web 或 Tauri 阶段需要实现正式本地/服务端代理，否则浏览器直连第三方 API 仍可能暴露 Key 或遇到 CORS。

### 2.7 文本对话链路

已完成：
- 底部输入框可以提交文本。
- `VoidStage` 提交文本后会进入 `thinking` 状态。
- `sendVoidMessage` 会注入 `VOID_SYSTEM_PROMPT`。
- 当前会话内会维护 user / assistant 对话历史。
- 模型返回后会进入短暂 `speaking` 状态。
- 页面已有极简回复呈现层，用于显示最近一条 VOID 回复。
- 回复呈现层下方的能量线由独立 R3F / GLSL 实现，不使用 CSS 画光效。
- 回复呈现层会在文本链路触发时出现，空闲一段时间后淡出；用户进入语音 `listening` 时会淡出，把视觉焦点还给中央 agent。
- 模型错误会通过同一回复呈现层给出克制、明确的错误反馈。
- 当前会话历史已有电影式展开入口：点击当前回复框或 agent 操作栏 `History`，会从回复层触发 R3F/GLSL beam 裂缝光效并展开长回复模态。
- 展开模态使用非传统聊天气泡样式，用户和 VOID 消息以角标文本块呈现。
- 展开时中央 agent 会从蓝色完整 Blob 平滑变为粉色环状高激活态，关闭后回流恢复。

当前文件：
- `src/features/void-stage/VoidStage.tsx`
- `src/features/response-layer/VoidResponseLayer.tsx`
- `src/features/response-layer/EchoLightLine.tsx`
- `src/features/response-layer/echoLightLineShader.ts`
- `src/features/agent/voidConversation.ts`
- `src/features/agent/voidSystemPrompt.ts`

未完成：
- 对话历史还没有本地持久化。
- 真实流式回复还未实现。
- STT / TTS 尚未接入，回复呈现层已预留 `text`、`voice-transcript`、`voice-reply` 来源结构。

## 3. 现有文档索引

### 产品定义

- `01_VOID_产品定位与边界文档.md`
  - 看 VOID 是什么、不是什么、第一阶段边界。
- `02_VOID_Agent人格与情绪系统文档.md`
  - 看人格、语气、情绪回应方向。
- `03_VOID_System_Prompt正式版.md`
  - 后续接 LLM 时看这里。

### 数据与安全

- `04_VOID_记忆系统与分区知识库架构.md`
  - 后续做本地记忆时看这里。
- `05_VOID_健康档案与敏感信息治理文档.md`
  - 后续做健康档案时看这里。
- `11_VOID_人格与安全边界测试用例.md`
  - 后续测试人格、安全、健康边界时看这里。

### 语音与唤醒

- `06_VOID_主动监听与唤醒判定策略.md`
  - 后续做唤醒词、判断唤醒、无效语音过滤时看这里。

### 技术与前端

- `07_VOID_技术架构与模型接入文档.md`
  - 后续做模型配置、provider contract、本地存储时看这里。
- `08_VOID_前端交互与动效设计文档.md`
  - 后续做主界面、agent 状态、动效、视觉规则时看这里。
- `09_VOID_MVP阶段任务拆分.md`
  - 看阶段顺序和每阶段边界。
- `10_VOID_给Codex或Claude的开发提示词模板.md`
  - 新窗口发任务时可参考这里。
- `11_VOID_面部主体开发交接文档.md`
  - 当前 agent 流体主体的技术交接和调参方向看这里。
- `13_VOID_回复展开动效与模型接入配置方案.md`
  - 看回复框点击展开、R3F/GLSL beam 光效、非官方 API 配置说明和实现前确认问题。

## 4. 下一步建议

下一步建议做“文本对话闭环验证与正式代理方案设计”，不要马上做完整语音对话、记忆系统或健康档案。

原因：
- 当前 agent 视觉已经成立。
- 麦克风现在只负责视觉状态，不负责语义理解。
- 如果直接做 STT/TTS，会同时引入权限、转写、唤醒、回复、播放多个不稳定变量。
- 设置模态框、基础模型配置、OpenAI-compatible、Anthropic、常用中转/厂商预设、回复呈现层已经完成。
- 现在需要优先验证真实模型请求链路，尤其是中转站、DeepSeek、智谱、豆包 Ark 等 OpenAI-compatible 服务是否能在开发代理下正常返回。
- 生产 Web 或 Tauri 阶段不能长期依赖 Vite dev proxy，需要尽快设计正式模型请求代理和 Key 安全边界。

建议下一步任务：
1. 优先整理模型设置面板，不继续扩展历史聊天动效；`.md/13_VOID_历史聊天墨水侵袭展开动效方案.md` 中的裂隙删除、墨水侵袭、粉色中空形态保留已经进入实现阶段，后续只做视觉微调和验收。
2. 模型设置面板下一步需要改成更适合普通用户理解的配置方式：
   - 删除“请求方式 / 开发代理”这一整块展示，开发代理作为当前 Web MVP 的内部默认链路，不占用设置面板空间。
   - 删除 FreeModel / 中转站预设；中转站不作为官方厂商预设展示，用户选择对应服务商后自行填写 Base URL 和 Key 仍然可以调用。
   - “温度”改成语言化档位滑杆，不直接暴露数字。建议文案：`稳定克制`、`自然平衡`、`发散创造`。
   - “最大输出”改成语言化档位滑杆，不做过窄限制。建议文案：`简短回应`、`常规任务`、`长文/代码`、`档案级输出`，最高档位需要允许 agent 做代码、整理档案、长分析等大量内容产出。
   - “流式输出”增加 hover 提示，说明它表示“模型边生成边显示回复，体感更快；当前 MVP 可先保留开关，但真实流式链路后续再接”。
   - “模型名称”建议升级为“模型选择 + 自定义模型名”的组合：选择服务商后显示该服务商常用模型下拉；同时保留自定义输入，方便中转站或新模型临时接入。
3. 模型默认值和下拉选项必须基于官方当前文档核对，不能写不存在或未确认的模型名。
   - OpenAI：以 OpenAI 官方 Models 文档为准，后续实现前再次核对最新可用模型 ID。
   - Anthropic：官方文档当前列出 Claude Fable 5、Claude Opus 4.8、Claude Sonnet 4.6、Claude Haiku 4.5 等 API ID，需要按实际可用性和成本做默认选择。
   - DeepSeek：官方文档当前列出 `deepseek-v4-flash`、`deepseek-v4-pro`；`deepseek-chat` 和 `deepseek-reasoner` 将在 2026-07-24 15:59 UTC 废弃，后续预设应迁移。
   - 智谱 / Z.AI：官方文档当前模型导航已包含 GLM-5.2、GLM-5.1、GLM-5、GLM-5-Turbo、GLM-4.7、GLM-4.6 等，后续预设应迁移到当前推荐系列。
   - 豆包 Ark：实现前需要再次核对火山方舟官方模型 ID，避免写错可调用名称。
4. 真实模型请求链路需要再做一次验证，目标不是只验证“能返回”，而是确认链路足够稳定：
   - 验证 OpenAI-compatible provider 在 DeepSeek 和用户中转站下是否都能正确拼接 endpoint，避免 `/v1/chat/completions/chat/completions` 这类重复路径。
   - 验证开发代理 `/void-model-proxy` 是否正确转发 Authorization、Content-Type、x-api-key、anthropic-version。
   - 验证错误信息是否能保留真实 HTTP 状态和服务端 message，不做隐藏 fallback。
   - 验证空回复、401/403、404 模型名错误、429 限流、5xx 服务端错误是否都有用户能看懂的提示。
   - 验证 `maxOutputTokens` 高档位不会被本地强行限制得过低；不同 provider 如果有自身上限，应以后端错误为准，不在前端过度限制。
5. 文本链路稳定后，再设计正式生产 Web / Tauri 模型请求代理和 Key 安全边界。
6. 之后再考虑本地持久化历史或真实流式回复。
7. “思考模式”“上传文件”继续保留入口，不接真实功能。
8. 不做记忆、健康档案、完整 STT/TTS。

下一步需要阅读：
- `01_VOID_产品定位与边界文档.md`
- `03_VOID_System_Prompt正式版.md`
- `07_VOID_技术架构与模型接入文档.md`
- `08_VOID_前端交互与动效设计文档.md`
- `09_VOID_MVP阶段任务拆分.md`

## 5. 新窗口交接提示词

```text
你现在继续开发 VOID Web MVP。

请先阅读：
1. .md/12_VOID_当前进度索引与TODO.md
2. .md/01_VOID_产品定位与边界文档.md
3. .md/03_VOID_System_Prompt正式版.md
4. .md/07_VOID_技术架构与模型接入文档.md
5. .md/08_VOID_前端交互与动效设计文档.md
6. .md/09_VOID_MVP阶段任务拆分.md

当前已完成：
- 黑色全屏舞台
- 中央 R3F + GLSL agent 流体主体
- idle / listening / thinking / speaking 前端状态
- listening 淡橙色，thinking 淡紫色
- 麦克风音量只驱动前端状态，不做 STT
- 新底部 WebGL 辉光文本输入框
- 输入框强光效由 R3F + GLSL 实现，DOM 只做透明交互层
- textarea 支持多行输入，胶囊高度随内容自适应增长，发送后丝滑恢复默认高度
- 左端点点击打开 agent 操作栏，包含“思考模式 / 上传文件 / 历史 / 设置”
- agent 操作栏点击外部自动收起，并已调整为贴近胶囊的玻璃质感
- 设置模态框已从 Settings 入口打开
- 模型分组已支持 Provider、API Key、Base URL、Model Name、请求方式、温度、最大输出长度、流式输出开关
- OpenAI-compatible provider 基础链路已接入，并修复 Base URL 重复拼接问题
- 开发环境已增加 `/void-model-proxy` 同源代理，用于解决第三方模型服务 CORS；设置中已移除浏览器直连入口
- 设置中已有 OpenAI、FreeModel、DeepSeek、豆包 Ark、智谱、Anthropic 预设
- Anthropic provider 已接入原生 Messages API
- 已实现极简回复呈现层，R3F / GLSL 回声光线随文本高度自适应
- 文本回复会临时显示，语音 listening 时淡出
- 模型错误会在回复呈现层给出克制反馈
- 模型设置面板默认中文，支持 English 切换
- 当前会话历史已有轻量查看入口，不做传统聊天列表

下一步任务：
验证真实模型请求链路，记录真实错误，再设计生产/Tauri 阶段的正式模型请求代理。

要求：
1. 不做完整 STT/TTS。
2. 不做记忆系统。
3. 不做健康档案。
4. Provider 必须模块化。
5. UI 不要直接依赖某个厂商 SDK。
6. OpenAI-compatible、Anthropic 已有基础支持，后续 provider 必须继续走 provider contract。
7. 设置模态框从左端 agent 操作栏里的“设置”按钮打开，不要让左端点直接弹设置模态框。
8. 设置模态框使用半透明玻璃质感、圆润边角、克制布局。
9. 当前优先验证“模型”分组真实链路，其它“人格与回应 / 记忆与隐私 / 语音与监听 / 视觉”可先做信息架构预留，不要一次性接复杂功能。
10. 对话流程要驱动 agent 的 thinking / speaking 状态。
11. 不要添加多余 UI 或测试文案。
12. 不要写测试代码，除非用户明确要求。
13. 底部辉光输入框、agent 主体、强辉光、流体、能量线、lens flare 等强视觉效果必须继续使用 WebGL / GLSL / R3F，不要用 CSS box-shadow、SVG 图片或组件库图标承担主效果。
14. 回复呈现层必须克制，不能把主界面变成传统聊天列表。
15. 不要把 Vite 开发代理当作生产方案；生产 Web 或 Tauri 阶段必须重新设计正式代理和 Key 安全边界。
```


