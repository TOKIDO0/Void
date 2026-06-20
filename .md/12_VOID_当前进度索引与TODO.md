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
- 后续模型配置与文本对话闭环

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
- 左端点点击后打开 agent 操作栏，操作栏包含“思考模式 / 上传文件 / 设置”。点击“设置”后再进入设置入口。

当前文件：
- `src/features/text-entry/LuminousTextEntry.tsx`
- `src/features/text-entry/luminousCapsuleShader.ts`
- `src/styles/base.css`

后续注意：
- 输入框强光效不要用 CSS box-shadow、SVG 图片或组件库图标实现。
- 端点、边缘流动、发送扫光、内部流体纹理均有独立 shader 变量或局部逻辑，后续如果效果不好应按模块删改，不要混在一起补丁式修改。
- 左端 agent 操作栏当前只完成入口结构，“思考模式”和“上传文件”尚未接真实功能。

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

## 4. 下一步建议

下一步建议做“设置模态框与模型配置入口”，然后继续完成文本对话第一闭环，不要马上做完整语音对话。

原因：
- 当前 agent 视觉已经成立。
- 麦克风现在只负责视觉状态，不负责语义理解。
- 如果直接做 STT/TTS，会同时引入权限、转写、唤醒、回复、播放多个不稳定变量。
- 先做文本闭环，可以验证 VOID 人格、provider contract、状态切换和错误处理。

建议下一步任务：
1. 从左端 agent 操作栏的“设置”进入半透明玻璃质感设置模态框。
2. 设置模态框优先实现“模型”分组：Provider、API Key、Base URL、Model Name、温度、最大输出长度、流式输出开关。
3. 复用已有 model provider contract，不让 UI 直接依赖厂商 SDK。
4. 完成文本输入到 LLM 回复的第一闭环。
5. 对话期间驱动 `thinking` / `speaking` 状态。
6. “思考模式”“上传文件”先保留入口，不接真实功能。
7. 不做记忆、健康档案、完整 STT/TTS。

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
- 左端点点击打开 agent 操作栏，包含“思考模式 / 上传文件 / 设置”

下一步任务：
实现设置模态框与模型配置入口，然后继续文本对话第一闭环。

要求：
1. 不做完整 STT/TTS。
2. 不做记忆系统。
3. 不做健康档案。
4. Provider 必须模块化。
5. UI 不要直接依赖某个厂商 SDK。
6. 至少支持 OpenAI-compatible API。
7. 设置模态框从左端 agent 操作栏里的“设置”按钮打开，不要让左端点直接弹设置模态框。
8. 设置模态框使用半透明玻璃质感、圆润边角、克制布局。
9. 当前优先实现“模型”分组，其它“人格与回应 / 记忆与隐私 / 语音与监听 / 视觉”可先做信息架构预留，不要一次性接复杂功能。
10. 对话流程要驱动 agent 的 thinking / speaking 状态。
11. 不要添加多余 UI 或测试文案。
12. 不要写测试代码，除非用户明确要求。
13. 底部辉光输入框、agent 主体、强辉光、流体、能量线、lens flare 等强视觉效果必须继续使用 WebGL / GLSL / R3F，不要用 CSS box-shadow、SVG 图片或组件库图标承担主效果。
```
