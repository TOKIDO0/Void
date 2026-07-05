# 16 VOID WebMVP 下一步执行拆分与验收文档

> 文档用途：作为当前 `Web MVP` 后续开发的唯一执行基线。  
> 使用方式：新开窗口继续开发前，先完整阅读本文件，再继续代码改动。  
> 文档边界：本文件既保留尚未开始的任务，也明确记录当前已经完成、尚未完成、阻塞点、下一步顺序，不允许只保留“理想计划”而忽略真实进度。

## 0. 最新状态更新（2026-07-04）

这一段用于承接刚刚结束的窗口，优先级高于下面旧记录。新窗口继续开发时，先看这里。

### 0.1 本窗口已经完成的内容

1. 重新维护了根因文档：
   - `.md/17_VOID_TTS与STT根因定位及执行方案.md`
2. 已把 Doubao TTS 默认 `resourceId` 收敛回：
   - `seed-tts-2.0`
3. 已修正文案与本地校验逻辑：
   - 普通豆包官方音色优先用 `seed-tts-2.0`
   - 复刻音色才考虑 `seed-icl-2.0`
   - 不再把 `volc.service_type.1029` 当默认正确值
4. 已增强 Doubao TTS 响应解析：
   - 支持成功 JSON 中的 Base64 音频字段
   - 支持更宽容的 JSON 解析
   - 支持从响应文本中兜底提取 `SUQz...` 这类 MP3 Base64 头
5. 已接入应用图标：
   - `src/assets/VOID.png`
   - `index.html`
6. 已新增 FishAudio TTS 的最小可用接入：
   - `src/features/voice/tts/fishAudioTtsProvider.ts`
   - `src/features/voice/voiceRuntimeConfig.ts`
   - `src/features/settings/ModelSettingsModal.tsx`
   - `src/features/settings/settingsI18n.ts`
   - `src/features/void-stage/VoidStage.tsx`
7. 当前 TTS 播报尝试顺序已变为：
   - `Doubao`
   - `FishAudio`
   - `MiniMax`
8. 已多次执行：
   - `npm.cmd run build`
   - 结果：通过

### 0.2 当前已经确认的根因结论

当前最重要的结论有两个，不能再混淆：

1. Doubao 那条“不是合法 JSON”的旧报错，不能再直接当成上游没返回音频。
2. FishAudio 当前失败的根因，已经从“本地代理没挂上”收敛成“上游目标地址错误”。

更具体地说：

1. 本地 `Vite` 开发服务当前确实已经存在 `/void-voice-proxy` 这条路由。
2. 当前 `5173` 上跑的就是本项目的 `vite` 进程。
3. 当通过 `/void-voice-proxy` 转发到当前配置的 FishAudio / Kitta Audio 目标地址时，返回的是上游站点的 Next.js `404` HTML 页面。
4. 这说明：
   - 请求已经离开本地代理
   - 但当前写入代码的 FishAudio 目标 API 地址不是实际可调用的真实 API 入口

### 0.3 当前 FishAudio 已确认事实

根据本窗口核对到的官方文档页面文本，已经确认：

1. 鉴权方式是：
   - `Authorization: Bearer YOUR_API_KEY`
2. 文档中出现过这些路径概念：
   - `POST /v1/tts/speech`
   - `GET /v1/tts/live`
   - `POST /v1/asr/tasks`
   - `GET /v1/asr/live`
3. 文档页面文本里出现过：
   - `https://kittaaudio.com/api/v1/tts/speech`
   - `wss://kittaaudio.com/v1/asr/live`
4. 但是，真实联通测试表明：
   - 当前写入代码的 `https://kittaaudio.com/api/v1/tts/speech` 会返回上游网页 404

结论：

1. 不能继续假设当前 FishAudio / Kitta Audio 的真实 API Base URL 就是我们已经写进去的那个地址。
2. 下一窗口必须优先继续查准：
   - FishAudio 当前真实可调用的 API 基础域名
   - 当前真实的 TTS 路径
   - 当前真实的 STT 路径

### 0.4 当前真实阻塞点

