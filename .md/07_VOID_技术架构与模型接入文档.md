# VOID 技术架构与模型接入文档

> 文档作用：定义 VOID 的 Web MVP 技术主线、模型 API 接入方式、本地存储和模块边界。  
> 注意：本文不是最终技术选型锁死文件，后续开发前仍需结合实际项目结构确认。

## 1. 第一阶段技术主线

推荐第一阶段：

- Web 应用。
- React 前端。
- GSAP 动效。
- 本地浏览器存储或轻量本地数据库。
- 云端 LLM API。
- 后续再适配 Tauri 桌面端。

## 2. 大模型接入定位

VOID 不要求用户本地部署大模型。

正确理解：
- VOID 本地运行。
- 用户数据本地存储。
- LLM 可以调用云端 API。
- 用户自己填写 API Key、Base URL、模型名和请求配置。
- Ollama 只是可选本地模型 provider，不是默认主线。

## 3. Provider 适配目标

需要支持：

- OpenAI。
- Anthropic。
- MiniMax。
- DeepSeek。
- 智谱。
- Ollama。
- OpenAI-compatible 中转站。
- 未来其他厂商。

## 4. 模型配置建议

设置页应允许用户配置：

- Provider 类型。
- API Key。
- Base URL。
- Model Name。
- 请求格式类型：OpenAI-compatible、Anthropic-style、自定义 JSON。
- 温度、最大输出长度等基本参数。
- 是否启用流式输出。

高级用户可以填写自定义 JSON 模板，但不能让业务代码直接拼一堆临时字符串。

## 5. Provider 合同

所有模型适配器应实现统一合同：

- `sendMessage`
- `streamMessage`
- `validateConfig`
- `normalizeResponse`
- `mapError`

UI 和 Agent 核心不能直接依赖某个厂商 SDK 的私有结构。

## 6. 本地存储

MVP 可先使用浏览器本地存储方案；进入桌面端时再迁移到 SQLite。

需要存储：

- 用户设置。
- 模型配置。
- 对话历史。
- 分区记忆。
- 健康档案。
- 唤醒和隐私偏好。

禁止存储：

- 明文敏感密钥到不安全位置。
- 身份证、银行卡、密码等高敏感信息。

## 7. 语音管线

完整管线：

```text
麦克风输入
  -> 唤醒判断
  -> STT 语音转文字
  -> 情绪分析
  -> 记忆召回
  -> LLM 回复
  -> TTS 语音合成
  -> 前端 speaking 动效
```

MVP 可以先做：

```text
文本输入
  -> LLM 回复
  -> 状态机切换
```

再扩展语音。

## 8. 模块化架构

建议目录概念：

- `app`：应用入口。
- `components`：Ali Imam Registry 组件和本地组合组件。
- `features/agent`：对话主流程。
- `features/voice`：语音输入输出。
- `features/wake`：唤醒策略。
- `features/memory`：记忆系统。
- `features/health`：健康档案。
- `features/settings`：设置页。
- `lib/model-providers`：模型适配器。
- `lib/animation`：GSAP 动效封装。

## 9. 验收标准

Web MVP 第一闭环完成时应达到：

- 可以看到黑底 0/1 VOID 脸。
- 可以切换 idle / listening / thinking / speaking。
- 胶囊和脸部动效流畅。
- 可以配置至少一种 OpenAI-compatible API。
- 可以完成一轮文本对话。
- 对话回复使用 VOID system prompt。

