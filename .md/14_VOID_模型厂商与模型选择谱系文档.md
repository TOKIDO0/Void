# VOID 模型厂商与模型选择谱系文档

> 本文档只用于先整理“设置 - 模型选择”应该展示哪些模型，以及“模型强度”应该如何真实影响请求参数。  
> 当前原则：只保留近一年内仍有实际使用价值、且能确认官方 API ID 的模型。  
> 不确定的模型，不进入默认下拉。

## 1. 设计原则

1. “模型选择”负责选择真实 `modelName`，不再让“模型强度”反向切换成别的模型。
2. “模型强度”只对应厂商官方支持的强度/推理参数映射。
3. 只有能确认官方 API ID 的模型，才进入默认展示。
4. 对于 Anthropic / OpenAI 这类厂商，如果某一代的完整子型号不确定，不擅自补齐。
5. 豆包 Ark 默认只保留自定义模型入口，官方示例确认过的模型 ID 再补进默认下拉。

## 2. 豆包 Ark

### 2.1 已确认可用的模型 ID

以下 ID 来自火山方舟 API 接入示例，可直接作为 `modelName` 使用：

- `doubao-1-5-pro-32k-250115`
- `doubao-seed-translation-250915`
- `doubao-1-5-lite-32k-250115`
- `doubao-seed-2-1-pro-260628`
- `doubao-seed-evolving`
- `doubao-seed-2-1-turbo-260628`

### 2.2 需要继续保留的策略

1. 豆包 Ark 保留“模型选择”下拉。
2. 下拉项直接使用官方确认过的真实模型 ID。
3. 用户不需要再手动去“自定义模型名”里填错误 ID。
4. 如果未来新模型只在控制台示例中确认，先补进这里，再进界面。

## 3. OpenAI

### 3.1 当前默认展示策略

OpenAI 的“模型选择”只展示能确认的近一年主力模型。

### 3.2 当前文档结论

1. 只保留官方可确认的模型 ID。
2. 不把过旧模型放进默认主下拉。
3. “模型强度”不切换模型，只影响请求里的推理参数。

### 3.3 建议展示结构

- GPT 5 系列
  - GPT 5.5
  - GPT 5.4 Pro
  - GPT 5.4 Thinking
  - GPT 5.4
  - GPT 5.4 mini
  - GPT 5.3 Codex
  - GPT 5.2
  - GPT 5.2 mini

> 说明：上面这些名称只有在官方 API 文档里能确认时才进入最终实现。  
> 若 API ID 与展示名不一致，以官方 API ID 为准。

## 4. Anthropic Claude

### 4.1 建议展示结构

- Claude Opus
  - Claude Opus 4.8
  - Claude Opus 4.7
  - Claude Opus 4.6
  - Claude Opus 4.5
- Claude Sonnet
  - Claude Sonnet 4.8
  - Claude Sonnet 4.7
  - Claude Sonnet 4.6
  - Claude Sonnet 4.5
- Claude Haiku
  - Claude Haiku 4.8
  - Claude Haiku 4.7
  - Claude Haiku 4.6
  - Claude Haiku 4.5

> 说明：这里只是谱系结构，不代表这些每一项都已确认存在。  
> 真正进入默认下拉前，必须逐个核对官方模型名。

## 5. 模型强度的正确含义

### 5.1 错误做法

当前错误逻辑是：

- 用户选择 `gpt-5.4`
- 再切到 `High`
- 程序把模型改成 `gpt-5.5`

这个逻辑是错的。

### 5.2 正确做法

模型强度应该只做这件事：

- 保持当前模型不变
- 给请求附加厂商官方支持的强度参数

也就是：

- OpenAI：映射到官方的 reasoning/effort 类参数
- Anthropic：映射到官方的 thinking/effort 类参数

## 6. 设置面板最终交互建议

### 6.1 模型选择

```text
服务预设：OpenAI
模型选择：
  GPT-5.5
  GPT-5.4 Pro
  GPT-5.4 Thinking
  GPT-5.4
  GPT-5.4 mini
  GPT-5.3 Codex
  GPT-5.2
  GPT-5.2 mini
```

```text
服务预设：Anthropic Claude
模型选择：
  Claude Opus 4.8
  Claude Opus 4.7
  Claude Opus 4.6
  Claude Opus 4.5
  Claude Sonnet 4.8
  Claude Sonnet 4.7
  Claude Sonnet 4.6
  Claude Sonnet 4.5
  Claude Haiku 4.8
  Claude Haiku 4.7
  Claude Haiku 4.6
  Claude Haiku 4.5
```

### 6.2 模型强度

模型强度只做官方参数映射：

| 强度 | 含义 |
| --- | --- |
| Low | 更省资源，偏轻量 |
| Middle | 默认平衡档 |
| High | 更强推理档 |
| Max | 当前厂商最强档 |

## 7. 待确认项

以下内容在正式落代码前，还需要再核对官方文档后才能定死：

1. OpenAI 最终允许进入默认下拉的具体模型 ID。
2. Anthropic 每一代 Opus / Sonnet / Haiku 是否都真实存在。
3. OpenAI 的强度参数到底对应哪个官方字段。
4. Anthropic 的强度参数到底对应哪个官方字段。