当前阻塞点不是前端播放器，也不是 Vite 本地代理，而是下面两项：

1. `FishAudio / Kitta Audio` 的真实 API 地址尚未核准
2. `Doubao STT` 与 `FishAudio STT` 都还是实时 WebSocket 协议接入问题，不能凭猜测硬接

### 0.5 下一窗口的明确优先顺序

新窗口继续时，严格按这个顺序推进：

1. 先继续确认 FishAudio 当前真实 API Base URL
2. 核准 FishAudio TTS 的真实同步 HTTP 端点，确认成功返回确实是音频二进制
3. 只在地址核准后，再修 FishAudio provider 的 endpoint
4. FishAudio TTS 真正打通后，再决定是否把它提到 Doubao 前面作为首选播报链路
5. 之后再回到 STT：
   - 先决定是继续 Doubao STT
   - 还是改接 FishAudio 实时 ASR
6. 最后再进入“人格与安全边界验证”

### 0.6 下一窗口禁止再做的事

1. 不要继续把 FishAudio 当前失败误判成前端播放问题
2. 不要继续只改 `voiceTtsResponse.ts` 之类的解析层来赌运气
3. 不要再把 `volc.service_type.1029` 当成 Doubao 默认正确资源
4. 不要在未确认真实 API Base URL 前继续扩写 FishAudio 业务逻辑
5. 不要跳过 `.md/17_VOID_TTS与STT根因定位及执行方案.md`

## 1. 当前目标不变

当前阶段只推进两条主线，不扩散：

1. 语音第一闭环
2. 人格与安全边界验证

其中最高优先级仍然是：

1. `Doubao / 火山方舟` 作为主语音供应商
2. `MiniMax` 作为补充音色供应商
3. `Doubao 流式语音识别` 负责语音输入
4. `Doubao 语音合成 2.0` 负责主链路播报
5. `MiniMax TTS` 负责补充音色能力

## 2. 已确认的执行原则

### 2.1 语音链路原则

- 不直接把 `Doubao 实时语音交互 Realtime API` 作为当前主链路
- 当前必须继续复用现有文本消息主链路、人格 prompt、上下文历史、回复层状态管理
- 语音输入的最终落点必须仍然是现有文本发送逻辑，而不是再造一套独立对话系统
- 语音输出必须挂接当前模型回复结果，而不是前端随意拼接播报逻辑

### 2.2 模块化原则

- 语音输入、语音输出、供应商配置、运行时配置、会话编排必须拆分
- 不允许把 STT、TTS、UI 状态、消息发送逻辑硬塞进一个组件
- 供应商切换必须通过 provider contract 统一，不允许把 Doubao / MiniMax 逻辑直接写死在页面组件里

## 3. 当前已完成内容

以下内容已经完成，不需要重复推倒重来，但后续联调时允许继续修正：

### 3.1 语音模块基础拆分已完成

已新增或调整以下模块：

- `src/features/voice/voiceState.ts`
- `src/features/voice/voicePreferences.ts`
- `src/features/voice/useVoiceInputMonitor.ts`
- `src/features/voice/voiceProviderConfig.ts`
- `src/features/voice/voiceProxyUrl.ts`
- `src/features/voice/voiceRuntimeConfig.ts`
- `src/features/voice/voiceSessionController.ts`
- `src/features/voice/stt/voiceSttContract.ts`
- `src/features/voice/stt/doubaoStreamingSttProvider.ts`
- `src/features/voice/tts/voiceTtsContract.ts`
- `src/features/voice/tts/voicePlaybackController.ts`
- `src/features/voice/tts/doubaoTtsProvider.ts`
- `src/features/voice/tts/minimaxTtsProvider.ts`

### 3.2 旧的自动监听实现已移除

已删除：

- `src/features/voice/useMicrophoneVoiceActivity.ts`

这一步是正确的，因为旧实现无法承接当前真实的供应商式 STT / TTS 闭环，继续保留只会让后续逻辑交缠。

### 3.3 主编排层和设置层已接入第一轮语音改造

已修改：

