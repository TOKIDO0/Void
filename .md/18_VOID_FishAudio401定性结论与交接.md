# 18 VOID FishAudio 401 定性结论与交接

> 文档用途：承接 2026-07-05 Claude 对 FishAudio `401` 的根因定性，供新窗口直接继续。
> 优先级：本文件关于 FishAudio 的结论，高于 `.md/16` 第 12 节之前的历史推断，与第 12 节一致并在其上收敛。
> 阅读顺序：先读本文件 → 再读 `.md/16_VOID_WebMVP下一步执行拆分与验收文档.md`（尤其第 12 节）→ 再读 `.md/17_VOID_TTS与STT根因定位及执行方案.md`。

## 1. 已经用真实网络联调定死的结论（不要再推翻）

### 1.1 请求格式已与 Fish Audio 官方完全一致

当前代码发出的 FishAudio 请求逐项对齐官方规范，无可改点：

- Endpoint：`https://api.fish.audio/v1/tts`
- 鉴权：`Authorization: Bearer <apiKey>`
- 模型：放在 header `model: s2-pro`
- Body：`{ "text": ..., "reference_id": <voiceId>, "format": "mp3" }`
- Bearer 前缀已去重（日志 `apiKeyHasBearerPrefix: false`）

代理链路也正常：`vite.config.ts` 的 `buildForwardedHeaders` 白名单包含 `authorization`，Bearer token 真实转发到了上游，不是被代理吞掉。

### 1.2 决定性裸测结果（脱离项目代码）

2026-07-05 用用户当天新生成的 API Key `b47881...ea465c`，直接用官方 curl 打 api.fish.audio：

| 测试 | 结果 |
|---|---|
| `POST https://api.fish.audio/v1/tts`（官方标准格式） | `401 {"message":"Invalid Token","status":401}` |
| `GET https://api.fish.audio/wallet/self/api-credit` | `401 {"message":"Invalid token"}` |
| 无 Bearer 直接放 key | `401` |

三点定死：

1. 上游返回的是 **`Invalid Token`**，不是 `402 insufficient balance`。→ 定性为 **“Key 无效”**，不是“余额不足”，也不是“区域/产品余额”问题。
2. 这是**完全脱离项目代码**的裸测，官方格式一字不差仍被拒。→ 100% 排除前端播放器、`voiceTtsResponse.ts` 解析、Vite HMR、`/void-voice-proxy` 代理。
3. 连“刚生成的新 Key”也是 `Invalid Token`。→ 极大概率这把 Key **不是在 `https://fish.audio/app/api-keys/` 本尊生成**（疑似来自 kittaaudio.com / fishaudio.org 等别的站点/产品体系），或该账号 API 尚未开通/激活。

### 1.3 最终收口（2026-07-05 二次裸测，根因彻底定死）

用户此前一直误用**仿冒站 `fishaudio.org`** 生成 key，官方只有 `fish.audio`。改用官方 `https://fish.audio/app/api-keys/` 生成新 Key（32 位 hex）后再裸测：

| Key 来源 | `GET /wallet/self/api-credit` | `POST /v1/tts` | 结论 |
|---|---|---|---|
| 旧 Key（fishaudio.org 仿冒站，64 位） | `401 Invalid Token` | `401` | Key 无效 |
| 新 Key（fish.audio 官方，32 位） | `200`，`credit:"0"`，`has_free_credit:null` | `402` | Key 有效，API 余额=0 |

`402` 原文：`Insufficient API credit. API credit is managed independently from platform credit. Please visit https://fish.audio/app/developers to view your API credit balance or add funds.`

**最终定性**：
1. `401` 已彻底解决，原因就是**用错网站**（仿冒站 key 对 api.fish.audio 天然 `Invalid Token`）。
2. 现在唯一拦路是 **API 余额=0（402）**，且 **API 余额与网页端平台余额是两套、互不通用**。
3. 解决动作**纯账号侧**：到 `https://fish.audio/app/developers` 给 **API credit** 充值；把官方新 Key 填回设置面板。代码零改动。

### 1.4 400 收口（2026-07-05 充值后，FishAudio 全链路打通）

用户充值 1 美金后，`402` 消失，出现 `400`。裸测定性：

