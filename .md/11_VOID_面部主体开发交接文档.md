# VOID 0/1 面部主体 — 开发交接文档

> 本文档交接「0/1 面部存在体」主界面的当前实现、设计原理、调参方法与后续待办。
> 新会话接手时**先读本文档**，再读 `.md/01`、`.md/08`、`.md/10`、`.md/agents.md`。

---

## 一、当前状态总览

- 框架：React + Vite + TypeScript + GSAP + `@gsap/react`，已有骨架保留。
- 主界面：黑色全屏舞台 + 由 `0/1` 字符光影映射出的**面部存在体** + 底部极简胶囊。
- 渲染方式：**Canvas 2D**（不是 DOM span），细密字符矩阵。
- `npm run build` 通过。
- 暂未接入：LLM / STT / TTS / 记忆系统（按需求边界，本阶段不做）。

### 核心设计理念（务必理解，否则容易改坏）

1. 屏幕上**只有 `0` 和 `1`**。每个字符有一个「墨水值 `ink`(0..1)」，**直接作为它的绘制透明度**。
2. 没有面部的地方 `ink ≈ 0`，即处于 void（黑暗）。面部由数字明暗起伏「浮现」。
3. 面部明暗来自**一张隐藏的真实人脸灰度图**（`src/assets/void-face-luma.jpg`）：
   - 这张图**永远不显示**，只在内存里被采样，用来决定每个 `0/1` 的透明度。
   - 亮处（皮肤、鼻梁、额头）→ 墨水高 → 字符亮；暗处（眼窝、嘴缝）→ 墨水低 → 没入黑暗。
   - 这是「深度图/亮度场」思路，不是把图片贴到屏幕上。
4. 只取**面部本体**（发际线—两颊—下巴），头发/耳朵/脖子/领口/肩膀/背景全部用椭圆软衰减场排除、淡入 void。
5. 面部外围叠加**极弱的 `0/1` 雾场**，让脸从连续黑暗存在场里浮现，不是孤立贴图。
6. 眼睛、嘴巴是**动态区域**，逐帧根据 `FaceState` 在采样时做局部明暗调制 → 实现眨眼/视线/张嘴，全部通过数字透明度变化。
7. 动效只用 `transform`（呼吸、漂移），**绝不动全局透明度/亮度**来模拟呼吸。**不做整块画布 3D 旋转**（那会变成"照片在倾斜"）。

---

## 二、文件结构与职责

| 文件 | 职责 |
| --- | --- |
| `src/features/void-stage/VoidStage.tsx` | 全屏舞台，组合 `BinaryFace` + `VoiceCapsule` |
| `src/features/binary-face/BinaryFace.tsx` | 面部渲染入口：加载/解码灰度源、构建字符场、Canvas 逐帧渲染（静态烘焙 + 眼/嘴动态层） |
| `src/features/binary-face/binaryFaceField.ts` | **核心算法**：面部关键点、亮度采样、椭圆 mask、墨水曲线、雾场、眼/嘴动态调制 |
| `src/features/void-animation/useVoidFaceAnimation.ts` | GSAP 空闲动效：呼吸、漂移、眨眼、视线、嘴部微动（`useGSAP` + scope 自动清理） |
| `src/features/voice-capsule/VoiceCapsule.tsx` | 底部胶囊（极简，含 chevron） |
| `src/styles/base.css` | 全局样式：黑底、canvas、边缘晕影、胶囊、响应式、reduced-motion |
| `src/assets/void-face-luma.jpg` | **隐藏灰度人脸采样源**（384×384，约 27KB，绝不显示） |
| `src/vite-env.d.ts` | Vite 客户端类型声明（让 `.jpg` 等资源 import 有类型） |

### 渲染管线（BinaryFace.tsx 内）

1. `useEffect` 内加载 `void-face-luma.jpg` → `decodeLuma()` 解码为 `LumaSource`（`Float32Array` 灰度，0..1）。
2. `setup()`：按视口尺寸 `buildFaceField()` 构建字符场；把**静态部分**（除眼/嘴外的所有格）一次性烘焙到离屏 canvas（`renderStaticLayer`）。
3. `render()` 每帧：`drawImage` 贴静态层 → 仅遍历**动态格**（眼/嘴），用 `editLuma()` 按当前 `FaceState` 重采样并绘制。
4. 呼吸/漂移/浮现作用在 canvas 元素的 `transform`/`opacity`（GSAP）。
5. resize 去抖 160ms 重建字符场；卸载清理 RAF/监听/timer。