- `src/features/void-stage/VoidStage.tsx`
- `src/features/settings/ModelSettingsModal.tsx`
- `src/features/settings/settingsI18n.ts`
- `src/features/text-entry/LuminousTextEntry.tsx`
- `vite.config.ts`

目前已经做到：

- 设置面板可录入 `Doubao / MiniMax` 的语音配置
- `VoidStage` 已开始读取语音运行时配置
- 回复完成后已具备触发 TTS 的主流程骨架
- 已加入开发期语音代理入口 `/void-voice-proxy`

### 3.4 当前供应商决策已经锁定

已确认：

- 主供应商：`Doubao / 火山方舟`
- 次供应商：`MiniMax`
- STT：`Doubao 流式语音识别`
- TTS：`Doubao 语音合成 2.0`
- 补充音色：`MiniMax TTS`

### 3.5 MiniMax 默认音色已确认

- 女性默认音色：`Chinese (Mandarin)_Mature_Woman`
- 男性默认音色：`Chinese (Mandarin)_Gentleman`

补充可选音色：

- `Chinese (Mandarin)_Warm_HeartedGirl`
- `Chinese_radio_host_male_nv1`
- `Chinese_gravelly_storyteller_nv1`
- `Chinese (Mandarin)_Sweet_Lady`

## 4. 已确认但不能走偏的技术结论

### 4.1 当前不能把 Realtime API 当主方案

原因不是它不能用，而是它不适合本轮目标。

如果直接改用 `Doubao 实时语音交互`，会产生以下问题：

- 绕过现有文本主链路
- 绕过当前消息历史体系
- 绕过当前人格与系统提示词组织方式
- 后期维护会出现双链路冲突

因此本轮正确路线是：

1. `Doubao 流式语音识别`
2. 把识别结果灌入现有文本消息发送链路
3. 拿到模型文本回复
4. 用 `Doubao TTS` 主播报
5. `MiniMax TTS` 作为补充音色

### 4.2 开源语音模型不是这轮主线

`ModelScope / 魔塔社区` 的开源语音模型当然可以接，但这轮不适合直接切过去做主实现。

原因：

- 当前项目是 `Web MVP`
- 用户需要尽快打通真实可用的第一闭环
- 开源模型通常会引入本地部署、推理资源、服务编排、延迟、格式兼容、鉴权与运维问题

所以本轮仍然优先：

1. 先把云端 API 闭环打通
2. 后续如果要补“离线/本地/自部署语音能力”，再作为独立模块扩展

## 5. 当前真实未完成内容

以下问题都是真实存在的，不能跳过：

### 5.1 STT 还没有真实打通

当前 `src/features/voice/stt/doubaoStreamingSttProvider.ts` 仍然只是骨架。

现状：

- 只做了 provider 结构占位
- 真实 `WebSocket` 语音识别桥接还没实现
- 当前会主动抛出“需要服务端 WebSocket 代理后再进行真实联调”的错误

原因：

- 浏览器原生 `WebSocket` 不适合直接完成 Doubao 所需的自定义鉴权头与协议桥接
- 还需要处理中间层的二进制分包、事件转发、识别结果回传

结论：

- STT 目前还不能真正识别用户说话
- 用户现在“说话无法识别”是预期现象，不是单一小 bug

### 5.2 TTS 还没有完成真实联调收口

当前已经有：

- `doubaoTtsProvider.ts`
- `minimaxTtsProvider.ts`

但以下内容还没有完全确认：

- Doubao TTS 的真实返回结构是否就是直接音频流
- MiniMax TTS 的真实返回结构是否就是直接音频流
- 是否需要从 JSON 中提取 `base64` 音频字段
- 当前请求头、路径参数、鉴权参数是否与实际接口要求完全一致

结论：

- 现在即使已经填写 API Key，也依然可能不会播报
- 在没有把真实返回格式和鉴权方式核准前，不能认定前端播放层有问题

### 5.3 当前出现了 401，需要分链路定位

用户已经反馈：

- 发送文本后会看到前端报错
- 控制台出现：
  - `POST http://localhost:5173/void-voice-proxy 401 (Unauthorized)`
- 同时文本模型请求日志里也出现了 `401`

