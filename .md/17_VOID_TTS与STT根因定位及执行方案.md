# 17 VOID TTS 与 STT 根因定位及执行方案

> 文档目的：先把当前语音链路的真实问题、证据、根因、执行顺序写清楚，再决定具体改哪些代码。
> 当前阶段：先收敛 `Doubao TTS`，暂不把 `MiniMax` 重新混入主排查链路。

## 1. 当前结论先说清楚

当前 `VOID Web MVP` 的文本主链路是通的：

1. 用户发送文字消息后，模型可以正常回复。
2. 问题集中在语音输出 `TTS`，不是模型回复主链路本身。
3. `Doubao STT` 真实桥接还没有完成，但它不是当前“AI 不说话”的第一根因。

当前最需要先确认的不是“继续多改代码”，而是下面两个根因：

1. `Doubao TTS` 的 `resourceId / speaker / 账号授权` 是否匹配。
2. 浏览器当前运行的是否真的是最新 TTS 解析代码，而不是 `Vite HMR` 失效后的旧模块。

## 2. 已拿到的关键证据

### 2.1 文本链路正常

用户已经验证过：

1. 输入文本消息后，AI 可以正常返回文字回复。
2. 说明 `handleTextMessage` 主链路没有断。
3. 说明当前不是模型提供商请求整体失效。

### 2.2 曾出现过 401

控制台曾明确出现：

```text
POST http://localhost:5173/void-voice-proxy 401 (Unauthorized)
```

这说明当时至少有一轮请求确实打到了上游，且被上游鉴权拒绝或资源拒绝。

这类报错不能简单理解成“前端播放器有问题”。

### 2.3 曾出现过成功 JSON 预览

用户明确提供过这一段响应预览：

```json
{"code":0,"message":"","data":"SUQzBAAA..."}
```

这段信息非常关键：

1. `code: 0` 代表成功，不是业务失败。
2. `data` 以 `SUQz` 开头，这通常就是 `ID3` 的 Base64 形式，极像 `MP3` 文件头。
3. 这说明 Doubao 至少在某一轮请求里，已经返回过“可还原成音频”的成功结果。

因此，“豆包根本没有返回音频”这个判断不成立。

### 2.4 又出现过资源级错误

后续又明确拿到过两类错误：

```text
resource ID is mismatched with speaker related resource
```

```text
[resource_id=volc.service_type.1029] requested resource not granted
```

这两个错误直接说明：

1. 当前问题不只是播放器问题。
2. 当前账号、项目、`speaker`、`resourceId` 之间存在资源绑定或授权问题。

### 2.5 开发态还出现过 HMR 失效

控制台曾出现：

```text
/src/features/voice/tts/voiceTtsResponse.ts?t=... 404
[vite] Failed to reload /src/features/void-stage/VoidStage.tsx
```

这说明开发环境出现过下面这种情况：

1. 本地文件已经改了。
2. 浏览器热更新没有真正替换成功。
3. 页面仍可能在跑旧的 TTS 解析逻辑。

这会直接污染我们对“当前报错到底来自哪一版代码”的判断。

## 3. 当前最可能的真实根因

## 3.1 根因 A：TTS 资源 ID 与音色资源不匹配

这是当前最硬的业务根因之一。

### 证据

1. 已拿到 `resource ID is mismatched with speaker related resource`。
2. 已拿到 `[resource_id=volc.service_type.1029] requested resource not granted`。
3. 用户一度把 `X-Api-Resource-Id` 填成了 `volc.seedasr.sauc.duration`，而这实际上是 `ASR/STT` 资源，不是 `TTS` 资源。

### 结论

当前不能再把 `resourceId` 当成一个随便填的字段。

对 Doubao TTS 来说：

1. 普通豆包 2.0 音色，应优先使用 `seed-tts-2.0`。
2. 复刻音色，才考虑 `seed-icl-2.0`。
3. `volc.seedasr.sauc.duration` 这类值是 STT 资源，绝不能给 TTS 用。
4. `volc.service_type.1029` 虽然曾在控制台快速接入示例里出现过，但当前账号已经明确对它报过 `requested resource not granted`，所以不能再把它当成当前项目的默认正确值。

## 3.2 根因 B：前端曾把成功的 Base64 音频响应误判成异常

这是当前第二个核心根因。

### 证据

1. 用户看到的报错是：

```text
豆包TTS返回的内容不是可解析的音频流，也不是合法JSON
```

2. 但同一次排查里，响应预览却是：

```json
{"code":0,"message":"","data":"SUQzBAAA..."}
```

这两者是矛盾的。

因为上面这段响应本身就是合法 JSON，而且还是成功 JSON。

### 结论

真正的问题不是“上游没返回正确内容”，而是：

1. 前端旧解析逻辑曾经没有正确识别 `data` 里的 Base64 音频。
2. 或者浏览器当时跑的仍是旧模块，导致页面继续报旧错误。

## 3.3 根因 C：开发态 HMR 失效，导致页面错误信息不可信

### 证据

1. 已出现 `voiceTtsResponse.ts` 的 `404`。
2. 已出现 `Failed to reload`。
3. 当前磁盘代码与页面表现曾明显不一致。

### 结论

在开发态里，如果 `HMR` 没正确更新：