> 性能：静态层只在尺寸变化时重算一次；逐帧只重画几百个眼/嘴格 + 一次 `drawImage`，轻松 60fps。

---

## 三、如何调整面部（最常用）

所有面部几何参数集中在 `binaryFaceField.ts` 顶部的 `LM` 对象（坐标为采样源图像 0..1 比例）：

```ts
const LM = {
  eyeL:  { x: 0.405, y: 0.487 },  // 左眼中心（图像左 = 屏幕左）
  eyeR:  { x: 0.62,  y: 0.485 },  // 右眼中心
  eyeRX: 0.085, eyeRY: 0.05,      // 眼睛半径（影响眨眼/视线作用范围 + 动态框大小）
  mouth: { x: 0.505, y: 0.73 },   // 嘴中心
  mouthRX: 0.12, mouthRY: 0.052,  // 嘴半径
  faceCenter: { x: 0.515, y: 0.6 }, // 面部椭圆中心
  faceRX: 0.215, faceRY: 0.3,       // 面部椭圆半径 → 决定“露出多少脸”
  headTop: 0.31, headBottom: 0.88   // 面部垂直范围 → 参与屏幕缩放计算
};
```

### 常见调整场景

- **脸太大/太小**：改 `buildFaceField()` 里
  `const screenSpan = clamp(Math.min(height * 0.76, width * 1.04), 340, 760);`
  调小 `0.76 / 1.04` → 脸变小（给胶囊更多空间）；调大 → 脸更大。
- **露出范围（要不要更多/更少脸）**：改 `LM.faceRX / faceRY`。变大会带出更多头发/下巴边缘，变小更聚焦中央五官。
- **边缘虚实**：`faceMaskAt()` 里 `return 1 - smoothStep(0.7, 1.16, d);`
  两个阈值越靠近 → 边越硬；越分开 → 边越虚（越融入黑暗）。
- **整体亮/暗、对比**：`inkCurve()`：`const t = clamp((luma - 0.14) / 0.74, 0, 1);`
  `0.14` 是黑阈（调高 → 更多暗部沉入 void）；`0.74` 是动态范围（调小 → 对比更强、更亮）。
- **面部在画面中的高低**：`buildFaceField()` 里 `const cy = height * 0.45;`（锚点=双眼中点）。调大 → 脸下移。
- **高光发光强度/泛白**：`BinaryFace.tsx` 的 `drawGlyph()`，`ink > 0.62` 分支控制偏白与 `shadowBlur`（光晕）。阈值调高 → 更少格发光，整体更克制。
- **字符密度**：`buildFaceField()` 里 `const cellSize = clamp(Math.min(width, height) / 82, 8, 12);`
  分母调大 → 字符更密更细。

### 眼/嘴动作原理（`editLuma()`）

- **眨眼** `blink`：眼区亮度抬向「眼睑肤色」（采样眼上方皮肤）+ 压一条折痕暗线。
- **视线** `gazeX/gazeY`：仅眼区中心做几像素采样位移，让虹膜/瞳孔移动，眼睑几乎不动。
- **张嘴** `mouthOpen`：嘴心高斯变暗形成开口 + 上下唇缘略亮。
- 这些都只改「采样得到的灰度」→ 再过 `inkCurve` → 改变数字透明度。**不要**用画图形的方式画五官。

---

## 四、如何调整动效（`useVoidFaceAnimation.ts`）

- 全部用 `useGSAP({ scope })`，操作 `canvasRef`（transform/opacity）或 `stateRef.current`（`FaceState`）。卸载自动清理，勿手写 cleanup。
- **呼吸**：`gsap.to(canvas, { y:-5, scale:1.007, duration:4.6, yoyo, repeat:-1 })`。幅度别大，别碰 alpha/filter。
- **存在感漂移**：极小 `x` 位移（±7px）低频长停顿。**禁止再加 `rotationX/rotationY`**（会变成"照片倾斜"）。
- **眨眼**：快合 0.08s → 稍慢张开 0.13s 非对称曲线，约 30% 概率双眨，间隔随机 2.6–6.5s。
- **视线**：扫视(saccade)——0.16s 快速跳到新落点 → 长凝视 → 偶尔规避 → 回到对视(`gaze=0`)。改 `random(...)` 范围控制幅度/节奏。
- **嘴部**：空闲基本闭合，偶尔 `mouthOpen` 到 0.05~0.11 的极轻微开合。
- `prefers-reduced-motion` 已处理：只淡入、状态归零、不循环。

---

## 五、隐藏灰度采样源的资源管线