这说明至少要拆成两条链路排查：

1. 文本模型链路的 401
2. 语音代理链路的 401

不能偷懒地把它们混成一个问题。

当前高概率需要验证的点：

- `Doubao TTS` 的请求头是否正确
- `MiniMax TTS` 的鉴权头与接口路径是否正确
- `/void-voice-proxy` 是否只是在透明转发上游返回的 401
- 当前前端错误展示是否把语音错误误显示成了“模型请求失败”

### 5.4 人格与安全边界任务还没开始真正执行

虽然已有：

- `02_VOID_Agent人格与情绪系统文档.md`
- `03_VOID_System_Prompt正式版.md`
- `11_VOID_人格与安全边界测试用例.md`

但当前还没有真正完成：

- 系统化测试
- 风险样本验证
- 失败案例回修

因此这个任务必须保留，不能从主线文档里删除。

## 6. 当前已确认的接口信息

以下是目前从用户提供资料中已经确认过的关键接口信息：

### 6.1 Doubao TTS

- HTTP Endpoint：`https://openspeech.bytedance.com/api/v3/tts/unidirectional`
- WebSocket Endpoint：`wss://openspeech.bytedance.com/api/v3/tts/unidirectional/stream`
- `X-Api-Resource-Id`：`seed-tts-2.0`
- 推荐模型：`seed-tts-2.0-standard`

### 6.2 Doubao STT

- 推荐 Endpoint：`wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`
- Resource Id：`volc.seedasr.sauc.duration`

### 6.3 Doubao Realtime

本轮不作为主链路，但资料已确认：

- Endpoint：`wss://openspeech.bytedance.com/api/v3/realtime/dialogue`
- Resource Id：`volc.speech.dialog`

## 7. 下一步必须按这个顺序推进

### 7.1 第一优先级：定位并修正当前 401

必须先拆分清楚：

1. 文本模型 401 是哪条链路返回的
2. 语音代理 401 是 Doubao 还是 MiniMax 返回的
3. 当前 provider 的报错映射是否误导了 UI

这一步做不清楚，后面继续堆 STT 代码只会返工。

### 7.2 第二优先级：核准 Doubao / MiniMax TTS 的真实请求与响应格式

必须确认：

- 正确请求头
- 正确 body 结构
- 正确音频返回解析方式
- 正确错误体解析方式

目标：

- 文本回复后能真实播报
- `speaking` 状态能与真实播放开始/结束对齐

### 7.3 第三优先级：实现 Doubao STT 的真实桥接

必须包含：

- 浏览器麦克风音频采集
- 音频分片
- 本地或服务端中间层 `WebSocket` 桥接
- 自定义鉴权头转发
- Doubao 识别事件解析
- interim / final transcript 处理
- final transcript 进入现有文本消息发送逻辑

注意：

- 不能伪装成“前端直连已可用”
- 不能把二进制桥接强塞进页面组件

### 7.4 第四优先级：回到人格与安全边界验证

当语音第一闭环打通后，再继续：

1. 用文本测试人格边界
2. 用语音链路测试人格边界
3. 修正 system prompt 与响应策略

## 8. 验收标准

### 8.1 语音第一闭环验收标准

以下全部满足才算完成：

1. 用户点击语音输入后，能真实采集麦克风音频
2. Doubao STT 能返回可用识别文本
3. 识别文本会进入现有文本消息发送主链路
4. 模型回复完成后，Doubao TTS 能默认自动播报
5. MiniMax 能作为补充音色正常合成
6. `speaking / listening / processing` 状态与真实链路一致
7. 失败时能给出明确错误，不出现含糊报错

### 8.2 人格与安全边界验收标准

以下全部满足才算完成：

1. 已覆盖基础人格一致性验证
2. 已覆盖情绪安抚类对话验证
3. 已覆盖高风险内容的拒答与引导验证
4. 已记录失败样例并完成至少一轮修正

## 9. 当前不进入主线的内容

以下任务仍然保留，但现在不作为当前第一顺位：

- 记忆系统
- 健康档案
- 桌面端能力
- 更多模型厂商扩展
- 开源语音模型接入
- 更复杂的多音色编排