| 测试 | 结果 |
|---|---|
| `s2.1-pro`（免费模型）+ 无 reference_id | `200 audio/mpeg`，30928 字节，帧头 `fffb`（真 MP3） |
| `s2-pro` / `s2.1-pro` + 无效 36 位 reference_id | `400 {"message":"Reference not found"}` |

**400 真凶**：前端设置里的 36 位 Voice ID 是从仿冒站 `fishaudio.org` 带来的，官方账号里不存在。

**已落地的代码改动（依据：用户明确要求用免费模型 + 官方博客 https://fish.audio/zh-CN/blog/s2-1-pro-free-api/ + 真实裸测 200）**：
1. `voiceProviderConfig.ts`：`FISHAUDIO_TTS_MODEL` 由 `s2-pro` 改为免费的 `s2.1-pro`。
2. `fishAudioTtsProvider.ts`：`reference_id` 改为可选，Voice ID 为空时不再强制发送（避免 Reference not found），Voice ID 不再是必填；模型白名单接受 `s2.1-pro`。
3. `voiceRuntimeConfig.ts`：同步模型白名单接受 `s2.1-pro`。

**用户需在设置面板完成（纯 UI，无需再改代码）**：
- API Key 填官方 `9d5edea729af4e20b69139bf3f260aeb`。
- **Voice ID 清空**（除非持有官方有效音色 ID），保存后旧的无效值会从 localStorage 移除。
- 模型填 `s2.1-pro` 或清空（代码默认即 `s2.1-pro`）。
- 保存后刷新页面，即用免费模型 + 默认音色出声。

**FishAudio 至此全链路打通**：`401`(用错站) → `402`(余额0) → `400`(无效音色) → **200 真实音频**。

### 1.5 二次充值后仍无声：两层原因（2026-07-05 复测日志）

充值后再次尝试仍无声，日志暴露两层问题，**第一层与 FishAudio 无关**：

```
[vite] server connection lost. Polling for restart...
POST http://localhost:5173/void-voice-proxy   net::ERR_CONNECTION_RESET
POST http://localhost:5173/void-model-proxy   net::ERR_CONNECTION_REFUSED
fishAudioTtsProvider.ts:97 [VOID FishAudio request] { model: 's2-pro', voiceIdLength: 32, apiKeyLength: 32, ... }
```

**第一层：Vite 开发服务器崩溃（当前一切失效的直接原因）**
- `ERR_CONNECTION_REFUSED` 出现在 `/void-voice-proxy` 与 `/void-model-proxy` 两个代理上 → 5173 进程已停，连文本模型都不可达。
- 结论：此刻“无声”首先是**服务器没跑**，不是 FishAudio 问题。必须先重启 `npm run dev`，并观察终端是否有崩溃堆栈（定位崩溃根因，可能与近期文件保存 / vite.config 改动有关）。

**第二层：设置未真正生效（重启后仍会挡住语音）**
- 日志 `model: 's2-pro'` → localStorage `void.voice.fishAudioModel` 仍是付费的 `s2-pro`，用户并未改成 `s2.1-pro` 也未清空。代码不会覆盖用户显式选择（`s2-pro` 是合法值）。
- 日志 `voiceIdLength: 32` → Voice ID **未清空**，仍有 32 字符。用户 API Key 恰为 32 位（`9d5edea729af4e20b69139bf3f260aeb`），**高度怀疑把 API Key 误粘进了 Voice ID 框**，会再次触发 `Reference not found 400`。
- 代码新逻辑已加载（日志行号由 `:96` 变 `:97` 佐证），但被 localStorage 旧值盖过。

**目标正确状态**：`model = s2.1-pro`（或留空，代码默认即 s2.1-pro）、`Voice ID = 空（voiceIdLength 应为 0）`、`API Key = 9d5edea729af4e20b69139bf3f260aeb`。

### 1.6 FishAudio 后端已完全打通（2026-07-05 终测，避开中文编码干扰）

> 注意：Windows Git Bash 用 `-d` 直传中文会触发 `400 invalid unicode code point`，那是本地 shell 编码问题，**不是 API 问题**。裸测须用英文文本或 `--data-binary @file`（UTF-8 文件）。

充值 1 美元后，用官方 Key `9d5edea729af4e20b69139bf3f260aeb`、英文文本、无 `reference_id` 裸测：

