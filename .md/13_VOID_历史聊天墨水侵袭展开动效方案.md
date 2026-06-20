# VOID 历史聊天墨水侵袭展开动效方案

> 本文档用于指导下一步实现。目标是彻底移除历史聊天打开/关闭时的竖向裂隙光束，同时保留当前用户满意的粉色中空高激活流体形态，并把打开过程改造成“从流体中心开始被粉色墨水不规则侵袭”的丝滑变化。

## 1. 当前问题结论

历史聊天模态框关闭时仍然出现竖向粉色裂隙，说明问题不只来自 `ResponseRevealBeam`。

当前实现里存在两类“裂隙感”来源：

1. 独立裂隙光束：
   - 文件：`src/features/expanded-response/ResponseRevealBeam.tsx`
   - 文件：`src/features/expanded-response/responseRevealBeamShader.ts`
   - 作用：在历史聊天打开时渲染一条竖向 beam / 裂隙光效。

2. 流体中空形态内部的类裂隙结构：
   - 文件：`src/features/blob-scene/blobShader.ts`
   - 关键变量：`uExpandedResponse`、`vRingMask`、`vInnerEdge`、`innerRimColor`、`hollowFade`、`alpha`
   - 作用：让 agent 变成粉色中空高激活状态。
   - 问题：当中空结构从 `1 -> 0` 回落时，中心内缘高光和透明边界会收缩到中心，视觉上容易形成一条竖向粉色线。

所以后续修复不能继续只关 beam。需要从产品视觉逻辑上删除“裂隙打开”这条设计路线。

## 2. 新目标

### 2.1 必须删除

- 删除历史聊天打开时的竖向裂隙光束。
- 删除历史聊天关闭时可能再次出现的竖向裂隙光线。
- 删除 `ResponseRevealBeam` 在历史聊天流程中的使用。
- 不再让关闭动画倒放“裂隙/中空边缘坍缩”的视觉过程。

### 2.2 必须保留

- 保留当前 agent 粉色中空高激活形态。
- 保留当前粉色中空形态的整体质感、颜色方向、流体活性和中空状态。
- 保留历史聊天模态框本身的内容展示方式和基础布局。
- 保留打开时从普通 agent 过渡到粉色中空状态的高级感。
- 保留 `expanded bloom` 增益，不因为裂隙问题关闭 bloom 增益。

### 2.3 新增替代动效

历史聊天打开时，不再出现裂隙。新动效改为：

```text
用户打开历史聊天
  -> agent 中心出现一小片粉色不规则侵袭区域
  -> 粉色像墨水一样从中心向外扩散
  -> 侵袭边缘不是圆形硬边，而是不规则、有流体噪声的边界
  -> 侵袭过程中中心逐渐变成中空
  -> agent 完成粉色中空高激活状态
  -> 模态框内容淡入并稳定显示
```

关闭时：

```text
用户关闭历史聊天
  -> 模态框内容淡出
  -> agent 的粉色侵袭区域自然退散或被原始蓝色流体覆盖
  -> 中空状态平滑恢复为正常形态
  -> 全程不出现竖向裂隙、竖向光柱、中心亮线
```

## 3. 设计原则

1. 裂隙和粉色中空形态必须解耦。
   - 裂隙是旧设计，删除。
   - 粉色中空形态是 agent 的高激活状态，保留。

2. 墨水侵袭是流体本体变化，不是额外覆盖一层图片或 CSS。
   - 主效果应在 `blobShader.ts` 中实现。
   - CSS 只负责布局和模态框基础视觉。
   - 不新增前端测试文字。

3. 打开与关闭不能使用同一条简单反向动画。
   - 打开：颜色从中心向外侵袭，中空逐步形成。
   - 关闭：去除中空边缘的裂隙式高光，让颜色和形体自然回落。

4. 不关掉 bloom 增益。
   - bloom 本身不是问题。
   - 问题是中心窄亮线被 bloom 放大。
   - 正确做法是消除窄亮线来源，而不是关闭 bloom。

## 4. 技术拆分

### 4.1 移除独立裂隙组件

需要停止使用：

```text
src/features/expanded-response/ResponseRevealBeam.tsx
src/features/expanded-response/responseRevealBeamShader.ts
```