这些内容不能删除，但也不能抢占当前语音第一闭环的开发注意力。

## 10. 新窗口继续任务时的提示词

直接复制下面这段给新窗口：

```text
你现在继续开发 VOID Web MVP。

先做两件事，不要跳过：
1. 先阅读 `.md/16_VOID_WebMVP下一步执行拆分与验收文档.md`
2. 再继续当前语音第一闭环的剩余开发

当前已确认的方案与约束：
- 主供应商：Doubao / 火山方舟
- 次供应商：MiniMax
- STT：Doubao 流式语音识别
- TTS：Doubao 语音合成 2.0 为主链路，MiniMax 为补充音色
- 不直接用 Doubao 实时语音交互作为当前主链路
- 模型回复默认自动播报
- 语音输入必须并入当前统一文本消息主链路
- 保持模块化开发，不写交缠代码
- 仍然要保留“人格与安全边界验证”任务，不要删除

当前代码已完成的基础结构：
- 删除了旧的自动监听 hook
- 新增 voiceState / voicePreferences / useVoiceInputMonitor
- 新增 voiceRuntimeConfig / voiceProxyUrl / voiceProviderConfig
- 新增 TTS provider：doubaoTtsProvider / minimaxTtsProvider
- 新增 STT 合同和骨架：voiceSttContract / doubaoStreamingSttProvider / voiceSessionController
- 修改了 VoidStage / LuminousTextEntry / ModelSettingsModal / vite.config.ts

当前真实未完成问题：
1. STT 还没真实打通，因为它需要 WebSocket 自定义头 + 二进制协议桥接
2. TTS 现在有 401，需要先定位是 Doubao、MiniMax、还是 UI 错误映射问题
3. 需要核对 Doubao / MiniMax TTS 的真实响应格式，避免把 JSON 当音频 blob
4. 语音第一闭环完成后，还要继续做人格与安全边界验证

用户已经在设置面板填写了：
- Doubao 语音 API Key
- MiniMax 语音 API Key
- 可能还有 MiniMax Group ID

MiniMax 默认音色要求：
- 女性默认：Chinese (Mandarin)_Mature_Woman
- 男性默认：Chinese (Mandarin)_Gentleman

继续开发时优先顺序：
1. 先定位 401 来源
2. 修正 TTS 真实请求与返回处理
3. 实现 Doubao STT 的真实桥接
4. 让最终识别文本进入 handleTextMessage
5. 完成后再进入人格与安全边界验证
```

## 11. 配套文档

继续推进时优先联动阅读：

1. `02_VOID_Agent人格与情绪系统文档.md`
2. `03_VOID_System_Prompt正式版.md`
3. `06_VOID_主动监听与唤醒判定策略.md`
4. `07_VOID_技术架构与模型接入文档.md`
5. `09_VOID_MVP阶段任务拆分.md`
6. `11_VOID_人格与安全边界测试用例.md`
7. `14_VOID_模型厂商与模型选择谱系文档.md`
8. `豆包语音_文档指南_1782464858.pdf`

---

## 12. 2026-07-05 Claude 交接补充

以下内容是给下一个接手模型的真实交接记录，优先级高于本节之前对 FishAudio 的历史推断。
目标是避免继续重复试错。

### 12.1 当前已经确认的真实结论

1. 本地开发代理 `/void-voice-proxy` 已存在且正常工作。
2. 当前 `5173` 跑的就是本项目 Vite。
3. FishAudio 当前不是播放器问题，不是 `voiceTtsResponse.ts` 解析层问题，也不是前端音频播放问题。
4. FishAudio 当前也不是 `Bearer Bearer xxx` 重复前缀问题。
5. 当前前端发送到 FishAudio 的开发态日志已经稳定为：
   - `endpointUrl: "https://api.fish.audio/v1/tts"`
   - `requestMode: "development-proxy"`
   - `model: "s2-pro"`
   - `voiceIdLength: 36`
   - `apiKeyLength: 64`
   - `apiKeyHasBearerPrefix: false`