1. 你看到的页面错误，可能不是最新代码产生的。
2. 继续根据这个旧错误去改业务逻辑，会反复改错位置。

这也是为什么这次必须先写文档、先定根因，而不能继续盲改。

## 4. 关于 Doubao TTS 的最新资源结论

根据用户补充的官方“**双向流式语音合成 WebSocket**”文档，`X-Api-Resource-Id` 的可选值应优先收敛为：

1. `seed-tts-2.0`
2. `seed-icl-2.0`

这说明：

1. 普通官方音色应优先走 `seed-tts-2.0`。
2. 复刻音色才走 `seed-icl-2.0`。
3. 之前代码里默认写成 `volc.service_type.1029`，当前不应再继续当作默认结论。

## 5. 当前已有音色与资源的对应判断

用户提供的这一组音色，例如：

1. `zh_female_xiaohe_uranus_bigtts`
2. `zh_male_xuanyijieshuo_uranus_bigtts`
3. `zh_female_qingchezizi_uranus_bigtts`
4. `zh_male_aojiaobazong_uranus_bigtts`

从命名上看，它们更像普通豆包官方音色，而不是用户自己复刻的音色。

因此当前第一判断应是：

1. 这些音色优先配 `seed-tts-2.0`。
2. 不应先配 `seed-icl-2.0`。
3. 更不应配 STT 的 `resourceId`。

## 6. 对“HTTP”和“WebSocket”的大白话结论

这里只保留当前排查真正需要的最短结论：

1. `HTTP` 更像“你发一次完整文本，我一次性回你一个结果”，适合当前先把“AI 回复后自动播报”这条链路打通。
2. `WebSocket` 更像“你我一直保持通话连接，文字和音频可以边发边回”，适合后面做低延迟实时对话。

所以当前阶段，先把 `Doubao TTS HTTP` 打通是合理的，不需要立刻切到双向流式 `WebSocket TTS`。

## 7. 当前执行方案

后续必须按这个顺序推进，不能跳。

### 第一步：先稳定当前根因判断

先确认三件事：

1. `Doubao TTS Resource ID` 默认值必须回到 `seed-tts-2.0` 认知。
2. `speaker` 使用普通豆包官方音色时，不再混用 `seed-icl-2.0` 或 STT 资源。
3. 页面当前报错不能只看浮层文字，必须结合真实响应与当前实际加载代码一起判断。

### 第二步：修正 TTS 的真实请求与真实响应解析

代码层最终应做到：

1. 请求头正确带上 `X-Api-Key`。
2. 请求头正确带上 `X-Api-Resource-Id`。
3. 普通音色默认走 `seed-tts-2.0`。
4. 当返回 `{"code":0,"message":"","data":"SUQz..."}` 这种 JSON 时，前端必须把 `data` 当作 Base64 音频解码，而不是报错。
5. 当返回业务错误 JSON 时，前端必须优先显示真实错误码和真实错误消息。

### 第三步：排除开发态旧模块干扰

需要把“页面是否在跑旧模块”这件事单独解决。

否则会出现：

1. 磁盘上的解析代码已经对了。
2. 页面实际仍跑旧代码。
3. 最终我们以为是 TTS 契约错了，实际只是 HMR 脏状态。

### 第四步：Doubao TTS 打通后，再进入 STT 真实桥接

STT 当前仍然是未完成状态，后续要做的是：

1. 服务端或中间层 WebSocket 桥接。
2. 自定义头转发。
3. 二进制协议封包与解包。
4. 最终识别文本进入 `handleTextMessage`。

## 8. 本轮不再继续犯的错误

后续明确禁止再做这些事：

1. 再把 `ASR/STT` 的 `resourceId` 填进 `TTS` 配置。
2. 再把 `volc.service_type.1029` 当成当前项目默认正确值继续扩散到文案和代码。
3. 仅凭页面浮层那一句“不是合法 JSON”就断定上游没返回音频。
4. 在 `HMR 404 / Failed to reload` 的前提下继续根据旧页面报错反复改逻辑。
5. 把 `MiniMax` 重新混入当前 Doubao 主链路排查。

## 9. 下一次动代码前的明确改动目标

当开始正式改代码时，改动目标应非常收敛，只做这几件事：

1. 统一 `Doubao TTS Resource ID` 的默认认知为 `seed-tts-2.0`。
2. 调整设置面板文案，明确普通豆包音色用 `seed-tts-2.0`，复刻音色用 `seed-icl-2.0`。
3. 保留对错误 `resourceId` 的本地拦截，但不再推荐 `volc.service_type.1029`。
4. 保证 `voiceTtsResponse` 对 Doubao 成功 JSON 的 Base64 音频解析路径稳定。
5. 在验证阶段明确区分“上游资源错误”和“前端旧模块错误”。

## 10. 当前一句话总结

当前不是“豆包根本不返回音频”，而是“Doubao TTS 已经暴露出资源授权/资源绑定问题，同时前端开发态还曾跑旧解析模块，导致页面错误信息混淆了真实根因”。下一步应该先按官方 TTS 文档把 `resourceId` 收敛到 `seed-tts-2.0 / seed-icl-2.0` 体系，再用最新解析逻辑验证成功 JSON 音频链路。