处理方式：

- `ExpandedResponseOverlay.tsx` 中不再渲染 `<ResponseRevealBeam />`。
- 如果文件暂时不删除，也必须从历史聊天流程中完全断开。
- 后续确认无其他引用后，可以再删除文件，避免无用代码长期保留。

### 4.2 拆分 shader 进度

`uExpandedResponse` 现在同时控制颜色、中空、边缘高光、透明度和形体变化，职责过重。

建议拆成以下概念：

```text
uExpandedResponse
  历史聊天展开总进度，仍然由 overlay timeline 驱动。

uInkSpread
  粉色墨水侵袭进度，控制颜色从中心向外蔓延。

uHollowProgress
  中空形态进度，控制中心洞和流体中空结构。

uInnerRimEnergy
  中空内缘能量，只用于稳定中空状态，不允许在关闭时收缩成中心亮线。

uExpandedResponseClosing
  关闭阶段标记，用于选择关闭路径，不用于制造裂隙。
```

如果不想增加太多 uniform，也可以先在 shader 内部由 `uExpandedResponse` 和 `uExpandedResponseClosing` 推导：

```glsl
float expanded = smoothstep(0.0, 1.0, uExpandedResponse);
float closing = smoothstep(0.0, 1.0, uExpandedResponseClosing);
float inkSpread = expanded;
float hollowProgress = expanded * (1.0 - closing * 0.85);
float innerRimEnergy = expanded * (1.0 - closing);
```

注意：这只是结构示意，具体参数需要结合视觉调试。

## 5. 墨水侵袭 shader 方案

### 5.1 侵袭范围

墨水从中心向外扩散，不使用竖向线。

建议使用径向距离和噪声共同决定：

```glsl
float radial = length(position.xy);
float inkNoise = snoise(vec3(position.xy * 2.2, uTime * 0.18));
float inkBoundary = inkSpread * 0.78 + inkNoise * 0.09;
float inkMask = smoothstep(radial - 0.16, radial + 0.16, inkBoundary);
```

视觉要求：

- `inkMask` 不能是完美圆。
- 边缘要像墨水、云雾、流体侵袭。
- 中心先变粉，随后向四周扩散。
- 扩散速度要平滑，不能闪烁。

### 5.2 颜色混合

原始颜色和粉色激活色之间，不再用全局 `expanded` 直接整体混色，而是用 `inkMask` 混色：

```glsl
vec3 baseColor = mix(uBaseColor, activeBaseColor, inkMask);
vec3 edgeColor = mix(uEdgeColor, activeEdgeColor, max(inkMask, expanded * 0.35));
```

这样打开时不是整个 agent 同时变粉，而是从中心开始被粉色侵袭。

### 5.3 中空形成

中空仍然存在，但不要表现为裂隙。

中空进度可以略微晚于颜色侵袭：

```glsl
float hollowProgress = smoothstep(0.22, 1.0, inkSpread);
```

中空半径仍可沿用当前方向：

```glsl
float innerRadius = mix(0.05, 0.43 + organicHole + surfaceBreath, hollowProgress);
```

要求：

- 中空从中心柔和形成。
- 边缘是不规则流体洞口，不是竖向裂缝。
- 中空形成时可以有内缘亮边，但亮边必须围绕洞口，不允许在中心形成竖线。

### 5.4 内缘高光

当前 `vInnerEdge` 是最容易产生裂隙残留的部分。

调整原则：

- 打开稳定后允许有内缘高光。
- 打开过程中允许内缘逐渐出现。
- 关闭时必须先快速降低内缘高光，再恢复形态。
- 内缘高光不要在中心小半径阶段过强。

建议加一个半径保护：

```glsl
float edgeRadiusGuard = smoothstep(0.16, 0.34, innerRadius);
float innerEdge = rawInnerEdge * hollowProgress * edgeRadiusGuard;
```

这样当洞口很小、接近中心时，内缘高光不会形成竖向亮线。

## 6. 动画时间线

### 6.1 打开

建议总时长：`0.95s - 1.1s`