6. 在上述条件下，FishAudio 真实返回结果稳定为：
   - `POST http://localhost:5173/void-voice-proxy 401 (Unauthorized)`
7. 这说明当前最稳定、最可复现的真实阻塞点，是 FishAudio 上游 `api.fish.audio` 对当前凭证直接返回 `401`。

### 12.2 已经证伪、不要再走的错误方向

以下方向已经反复验证过，继续投入只会浪费 token：

1. 不要再把问题误判成前端播放器、音频 URL、Blob、Vite HMR 或 `voiceTtsResponse.ts`。
2. 不要再把 `https://kittaaudio.com/api/v1/tts/speech` 当成当前真实可调用 API。
   - 实际联调结果：该地址会回站点 `404 HTML / Next.js 页面`
   - 这条路已经证伪
3. 不要再因为中文文档页面里出现 `kittaaudio.com/api/v1/tts/speech` 就直接写回代码。
   - 实际网络联调优先于页面文案
4. 不要再扩写 FishAudio 业务逻辑、音色策略、排序策略。
   - 在 `401` 没解决前，这些都没有意义
5. 不要再反复改 `reference_id / voiceId`、`model header / model body` 试运气，除非拿到与真实联调一致的更高置信官方依据。

### 12.3 当前代码状态

当前代码已经被收敛到下面这条 FishAudio 调用链：

1. `src/features/voice/voiceProviderConfig.ts`
   - `FISHAUDIO_TTS_ENDPOINT = "https://api.fish.audio/v1/tts"`
   - `FISHAUDIO_TTS_MODEL = "s2-pro"`
2. `src/features/voice/tts/fishAudioTtsProvider.ts`
   - `Authorization: Bearer <apiKey>`
   - 自动去掉用户输入里的 `Bearer ` 前缀
   - 开发态会打印 `[VOID FishAudio request]`
3. `src/features/voice/voiceRuntimeConfig.ts`
   - 会把历史残留旧值规范回当前默认值
4. `vite.config.ts`
   - `/void-voice-proxy` 已存在
   - 代理会透明转发到 `X-VOID-Target-URL`
5. `src/features/voice/tts/voiceTtsResponse.ts`
   - 已补充对嵌套错误 JSON 的 `error.message` 读取
6. `src/features/void-stage/VoidStage.tsx`
   - FishAudio `401 / 402 / 403` 已有更明确的用户态错误提示

### 12.4 当前最可能的真实根因

在现有证据下，优先级最高的真实根因是：

1. 当前用户填写的 FishAudio API Key 不是 Fish Audio 官方 API Key
2. 或者该 Key 已失效 / 被撤销
3. 或者该 Key 属于别的站点、别的环境、别的产品体系
4. 或者该 Key 没有当前 TTS 能力权限

注意：这里说的是“当前最可能根因”，不是绝对定论。但在没有新的强证据前，不要再把主要精力放回前端实现。

### 12.5 Claude 接手后应该优先做什么

严格按顺序：

1. 先阅读本文件第 12 节，再阅读 `.md/17_VOID_TTS与STT根因定位及执行方案.md`
2. 明确接受以下事实：
   - `kittaaudio.com/api/v1/tts/speech` 已被真实联调证伪
   - 当前唯一值得继续验证的 FishAudio 地址是 `https://api.fish.audio/v1/tts`
3. 不要先改代码，先从“鉴权维度”定位 FishAudio `401`
4. 优先目标不是继续试错字段，而是确认：
   - FishAudio 官方 API Key 的获取方式
   - 当前用户填入的 Key 是否真的属于官方 API Key
   - 是否存在账号权限、产品权限、区域权限、模型权限限制
5. 只有在拿到新的高置信官方依据后，才允许继续改 FishAudio provider

### 12.6 Claude 接手时禁止再做的事

1. 不要再把 `kittaaudio.com/api/v1/tts/speech` 写回代码
2. 不要再把问题归咎于 `voiceTtsResponse.ts`
3. 不要再为了“万一能通”继续堆 FishAudio 兜底逻辑
4. 不要跳过 `401` 直接去做 STT
5. 不要在没有新证据前继续来回切换 `voiceId/reference_id`
6. 不要因为中文文档页面存在某个示例地址，就无视真实联调结果

