# VOID Blob 主体开发交接文档

> 本文档交接「Blob 主视觉主体」的实现目标、技术约束、调参方向与后续待办。  
> 新会话接手前端主体开发时，先读本文档，再读 `.md/08_VOID_前端交互与动效设计文档.md`、`.md/09_VOID_MVP阶段任务拆分.md`、`.md/10_VOID_给Codex或Claude的开发提示词模板.md`。

---

## 一、当前目标总览

- 框架主线：React + Vite + TypeScript。
- 动效主线：GSAP 负责 UI 与状态切换；R3F render loop 负责 3D 主体参数更新。
- 主界面：黑色全屏舞台 + 中央单色发光有机 Blob + 底部极简胶囊。
- 主体不再使用 `0/1` 字符脸方案。
- 主体改为 `React Three Fiber + GLSL Shader + Bloom` 路线。

### 核心设计理念

1. 页面第一视觉必须是“黑暗中的一个活体存在”，不是一张脸的图形符号。
2. 这个主体不依赖五官识别，而依赖呼吸、体积变化、边缘发光、能量响应来建立存在感。
3. 页面空间必须保持空，不能给主体周围堆太多辅助元素。
4. 主体是产品本体感知层，不要把模型接入、语音逻辑、胶囊波形实现混进 Shader 模块。

---

## 二、主体实现规格

### 几何体

- 使用 `IcosahedronGeometry`。
- `detail: 100`。
- 使用 `ShaderMaterial`。

### 顶点 Shader

- 引入 `simplex noise` 的 `snoise 3D`。
- 叠加两层 FBM。
- 第一层大尺度慢变形，频率 `0.8`。
- 第二层小尺度表面细节，频率 `2.5`。
- `uAmplitude = 0.28`。
- `uTime` 用于持续驱动变形。
- 变形节奏必须偏慢，优先体现“呼吸”和“生命体起伏”，不是高频躁动。

### 片元 Shader

- 主色：深蓝 `#0A0AFF`。
- 边缘 Fresnel 光：亮青蓝 `#00CFFF`。
- Fresnel power：`2.5`。
- 中心略暗、边缘更亮，形成轻微次表面散射感。
- 不做 Iridescent。
- 不做多色混合。

### 后处理

- 开启 Bloom。
- `intensity: 2.5`
- `luminanceThreshold: 0.1`
- 不加 `ChromaticAberration`

### 环境

- 背景必须纯黑。
- Blob 下方只允许极轻微接地感阴影或点光影响。
- 不加粒子、星空、地板网格、镜面反射地等无关视觉。

---

## 三、建议文件结构与职责

以下是建议的新结构，后续前端开发按这个拆分，不要回到旧的 `binary-face` 路线：

| 文件 | 职责 |
| --- | --- |
| `src/features/void-stage/VoidStage.tsx` | 全屏舞台，组合 `BlobScene` 和 `VoiceCapsule` |
| `src/features/blob-scene/BlobScene.tsx` | R3F Canvas、相机、灯光、后处理容器 |
| `src/features/blob-scene/VoidBlob.tsx` | Blob 几何体、ShaderMaterial、状态参数映射 |
| `src/features/blob-scene/blobShader.ts` | 顶点/片元 Shader 与 uniforms 定义 |
| `src/features/blob-scene/useBlobStateAnimation.ts` | 将 Agent 状态映射为 Blob 参数过渡逻辑 |
| `src/features/voice-capsule/VoiceCapsule.tsx` | 底部胶囊与声波容器 |
| `src/features/voice-capsule/useCapsuleAnimation.ts` | 胶囊的 GSAP 切态动画 |
| `src/styles/base.css` | 黑底、布局、安全区、基础响应式 |

如果仓库里已有旧的 `binary-face` 相关目录，后续是否删除是代码阶段再决定；当前交接文档先明确新方案，不在文档阶段处理删除动作。

---

## 四、状态映射规则

### `idle`