> 采样源是「真实人脸灰度图」（当前用 AI 合成人脸，非真人，无肖像权问题）。
> **屏幕上永不显示这张图**，只用它的明暗驱动 `0/1` 透明度。

- 一次性预处理目录：`.facegen/`（已加入 `.gitignore`，不进仓库）。
  - `.facegen/cand1.jpg`：原始人脸（1024）。
  - `.facegen/process.mjs`：用 `jimp` 转灰度 + 归一化 + 提对比 + 压到 384 + 导出 `src/assets/void-face-luma.jpg`。
  - `.facegen/preview.mjs`：复刻渲染管线，把**逐格墨水(透明度)**导出成灰度预览图（桌面/移动），用于在不开浏览器时验证结构/缩放/landmark。
- `jimp` 在 `devDependencies`，仅供素材预处理。

### 换脸 / 重新生成采样源的步骤

```bash
# 1. 重新抓一张正面、中性、平视的脸（可多抓几张挑）
curl -sL -o .facegen/cand1.jpg "https://thispersondoesnotexist.com"
# 2. 生成灰度采样源（如需调对比，改 process.mjs 里的 contrast/normalize）
node .facegen/process.mjs
# 3. 用预览图核对 landmark（眼/嘴/脸中心是否对齐），不对就改 binaryFaceField.ts 的 LM
node .facegen/preview.mjs
#    读取 .facegen/preview_desktop.png / preview_mobile.png 检查
# 4. 改完务必构建
npm run build
```

> ⚠️ 换脸后**几乎一定要重新标定 `LM` 关键点**（眼/嘴/脸中心位置随脸不同而变）。
> 标定方法：肉眼看 `void-face-luma.jpg` 上眼/嘴/脸的 0..1 比例位置，填进 `LM`，再用 `preview.mjs` 验证。
> `preview.mjs` 里的 `LM`/mask 常量需与 `binaryFaceField.ts` **手动保持一致**（两处独立，改一处要同步另一处）。

---

## 六、验收标准（已满足）

1. 第一眼只有黑色空间 + `0/1` 面部存在体 + 底部胶囊。✅
2. 面部不是图片、无图片硬边界（椭圆软衰减 + 雾场）。✅
3. `0/1` 从面部向周围自然衰减、连续场。✅
4. 能看出真实人脸结构：额头、眉、眼窝、鼻梁、嘴、下巴、两颊。✅
5. 嘴/眼动作由数字透明度变化形成。✅
6. 桌面/移动端无重叠、胶囊无溢出。✅（已用桌面 1000×900、移动 430×900 预览验证）
7. `npm run build` 通过。✅

---

## 七、后续待办（建议优先级）

1. **浏览器实机走查**：`npm run dev` 确认动效自然度（呼吸/眨眼/视线/漂移）与字符发光观感，按需微调 §三/§四 参数。
2. **「说话」状态**：接 TTS 后，用音频包络驱动 `FaceState.mouthOpen`（现成接口，改驱动源即可），让嘴随语音开合。
3. **「聆听/思考」状态**：用视线游离 + 眨眼频率 + 极轻微亮度起伏表达 idle/listening/thinking 不同气质（仍走 `FaceState`）。
4. **STT 输入**：底部胶囊接入语音输入交互（当前胶囊仅静态样式）。
5. **LLM 接入**：对话逻辑，驱动上面的状态机。
6. **记忆系统**：按 `.md/01` 边界推进。
7. **性能/兼容**：低端机降级（更大 `cellSize`、关 `shadowBlur`）；`dpr` 已限制在 1~2。

> 接入对话/语音时，**面部表现层不用重写**：所有表情都收敛到 `FaceState`（`blink/gazeX/gazeY/mouthOpen`）这一个对象，只需新增「驱动 `FaceState` 的状态机」。如需更多表情维度（如眉动、嘴角），在 `FaceState` 加字段并在 `editLuma()` 里加对应调制即可。

---

## 八、已知约束与注意事项

- 采样源是 2D 照片，**无法真正 3D 转头**；"扭头"只能靠眼神 + 极小漂移表达，不要用整块旋转伪造。
- `preview.mjs` 与 `binaryFaceField.ts` 的常量是两套独立副本，调参时要同步。
- 不要用图片/SVG/DOM 画五官；不要把采样源图直接显示出来；不要用全局 alpha/filter 模拟呼吸。
- 组件库限制：仅 Ali Imam Registry（本阶段未使用）。禁用 Shadcn/MUI/Ant Design。
- 不写测试代码；不加调试面板/测试文字。