### 12.7 当前用户侧现象

用户当前看到的是：

1. 界面顶部提示：
   - `FishAudio TTS 鉴权失败（401）。请确认填写的是官方 API Key，且该 Key 仍然有效。`
2. 控制台稳定日志：
   - `[VOID FishAudio request] { endpointUrl: "https://api.fish.audio/v1/tts", model: "s2-pro", apiKeyHasBearerPrefix: false, apiKeyLength: 64, voiceIdLength: 36 }`
   - `POST http://localhost:5173/void-voice-proxy 401 (Unauthorized)`

### 12.8 接手最低目标

Claude 接手后的最低目标不是“马上打通 FishAudio”，而是：

1. 先把 FishAudio 当前 `401` 的根因进一步收敛成可执行结论
2. 判断这是：
   - 用户凭证错误
   - 账号权限错误
   - 区域/产品权限错误
   - 或官方文档/接口版本信息冲突
3. 在没有确定 FishAudio 可打通前，不要影响当前 Doubao / MiniMax 主线

---

## 13. 2026-07-05 语音播报延迟根因与下一步任务整合（最新交接）

> 本节优先级高于第 12 节之前对 FishAudio 的所有历史推断，是当前最新交接基线。
> 承接内容：第 0 步（让 FishAudio 真实出声）已完成；新暴露出"文字回复后 20 多秒才开口"的延迟问题。

### 13.1 第 0 步已完成（FishAudio 真实出声）

已用真实网络联调确认打通，无需再改 FishAudio 代码：

1. Vite 服务器不存在代码级崩溃：重启后 434ms 正常启动，`/void-voice-proxy`、`/void-model-proxy` 均恢复。之前的 `ERR_CONNECTION_REFUSED` 只是上个窗口进程已停，非 `vite.config.ts` 缺陷。
2. 直接对 `/void-voice-proxy` 裸测（`model=s2.1-pro`、无 Voice ID、官方 Key `9d5edea729af4e20b69139bf3f260aeb`）：
   - `HTTP 200`，`content-type=audio/mpeg`，56005 字节，文件头 `ff fb 90 c4`（真实 MP3）。
3. 用户在设置面板清空 Voice ID、改 `model=s2.1-pro` 后，应用内已能真实播放。

**结论：代理 + FishAudio 上游整条链路 100% 打通，FishAudio 侧不再有待办。**

### 13.2 新根因：文字回复出现后约 20 秒 AI 才开口

**现象**：文字回复已经完整显示 20 多秒后，语音才开始播报。

**根因（已定位到代码，非玄学）**：

1. **串行降级 + Doubao 卡顿（主因）**
   - `VoidStage.tsx` 的 `synthesizeSpeech`（约 159-216 行）按 `Doubao → FishAudio → MiniMax` 顺序**串行 `await`**。
   - 只要设置里填了 Doubao API Key + Speaker ID，每次都会**先** `await doubaoProvider.synthesize()`。
   - `doubaoTtsProvider.ts` 走 HTTP POST 到 `https://openspeech.bytedance.com/api/v3/tts/unidirectional`，且**没有任何超时控制**（无 `AbortController`）。该端点当前未真正打通，响应慢/连接不正常结束，会把这一步挂起十几到二十秒，失败后才降级到已打通的 FishAudio。
   - 这是 20 秒延迟的最大来源。

2. **等全文生成完才开始合成（次因）**
   - `completeTextResponse`（约 268-304 行）在文字回复**完全结束后**才用整段 `responseText` 调用 `synthesizeSpeech`。
   - 回复越长，"文字出现 → 开口"的固有间隔越大（还要叠加 FishAudio 合成整段的耗时）。

### 13.3 下一步任务（按优先级整合，替代第 5/7 节的旧顺序作为当前执行清单）

**任务 A：消除 20 秒延迟（最高优先，立即见效）**

两个动作，建议都做：

