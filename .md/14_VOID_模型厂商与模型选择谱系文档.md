# VOID 模型厂商与模型选择谱系文档

> 本文档用于先梳理“设置 - 模型选择”应该展示哪些模型。当前只做方案确认，不作为最终代码实现。原则是：只列近一年内仍有使用价值的模型；过旧、已明显淘汰、仅用于兼容的模型不进入默认下拉。

## 1. 设计原则

1. 模型选择栏只放当前和近一年内仍值得使用的模型。
2. 不把很旧的模型塞进默认选项，例如 GPT-4o、GPT-4o mini 这类不应继续占用主要位置。
3. 如果厂商有清晰的强度层级，就在“模型强度”里映射到真实模型 ID。
4. “模型强度”不是装饰选项，用户选择 Low / Middle / High / Max 后，实际请求必须调用对应模型。
5. 如果某个厂商没有某一代的 Haiku / Sonnet / Opus 全系列，就不要臆造。
6. 中转站不作为独立厂商预设。用户仍可选择对应厂商后手动填写 Base URL 和 Key。
7. 模型 ID 必须以官方文档为准；不确定的模型只能进入“待确认”，不能进入默认下拉。

## 2. OpenAI

### 2.1 当前应进入下拉的模型

| 展示名 | 模型 ID | 强度建议 | 说明 |
| --- | --- | --- | --- |
| GPT-5.5 | `gpt-5.5` | Max | 当前主力最高档，适合 agent、复杂代码、长任务。 |
| GPT-5.4 | `gpt-5.4` | High | 前一代高能力模型，仍有使用价值。 |
| GPT-5.4 mini | `gpt-5.4-mini` | Middle | 更轻量，适合常规对话和成本控制。 |
| GPT-5.3 Codex | 待确认 API ID | High / Max | 用户希望保留的近代 Codex 向模型；必须确认是否可通过当前 API 直接调用。 |
| GPT-5.2 | 待确认 API ID | Middle / High | 近一年内前代模型，可作为兼容选项；需要确认官方 API ID。 |

### 2.2 不应进入默认下拉

| 模型 | 原因 |
| --- | --- |
| GPT-4o | 过旧，不符合“近一年内有价值的前几代模型”定位。 |
| GPT-4o mini | 过旧，低价兼容价值不应优先于 GPT-5 系列。 |
| GPT-4.1 / GPT-4.1 mini | 如果不是特殊兼容需求，不放进主下拉。 |

### 2.3 OpenAI 强度映射建议

| 强度 | 默认模型 |
| --- | --- |
| Low | `gpt-5.4-mini` |
| Middle | `gpt-5.2`，待确认 API ID |
| High | `gpt-5.4` |
| Max | `gpt-5.5` |

如果 `gpt-5.3-codex` 确认可直接 API 调用，可以加入 High 或 Max，并标注为代码/工程向。

## 3. Anthropic Claude

### 3.1 需要按“代际 + 家族”列出

Anthropic 的模型不应该只列一条 Haiku、一条 Sonnet、一条 Opus。正确结构应该是：

```text
Claude 4.8
  - Opus 4.8
  - Sonnet 4.8（如官方存在）
  - Haiku 4.8（如官方存在）

Claude 4.7
  - Opus 4.7（如官方存在）
  - Sonnet 4.7（如官方存在）
  - Haiku 4.7（如官方存在）

Claude 4.6
  - Opus 4.6（如官方存在）
  - Sonnet 4.6（如官方存在）
  - Haiku 4.6（如官方存在）

Claude 4.5
  - Opus 4.5（如官方存在）
  - Sonnet 4.5（如官方存在）
  - Haiku 4.5（如官方存在）
```

### 3.2 当前已确认可优先列入的模型

| 展示名 | 模型 ID | 强度建议 | 说明 |
| --- | --- | --- | --- |
| Claude Fable 5 | `claude-fable-5` | Max | 当前最新一档，是否默认使用需要结合成本和可用性确认。 |
| Claude Opus 4.8 | `claude-opus-4-8` | Max | 高能力模型。 |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | High | 中高强度，适合 agent 和代码。 |
| Claude Haiku 4.5 | `claude-haiku-4-5` | Low | 轻量快速。 |

### 3.3 待确认模型

以下模型不能凭感觉加入，需要查到官方 API ID 后再进下拉：

| 代际 | Opus | Sonnet | Haiku |
| --- | --- | --- | --- |
| Claude 4.8 | `claude-opus-4-8` 已确认 | 待确认 | 待确认 |
| Claude 4.7 | 待确认 | 待确认 | 待确认 |
| Claude 4.6 | 待确认 | `claude-sonnet-4-6` 已确认 | 待确认 |
| Claude 4.5 | 待确认 | 待确认 | `claude-haiku-4-5` 已确认 |

### 3.4 Anthropic 强度映射建议

| 强度 | 默认模型 |
| --- | --- |
| Low | `claude-haiku-4-5` |
| Middle | 待确认 Sonnet 4.5 / Sonnet 4.6 |
| High | `claude-sonnet-4-6` |
| Max | `claude-opus-4-8` 或 `claude-fable-5` |