```text
0.00s - 0.18s
  overlay 背景轻微出现
  agent 中心开始粉色侵袭

0.14s - 0.72s
  墨水侵袭从中心向外扩散
  agent 颜色逐步变为粉色高激活状态

0.28s - 0.88s
  中空结构逐步形成
  内缘高光延迟出现

0.48s - 0.95s
  模态框 panel 淡入、上浮、清晰化
  对话内容逐行淡入
```

### 6.2 关闭

建议总时长：`0.62s - 0.78s`

```text
0.00s - 0.28s
  模态框内容淡出
  panel 轻微下沉并模糊

0.00s - 0.20s
  内缘高光快速降低
  防止中心亮线出现

0.12s - 0.68s
  粉色侵袭区域退散
  中空结构恢复为普通流体

0.28s - 0.72s
  overlay 背景淡出
```

注意：关闭不是打开的简单倒放。关闭必须使用“先去掉裂隙式高光，再回落形态”的路径。

## 7. 文件级实施计划

### 7.1 `ExpandedResponseOverlay.tsx`

需要修改：

- 移除 `ResponseRevealBeam` import。
- 移除 JSX 中的 `<ResponseRevealBeam />`。
- 保留 `progressRef`，继续驱动 agent 展开进度。
- 保留 `isClosing`，用于通知 blob 进入关闭路径。
- 不新增测试文字。

### 7.2 `ResponseRevealBeam.tsx`

需要处理：

- 不再被历史聊天流程引用。
- 确认无引用后可以删除。
- 如果暂时保留文件，必须保证它不会被渲染。

### 7.3 `responseRevealBeamShader.ts`

需要处理：

- 同 `ResponseRevealBeam.tsx`。
- 历史聊天流程不再使用该 shader。

### 7.4 `blobShader.ts`

需要修改：

- 加入墨水侵袭 mask。
- 颜色混合从全局 expanded 改为中心向外扩散的 `inkMask`。
- 中空形成继续保留，但由 `hollowProgress` 控制。
- 给内缘高光增加半径保护，避免中心小半径阶段出现竖线。
- 关闭阶段先降低 `innerRimEnergy`，再让中空回落。
- 不关闭 bloom 增益。

### 7.5 `VoidBlob.tsx`

需要修改：

- 继续传入 `expandedResponseProgress`。
- 继续传入 `isExpandedResponseClosing`。
- 如新增 uniform，在 `useFrame` 中更新。
- 不在 `useFrame` 中调用 React `setState`。

### 7.6 `BlobScene.tsx`

需要修改：

- 保留 `expandedBloomLift = expandedResponseProgress * 1.15`。
- 不因为关闭阶段直接关掉 bloom 增益。
- 如果仍出现亮线，应回到 shader 消除亮线来源，而不是关闭 bloom。

## 8. 验收标准

### 8.1 打开历史聊天

- 不出现任何竖向裂隙、竖向光柱、竖向切口。
- agent 从中心开始被粉色不规则侵袭。
- 粉色侵袭像墨水向外蔓延，不是机械圆形扩散。
- 中心逐渐形成中空。
- 最终稳定形态仍然是当前满意的粉色中空高激活形态。
- 模态框出现过程丝滑，不突兀。

### 8.2 关闭历史聊天

- 不出现任何竖向裂隙、竖向光柱、竖向粉色线。
- 中空形态平滑恢复为正常流体。
- bloom 增益不被粗暴关闭。
- 关闭过程不能闪烁、不能硬切。

### 8.3 不允许的结果

- 用 CSS 遮罩把裂隙盖住。
- 关闭 bloom 增益来掩盖问题。
- 删除或削弱粉色中空形态本身。
- 打开时仍然出现 beam / 裂隙。
- 关闭时中间出现细长亮线。
- 添加任何测试用前端文案。

## 9. 当前优先级

本轮只处理历史聊天展开动效：

1. 删除独立裂隙光束渲染。
2. 保留粉色中空形态。
3. 增加墨水侵袭式颜色扩散。
4. 修复关闭时中心竖线。
5. 构建验证。

暂不处理：

- 模型接入配置。
- 记忆系统。
- 健康档案。
- STT / TTS。
- 新增测试代码。
- 新增无关页面或功能。