1. **给每个 TTS provider 加请求超时**（`AbortController`，建议 Doubao/MiniMax 各 6-8 秒无有效音频即中断并降级）。
   - 改动点：`doubaoTtsProvider.ts`、`minimaxTtsProvider.ts`、`fishAudioTtsProvider.ts` 的 `fetchVoiceWithProxy` 调用传入 `signal`；`voiceProxyUrl.ts` 透传 `signal`。
   - 目的：即使某家挂起，也能快速降级，不再白等。
2. **临时调整 provider 尝试顺序，把已打通的 FishAudio 提到第一位**（Doubao/MiniMax 真实复验通过前）。
   - 改动点：`VoidStage.tsx` 的 `synthesizeSpeech` 调整三段 `if` 顺序为 `FishAudio → Doubao → MiniMax`。
   - 依据：第 0 步已证 FishAudio 稳定 200；第 12/13 节明确 Doubao TTS 尚未真实复验。此调整符合"FishAudio 打通后再决定是否提前"（见 0.5 节第 4 条）。
   - 注意：这是**顺序调整**，不是删除 Doubao 主链路。Doubao 真实打通后可再评估复位。

**任务 B：降低固有开口间隔（次高优先，改动较大，可在任务 A 后做）**

- **句子级流式合成**：在 `requestVoidResponse` 流式回调里，按句号/换行切出第一句就先合成播放，后续句子边生成边排队播放，而不是等全文。
- 收益：把"文字出现 → 开口"从"整段生成 + 整段合成"缩短到"首句生成 + 首句合成"。
- 涉及：`VoidStage.tsx` 流式回调、`voicePlaybackController.ts`（需支持音频队列顺序播放）。

**任务 C：Doubao / MiniMax TTS 真实播报复验（承接第 7.2 节）**

- 确认 Doubao `unidirectional` 端点真实返回结构、`speaker` 与 `seed-tts-2.0` 资源匹配；确认 MiniMax `t2a_v2` 真实返回结构。
- 确认 `speaking` 状态与真实播放起止对齐。
- 只有复验通过，才考虑把 Doubao 顺序复位到第一。

**任务 D：Doubao STT 真实 WebSocket 桥接（承接第 7.3 节）**

- 现状：`stt/` 下已有 `doubaoStreamingSttProvider.ts`、`voicePcmEncoder.ts`、`voiceSttBridgeProtocol.ts`、`voiceSttContract.ts` 骨架，但 WebSocket 桥接未真正打通。
- 需要：服务端/中间层 WebSocket 桥接 + 自定义鉴权头转发 + 二进制分包 → 识别事件解析 → interim/final → final 文本并入现有 `handleTextMessage`。
- 约束：不允许伪装"前端直连可用"，不允许把二进制桥接塞进页面组件。

**任务 E：人格与安全边界验证（承接第 7.4 节）**

- 文本 + 语音双链路测人格一致性、情绪安抚、高风险拒答；记录失败样例并至少回修一轮。

### 13.4 本节明确禁止

1. 不要再查 FishAudio 鉴权/余额（已通，见 13.1）。
2. 不要把 `kittaaudio.com` / `fishaudio.org` 写回代码。
3. 不要把延迟问题归咎于 `voiceTtsResponse.ts` / 播放器——根因是串行 await + 无超时，见 13.2。
4. 做任务 A 的顺序调整时，不要删除 Doubao / MiniMax 分支，只调顺序。
5. 改代码前若与本节结论冲突，必须先说明依据来自哪份官方资料，以及为何比真实联调结果更可信。

### 13.5 相关文件（做任务 A/B 前先看）

- `src/features/void-stage/VoidStage.tsx`（`synthesizeSpeech` 串行降级、`completeTextResponse` 播报编排）
- `src/features/voice/tts/doubaoTtsProvider.ts`（无超时，需加 `AbortController`）
- `src/features/voice/tts/minimaxTtsProvider.ts`、`fishAudioTtsProvider.ts`（同上）
- `src/features/voice/voiceProxyUrl.ts`（`fetchVoiceWithProxy`，需透传 `signal`）
- `src/features/voice/tts/voicePlaybackController.ts`（任务 B 音频队列播放）