| 模型 | 结果 | 是否扣费 |
|---|---|---|
| **s2.1-pro** | `200` audio/mpeg，真实 MP3（头 `ff fb 90`） | **不扣费（免费）** |
| s2-pro | `200` 真实 MP3 | 扣费 |
| speech-1.5 | `200` 真实 MP3 | 扣费 |

**s2.1-pro 免费实证**：连续两次调用 s2.1-pro，余额始终 `0.995530` 不变（`updated_at` 亦未变），印证官方博客 `s2-1-pro-free-api`。→ **VOID 默认就用 `s2.1-pro`，零成本。**

## 2. 当前 FishAudio 的可执行结论（已收口）

- **账号/凭证/余额三层已全部解决**：官方 Key 有效、API 余额已充值、s2.1-pro 免费可用。
- **FishAudio 后端 100% 正常**，代码请求形态正确、无需改动。
- **当前唯一残留是本地环境态两点**（见 1.5），与 FishAudio 无关：
  1. **Vite 开发服务器崩溃** → 必须 `npm run dev` 重启，两个代理才恢复。
  2. **设置面板旧值未清** → `model` 应为 `s2.1-pro`（免费）、`Voice ID` 必须清空（当前 32 字符疑为误粘的 API Key，会触发 `Reference not found 400`）。
- **历史 401/402/400 判读口径存档**（供他人复用）：
  - `401 Invalid Token` → Key 无效 / 来源错站（如 fishaudio.org 仿冒站）。
  - `402 insufficient credit` → Key 有效，API 余额=0，去 `https://fish.audio/app/developers` 充 **API credit**（≠ 网页平台 credit）。
  - `400 Reference not found` → `reference_id` 不是有效音色，清空即用默认音色。
  - `400 invalid unicode code point` → 本地 shell/编码问题，非 API。
  - `200 audio/mpeg + ff fb` 开头 → 真实 MP3，成功。

## 3. 明确禁止再做的事（沿用 `.md/16` 第 12.6 节并补充）

1. 不要再把 `kittaaudio.com/api/v1/tts/speech` 写回代码（已证伪，回站点 404 HTML）。
2. 不要再把问题归咎于 `voiceTtsResponse.ts` / 播放器 / HMR。
3. 不要再来回切换 `voiceId/reference_id`、`model header/body` 试运气。
4. 不要在 FishAudio Key 未打通前扩写 FishAudio 业务逻辑、音色策略、排序策略。
5. 不要因为中文文档页面出现某示例地址就无视真实联调结果。
6. 不要因为 FishAudio 未通就去改动 Doubao / MiniMax 主线。

## 4. 项目当前真实状态快照

- 文本主链路：正常（用户发文字，模型正常回复）。
- TTS 播报尝试顺序：Doubao → FishAudio → MiniMax。
- FishAudio：请求格式正确，Key 已换成官方本尊且已充值，`401/402/400` 已逐一定性解决；裸测（`s2.1-pro` + 无 reference_id）已返回真实 MP3。**当前唯一残留是本地环境态：① Vite 服务器需重启；② 设置里 model/voiceId 旧值未清（见 1.5）。**
- Doubao TTS：`resourceId` 已收敛为 `seed-tts-2.0`，响应解析已支持成功 JSON 的 Base64 音频；真实播报联调仍需在有效凭证下复验。
- MiniMax TTS：provider 已在，真实返回格式待复验。
- STT（Doubao 流式识别）：仍是骨架，未真实打通，需要服务端 WebSocket 桥接 + 自定义鉴权头转发 + 二进制分包，属于后续任务。
- 人格与安全边界验证：尚未真正执行。

## 5. 未完成任务与推进顺序（新窗口按此走）

**第 0 步（当前唯一卡点，纯本地，不改代码即可验证）：让 FishAudio 在应用里真的出声**
1. 重启 `npm run dev`，看终端崩溃堆栈（定位为何 5173 进程会挂）；确认 `/void-voice-proxy`、`/void-model-proxy` 恢复可达。
2. 打开设置面板 → FishAudio：
   - `model` 填 `s2.1-pro`（免费）——或清空（代码默认即 s2.1-pro）。
   - `Voice ID` **清空**（当前 32 字符是误粘的 API Key，必须删掉；留空用默认音色）。
   - `API Key` 确认为 `9d5edea729af4e20b69139bf3f260aeb`。