如果用户选择“模型选择”里的某个具体模型，则以具体模型为准；如果用户选择“模型强度”，则切换到该强度对应的默认模型。

## 4. DeepSeek

### 4.1 当前应进入下拉的模型

| 展示名 | 模型 ID | 强度建议 | 说明 |
| --- | --- | --- | --- |
| DeepSeek V4 Flash | `deepseek-v4-flash` | Low / Middle | 快速、成本更低，适合默认轻量档。 |
| DeepSeek V4 Pro | `deepseek-v4-pro` | High / Max | 更强能力，适合复杂任务。 |

### 4.2 不应进入默认下拉

| 模型 | 原因 |
| --- | --- |
| `deepseek-chat` | 已有废弃时间，不应再作为默认。 |
| `deepseek-reasoner` | 已有废弃时间，不应再作为默认。 |

### 4.3 DeepSeek 强度映射建议

| 强度 | 默认模型 |
| --- | --- |
| Low | `deepseek-v4-flash` |
| Middle | `deepseek-v4-flash` |
| High | `deepseek-v4-pro` |
| Max | `deepseek-v4-pro` |

## 5. 智谱 / Z.AI

### 5.1 当前候选模型

| 展示名 | 模型 ID | 强度建议 | 状态 |
| --- | --- | --- | --- |
| GLM-5.2 | `glm-5.2` | Max | 待最终 API ID 确认。 |
| GLM-5.1 | `glm-5.1` | High | 待最终 API ID 确认。 |
| GLM-5 | `glm-5` | High | 待最终 API ID 确认。 |
| GLM-5 Turbo | `glm-5-turbo` | Middle | 待最终 API ID 确认。 |
| GLM-5 Flash | `glm-5-flash` | Low | 待最终 API ID 确认。 |

### 5.2 不应进入默认下拉

| 模型 | 原因 |
| --- | --- |
| GLM-4 Flash | 已不符合当前“近一年内主力模型”定位。 |
| GLM-4 / GLM-4.5 老系列 | 只有兼容价值，不放默认主列表。 |

## 6. 豆包 Ark

豆包 Ark 的模型 ID 更依赖火山方舟控制台和具体开通区域。当前不应该凭记忆写死一串模型名。

### 6.1 建议策略

1. 默认保留豆包 Ark 厂商预设。
2. Base URL 使用官方 Ark OpenAI-compatible 地址。
3. 模型选择中先提供“自定义模型”入口。
4. 等确认火山方舟当前官方模型 ID 后，再补全近一年内的主力模型。

## 7. 设置面板最终交互建议

### 7.1 模型选择

按厂商显示真实模型：

```text
服务预设：OpenAI
模型选择：
  GPT-5.5
  GPT-5.4
  GPT-5.4 mini
  GPT-5.3 Codex（确认 API ID 后加入）
  GPT-5.2（确认 API ID 后加入）
```

```text
服务预设：Anthropic Claude
模型选择：
  Claude Fable 5
  Claude Opus 4.8
  Claude 4.8 Sonnet（确认存在后加入）
  Claude 4.8 Haiku（确认存在后加入）
  Claude Opus 4.7（确认存在后加入）
  Claude Sonnet 4.6
  Claude Haiku 4.5
```

### 7.2 模型强度

“模型强度”应该是对真实模型的快速映射：

| 强度 | 意义 |
| --- | --- |
| Low | 更快、更省，适合轻量对话。 |
| Middle | 平衡能力和成本，适合日常默认。 |
| High | 更强任务能力，适合代码和复杂分析。 |
| Max | 当前厂商最高能力档，适合重任务。 |

用户选择强度后，必须同步更新实际 `modelName`。

### 7.3 自定义模型

自定义模型仍然需要保留，但不建议占据主视觉位置。建议做成：

```text
模型选择：
  [下拉选择官方模型]
  [高级：自定义模型名]
```

这样既满足官方模型选择，也不破坏中转站或新模型的接入能力。

## 8. 下一步确认项

实现代码前需要确认：

1. OpenAI 是否只保留 GPT-5.5 / GPT-5.4 / GPT-5.4 mini / GPT-5.3 Codex / GPT-5.2。
- 是的
2. GPT-5.3 Codex 和 GPT-5.2 的真实 API ID 是否已确认。
- “真实 API ID”是什么？
3. Anthropic 是否采用“只列官方已确认存在的家族成员”，不补不存在的 Haiku / Sonnet / Opus。
- 是的，反正就是你自己查一下Anthropic官方在每一代都发布了哪一些分支模型，比如4.5是否有opus、haiku和sonnet，4.7是否有haiku、sonnet之类的这种，然后就可以按照查询之后的结果留下官方已确认存在的“家庭成员”
4. 豆包 Ark 是否暂时只保留自定义模型名，等确认官方 ID 后再补。
- 什么意思？你这边不能自己查询吗？
5. 自定义模型名是作为高级折叠项，还是继续常驻显示。
- 作为高级折叠项