- 常规呼吸。
- `scale` 在 `0.97` 到 `1.03` 之间缓慢循环。
- 周期 `3s`。
- easing：`sine.inOut`。
- Bloom 维持 `2.5`。
- 颜色保持深蓝主色。

### `listening`

- Bloom 增强到 `3.0`。
- 边缘光更亮。
- 形变速度轻微加快。
- 仍然必须克制，不能做成报警灯。

### `thinking`

- 整体缩小到约 `0.92`。
- 颜色偏向 `#2200FF` 深紫蓝。
- 呼吸收窄，像向内聚焦。

### `speaking`

- Bloom intensity 由 TTS 音量实时驱动。
- 变化范围 `2.5` 到 `4.0`。
- 边缘光随音量轻微闪烁。
- 响应必须基于真实音量数据，不要伪随机跳变。

---

## 五、最常用调参点

### 1. 形体起伏过强或过弱

优先调整：

- `uAmplitude`
- 第一层 FBM 频率
- 第二层 FBM 频率
- 时间流速系数

原则：

- 如果像爆炸或沸腾，说明频率或时间流速过高。
- 如果像静态石头，说明振幅或时间变化过低。

### 2. 发光不够或过曝

优先调整：

- Bloom `intensity`
- Bloom `luminanceThreshold`
- Fresnel 强度
- Shader 内部边缘增亮因子

原则：

- 如果主体边界发灰发脏，通常是边缘光不够干净。
- 如果整团糊成一片，通常是 Bloom 或高亮区过量。

### 3. 颜色太花或太死

优先调整：

- 基色与边缘色之间的插值比例
- 中心变暗强度
- 边缘增亮强度

原则：

- 必须始终保持单色系。
- 允许明暗层次，不允许演变成彩色渐变球。

### 4. 状态差异不明显

优先调整：

- `idle / listening / thinking / speaking` 的 Bloom 差值
- `thinking` 的 scale 收缩幅度
- `speaking` 的音量驱动敏感度
- `listening` 的边缘光抬升幅度

原则：

- 状态要一眼可分，但不能割裂成四套完全不同的东西。
- 统一感比“炫”更重要。

---

## 六、动画与工程边界

### GSAP 的职责

GSAP 负责：

- 胶囊展开、收起、变形。
- 页面入场动画。
- 非 3D UI 层的透明度、位移、尺寸过渡。
- 状态切换时的节奏编排。

### R3F / Shader 的职责

R3F / Shader 负责：

- Blob 本体变形。
- 颜色与边缘光。
- 体积呼吸。
- 与状态相关的 uniform 更新。

### 不要这样做

- 不要让 GSAP 每帧强行重写所有 shader uniform。
- 不要把胶囊逻辑写进 `VoidBlob`。
- 不要把 Agent 业务状态机硬编码在 shader 文件里。
- 不要把黑底舞台做成复杂 3D 场景。

---

## 七、验收标准

1. 第一眼只有黑色空间、中央发光 Blob、底部胶囊。  
2. 主体具备明显生命感，但不过度躁动。  
3. `idle / listening / thinking / speaking` 四状态在视觉上可区分。  
4. `speaking` 状态可以和真实 TTS 音量联动。  
5. 整个页面保持极简，没有多余 UI 抢主视觉。  
6. 桌面端和移动端都不出现主体裁切异常、胶囊重叠、过曝失控。  

---

## 八、后续待办建议顺序

1. 先完成 Blob 静态外观和黑暗舞台。
2. 再完成四状态的参数映射。
3. 再完成底部胶囊与状态联动。
4. 再把 `speaking` 接 TTS 音量驱动。
5. 最后才接完整 Agent 状态机、语音链路和模型响应。

---

## 九、已知约束

- 当前产品方向已经从“0/1 面部主体”切换到“Blob 主体”，后续前端实现不得继续以旧方案为主线。
- 组件库限制仍然有效：通用 UI 优先来自 Ali Imam Registry。
- 动效主线仍然有效：GSAP 负责 UI，R3F / Shader 负责 3D 主体。
- 当前阶段仍然不写测试代码，不增加测试文案，不做与上线无关的展示性功能。