3. 发一条消息，确认前端日志 `voiceIdLength: 0`、`model: 's2.1-pro'`，且 `/void-voice-proxy` 返回 `200` 并真实播放。
   - 若默认音色能出声即算通过；是否配自定义音色（真实的 reference_id）由用户后续决定，不阻塞。

**后续（第 0 步通过后）**
4. **Doubao / MiniMax TTS 真实播报复验**：确认“模型回复后自动播报”闭环，`speaking` 状态与真实播放起止对齐；确认三家 provider 的尝试顺序与失败降级正常。
5. **Doubao STT 真实桥接**：麦克风采集 → 分片 → 服务端/中间层 WebSocket 桥接 → 自定义鉴权头转发 → 识别事件解析 → interim/final → final 进入现有 `handleTextMessage`。不允许伪装“前端直连可用”，不允许把二进制桥接塞进页面组件。
6. **人格与安全边界验证**：文本+语音双链路测人格一致性、情绪安抚、高风险拒答，记录失败样例并至少回修一轮。

## 6. 相关文件（改动前先看）

- `src/features/voice/voiceProviderConfig.ts`（FishAudio endpoint / model 常量）
- `src/features/voice/tts/fishAudioTtsProvider.ts`（请求装配、Bearer 归一化、开发态日志）
- `src/features/voice/voiceRuntimeConfig.ts`（历史旧值规范化）
- `src/features/voice/tts/voiceTtsResponse.ts`（响应解析，含错误 JSON 读取）
- `src/features/void-stage/VoidStage.tsx`（播报编排、401/402/403 用户态提示）
- `vite.config.ts`（`/void-voice-proxy` 透明转发、header 白名单）

## 7. 新窗口可直接粘贴的接手提示词

```text
你继续接手 VOID Web MVP 语音主线。

先按顺序读：
1. .md/18_VOID_FishAudio401定性结论与交接.md（尤其 1.5、1.6、第 5 节第 0 步）
2. .md/16_VOID_WebMVP下一步执行拆分与验收文档.md（尤其第 12 节）
3. .md/17_VOID_TTS与STT根因定位及执行方案.md

必须接受的既定结论（已用真实裸测定死，不要推翻，不要再查 FishAudio 鉴权/余额）：
- FishAudio 后端已 100% 打通：官方 Key 9d5edea729af4e20b69139bf3f260aeb 有效、API 余额已充值、s2.1-pro 免费可用。
- 裸测 s2.1-pro/s2-pro/speech-1.5 均返回 200 真实 MP3；s2.1-pro 不扣费。
- 之前无声的历史原因已全部定性解决：用错仿冒站 fishaudio.org(401)→换官方(402 余额=0)→充值后(200)。

当前唯一残留是本地环境态，且大概率不需要改代码：
1. Vite 开发服务器崩了（日志 ERR_CONNECTION_REFUSED on /void-voice-proxy 和 /void-model-proxy）。先重启 npm run dev，看终端崩溃堆栈定位原因。
2. 设置面板旧值没清：日志 model 仍是 s2-pro、voiceIdLength=32（疑为把 API Key 误粘进 Voice ID 框）。正确状态是 model=s2.1-pro（或留空）、Voice ID 清空、API Key=9d5edea729af4e20b69139bf3f260aeb。

你要做的（按第 5 节顺序）：
0. 先让 FishAudio 在应用里真的出声：重启 dev server + 清设置里的 voiceId、改 model=s2.1-pro，发消息确认 /void-voice-proxy 返回 200 且真实播放（voiceIdLength 应为 0）。
1. Doubao/MiniMax TTS 真实播报闭环与 speaking 状态对齐复验。
2. Doubao STT 真实 WebSocket 桥接，final 文本并入 handleTextMessage。
3. 人格与安全边界验证。

禁止：再查 FishAudio 鉴权/余额（已通）；把 kittaaudio.com 或 fishaudio.org 写回代码；归咎 voiceTtsResponse.ts/播放器；无新证据来回试 model/voiceId 字段；因语音问题去动 Doubao/MiniMax 主线的模型逻辑。
如需改代码，必须先说明依据来自哪份官方资料，以及为何比现有真实联调结果更可信。
```
