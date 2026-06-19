// VOID 0/1 面部存在场（基于真实人脸灰度亮度场）
//
// 核心理念：
//   屏幕上只有 0 和 1。每个字符的“墨水值(ink, 0..1)”即它的绘制透明度。
//   墨水来自一张真实人脸灰度图的明暗——照片本身永远不显示，只作为亮度采样源。
//   亮处（皮肤、鼻梁、额头）墨水高、字符亮；暗处（眼窝、头发、背景）墨水低、
//   逐渐没入 void 黑暗。这样脸完全由数字的明暗起伏“浮现”，而非几何拼贴。
//
//   面部边界用一个椭圆软衰减场抹掉照片的方形边缘，并叠加极弱的 0/1 雾场，
//   让脸从连续的黑暗存在场中显现，而不是一张贴图。
//
//   眼睛、嘴巴是动态区域，逐帧根据 FaceState 在采样时做局部调制：
//   眨眼=眼区亮度抬向眼睑肤色并压一条折痕；视线=眼区采样做微小位移让虹膜移动；
//   张嘴=嘴心亮度降低形成开口、唇缘略亮。全部通过数字透明度变化实现。

/**
 * 采样源（灰度照片）的归一化关键点，坐标为 0..1 的图像比例。
 * 经 .facegen/calibrate.mjs + zoom.mjs 在真实灰度脸上逐一标定，
 * 半径取“五官实际开口”大小（眼=眼裂、嘴=唇裂），而非外扩范围。
 * nose/cheek/brow/chin 为预留关键点，供后续表情动作使用（当前仅 eye/mouth 参与动态）。
 */
const LM = {
  // —— 眼（虹膜中心 + 眼裂半径）——
  eyeL: { x: 0.395, y: 0.467 },
  eyeR: { x: 0.605, y: 0.46 },
  eyeRX: 0.052,
  eyeRY: 0.024,
  // —— 嘴（唇裂中心 + 唇裂半径）——
  mouth: { x: 0.485, y: 0.695 },
  mouthRX: 0.095,
  mouthRY: 0.035,
  // —— 预留五官关键点（后续做鼻翼/笑肌/挑眉等动作时直接取用）——
  noseTip: { x: 0.49, y: 0.595 },
  noseBridge: { x: 0.5, y: 0.47 },
  cheekL: { x: 0.36, y: 0.59 },
  cheekR: { x: 0.645, y: 0.58 },
  browL: { x: 0.395, y: 0.41 },
  browR: { x: 0.605, y: 0.405 },
  chin: { x: 0.49, y: 0.83 },
  // 只取“面部”本体（额头—两颊—下巴），不含头发/耳朵/脖子/领口/肩膀
  faceCenter: { x: 0.5, y: 0.6 },
  faceRX: 0.215,
  faceRY: 0.3,
  // 面部垂直范围（发际线到下巴），用于决定缩放
  headTop: 0.31,
  headBottom: 0.88
};

/** 双眼中点，作为脸在屏幕上的锚点。 */
const ANCHOR = { x: (LM.eyeL.x + LM.eyeR.x) / 2, y: (LM.eyeL.y + LM.eyeR.y) / 2 };

/** 由 GSAP idle 动效驱动、被逐帧渲染消费的面部状态。 */
export type FaceState = {
  /** 眨眼：0 睁开，1 闭合 */
  blink: number;
  /** 视线水平：-1 看左，1 看右 */
  gazeX: number;
  /** 视线垂直：-1 看上，1 看下 */
  gazeY: number;
  /** 嘴部张开：0 闭合，1 张开 */
  mouthOpen: number;
  /** Head yaw driven by luma and sampling changes, not by rotating the canvas. */
  headTurn: number;
  /** Head pitch driven by luma and sampling changes. */
  headNod: number;
};

export function createDefaultFaceState(): FaceState {
  return { blink: 0, gazeX: 0, gazeY: 0, mouthOpen: 0, headTurn: 0, headNod: 0 };
}

/** 预解码的灰度亮度源，提供双线性采样。 */
export type LumaSource = {
  size: number;
  data: Float32Array;
};

/** 双线性采样灰度源，越界返回 0（即 void）。 */
export function sampleLuma(src: LumaSource, x: number, y: number): number {
  const n = src.size;
  if (x < 0 || y < 0 || x > n - 1 || y > n - 1) {
    return 0;
  }
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, n - 1);
  const y1 = Math.min(y0 + 1, n - 1);
  const fx = x - x0;
  const fy = y - y0;
  const d = src.data;
  const a = d[y0 * n + x0];
  const b = d[y0 * n + x1];
  const c = d[y1 * n + x0];
  const e = d[y1 * n + x1];
  const top = a + (b - a) * fx;
  const bot = c + (e - c) * fx;
  return top + (bot - top) * fy;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const smoothStep = (edgeStart: number, edgeEnd: number, value: number) => {
  const t = clamp((value - edgeStart) / (edgeEnd - edgeStart), 0, 1);
  return t * t * (3 - 2 * t);
};

const gauss2 = (dx: number, dy: number, sx: number, sy: number) =>
  Math.exp(-((dx / sx) * (dx / sx) + (dy / sy) * (dy / sy)));

const hash = (x: number, y: number) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/**
 * 把灰度亮度映射为墨水：暗部压向 0（没入 void），亮部接近全亮。
 * 提高黑阈、收窄动态范围并叠加 gamma，让中间调下沉、明暗层次拉开，
 * 使颧骨/鼻梁/额头的高光与眼窝/鼻翼/下颌的阴影更分明（增加光影立体感）。
 */
export const inkCurve = (luma: number) => {
  const t = clamp((luma - 0.2) / 0.66, 0, 1);
  // gamma > 1 压暗中间调，强化阴影；再过 S 曲线收束两端
  const shaped = Math.pow(t, 1.32);
  return shaped * shaped * (3 - 2 * shaped);
};

/**
 * 面部软衰减场：抹掉照片方形边界，让脸边缘自然没入黑暗。坐标为采样源像素。
 *
 * 不再是规则椭圆（那会像“卤蛋”被裁切）。改为：
 *   - 垂直不对称：额头/两颊方向更宽松（轮廓交给真实暗发际线决定），
 *     下颌方向收紧（避开脖子与白色领口）。
 *   - 下半脸横向随高度收窄成下巴锥形，贴合真实人脸下颌线。
 *   - 边缘阈值叠加细微噪声抖动 → 轮廓不规则、有机，融入连续黑暗场而非硬边。
 * 配合下游 `mask * inkCurve(luma)`，真实暗部（发、眼窝、下颌阴影）会进一步
 * 打断这条边界，最终轮廓由“几何 + 亮度”共同塑形，自然贴合面部。
 */
const faceMaskAt = (ix: number, iy: number, size: number) => {
  const cx = LM.faceCenter.x * size;
  const cy = LM.faceCenter.y * size;
  // 下半脸横向收窄：越往下巴方向，水平半径越小
  const below = clamp((iy - cy) / (LM.faceRY * size), 0, 1);
  const rx = LM.faceRX * size * (1 - 0.32 * smoothStep(0.15, 1.0, below));
  // 垂直半径不对称：上松下紧
  const ry = LM.faceRY * size * (iy < cy ? 1.05 : 0.86);
  const dx = (ix - cx) / rx;
  const dy = (iy - cy) / ry;
  const d = Math.sqrt(dx * dx + dy * dy);
  // 边缘阈值随位置轻微抖动，打散规则椭圆轮廓
  const jitter = (hash(ix * 0.12, iy * 0.12) - 0.5) * 0.16;
  // 大幅拉开内外阈值 → 边非常软、过渡很长，不形成清晰轮廓线
  return 1 - smoothStep(0.74 + jitter, 1.34 + jitter, d);
};

/** 屏幕到采样源像素坐标的映射参数。 */
export type Placement = {
  size: number;
  scale: number;
  cx: number;
  cy: number;
};

/** 预计算好的字符场。数组按 index = row * cols + col 排列。 */
export type FaceField = {
  cols: number;
  rows: number;
  cellSize: number;
  fontPx: number;
  placement: Placement;
  px: Float32Array;
  py: Float32Array;
  /** 该格对应的采样源像素坐标（静止、视线居中时） */
  ix: Float32Array;
  iy: Float32Array;
  digit: Uint8Array;
  mask: Float32Array;
  fog: Float32Array;
  grain: Float32Array;
  /** 静态烘焙用的墨水（眼/嘴动态格为 0，留给逐帧层） */
  baseInk: Float32Array;
  /** 动态格 index 列表 */
  dynamic: number[];
  /** 动态格类型：1 左眼，2 右眼，3 嘴 */
  dynamicKind: Int8Array;
};

/** 屏幕坐标 → 采样源像素坐标。 */
const toImage = (px: number, py: number, p: Placement) => {
  const ix = ANCHOR.x * p.size + (px - p.cx) / p.scale;
  const iy = ANCHOR.y * p.size + (py - p.cy) / p.scale;
  return { ix, iy };
};

/** 判断采样源坐标落在哪个动态区域。 */
const dynamicKindAt = (ix: number, iy: number, size: number): number => {
  const inSoftOval = (cx: number, cy: number, rx: number, ry: number) => {
    const dx = (ix - cx * size) / (rx * size);
    const dy = (iy - cy * size) / (ry * size);
    return dx * dx + dy * dy < 1;
  };
  if (inSoftOval(LM.mouth.x, LM.mouth.y, LM.mouthRX * 1.45, LM.mouthRY * 2.25)) {
    return 3;
  }
  if (inSoftOval(LM.eyeL.x, LM.eyeL.y, LM.eyeRX * 1.55, LM.eyeRY * 2.1)) {
    return 1;
  }
  if (inSoftOval(LM.eyeR.x, LM.eyeR.y, LM.eyeRX * 1.55, LM.eyeRY * 2.1)) {
    return 2;
  }
  return 0;
};

const applyHeadMotion = (
  src: LumaSource,
  ix: number,
  iy: number,
  state: FaceState
) => {
  const size = src.size;
  const fcx = LM.faceCenter.x * size;
  const fcy = LM.faceCenter.y * size;
  const localX = (ix - fcx) / (LM.faceRX * size);
  const localY = (iy - fcy) / (LM.faceRY * size);
  const turn = clamp(state.headTurn, -1, 1);
  const nod = clamp(state.headNod, -1, 1);

  const depth = clamp(1 - Math.abs(localX) * 0.48 - Math.abs(localY) * 0.22, 0, 1);
  const sampleX = ix - turn * depth * size * 0.018 + localX * Math.abs(turn) * size * 0.006;
  const sampleY = iy - nod * depth * size * 0.01;
  let luma = sampleLuma(src, sampleX, sampleY);

  const sideLight = 0.16 * turn * localX;
  const cheekCatch = gauss2(localX - turn * 0.42, localY + 0.03, 0.38, 0.55);
  const noseCatch = gauss2(localX - turn * 0.14, localY + 0.02, 0.16, 0.45);
  const shadowSide = gauss2(localX + turn * 0.54, localY, 0.42, 0.72);
  const verticalLight =
    nod * (0.08 * gauss2(localX, localY + 0.42, 0.8, 0.42) - 0.06 * gauss2(localX, localY - 0.42, 0.85, 0.42));

  luma += sideLight + Math.abs(turn) * (0.1 * cheekCatch + 0.09 * noseCatch - 0.13 * shadowSide);
  luma += verticalLight;
  return clamp(luma, 0, 1);
};

/**
 * 眼/嘴动态调制：返回该采样源坐标在当前 FaceState 下的灰度值。
 * 所有动作都只改变亮度 → 进而改变数字透明度。
 */
export const editLuma = (
  src: LumaSource,
  ix: number,
  iy: number,
  kind: number,
  s: FaceState
): number => {
  const size = src.size;
  const baseLuma = applyHeadMotion(src, ix, iy, s);

  if (kind === 1 || kind === 2) {
    const eye = kind === 1 ? LM.eyeL : LM.eyeR;
    const ecx = eye.x * size;
    const ecy = eye.y * size;
    const wEye = gauss2(ix - ecx, iy - ecy, LM.eyeRX * size, LM.eyeRY * size * 1.1);

    // 视线：仅眼区中心做微小位移，让虹膜/瞳孔随视线移动（眼睑几乎不动）
    const gx = s.gazeX * 7 * wEye;
    const gy = s.gazeY * 5 * wEye;
    let luma = applyHeadMotion(src, ix - gx, iy - gy, s);

    // 眨眼：眼区亮度抬向眼睑肤色（采样眼上方皮肤），并压一条折痕暗线
    if (s.blink > 0) {
      const lid = sampleLuma(src, ix, iy - LM.eyeRY * size * 1.1);
      luma = lerp(luma, lid, s.blink * wEye);
      const crease = gauss2(ix - ecx, iy - ecy, LM.eyeRX * size * 1.1, LM.eyeRY * size * 0.4);
      luma -= 0.16 * s.blink * crease;
    }
    return clamp(luma, 0, 1);
  }

  if (kind === 3) {
    const mcx = LM.mouth.x * size;
    const mcy = LM.mouth.y * size;
    const o = s.mouthOpen;
    let luma = baseLuma;
    // 嘴心凹陷：张开越大、开口越暗越高
    const openH = LM.mouthRY * size * (0.34 + 1.55 * o);
    const openW = LM.mouthRX * size * (0.48 + 0.28 * o);
    const open = gauss2(ix - mcx, iy - mcy, openW, openH);
    luma -= (0.16 + 0.72 * o) * open;
    // 上下唇缘略亮
    const lipOff = LM.mouthRY * size * (0.42 + 1.12 * o);
    const upper = gauss2(ix - mcx, iy - (mcy - lipOff), LM.mouthRX * size * 0.86, size * 0.01);
    const lower = gauss2(ix - mcx, iy - (mcy + lipOff), LM.mouthRX * size * 0.9, size * 0.012);
    luma += (0.08 + 0.2 * o) * upper + (0.09 + 0.24 * o) * lower;
    return clamp(luma, 0, 1);
  }

  return baseLuma;
};

/**
 * 构建整屏字符场。尺寸或亮度源变化时调用一次，逐帧渲染只读取结果。
 */
export const buildFaceField = (
  width: number,
  height: number,
  src: LumaSource
): FaceField => {
  const size = src.size;

  // 字符格尺寸：兼顾可读密度与性能（接近参考图的细密矩阵）
  const cellSize = clamp(Math.min(width, height) / 82, 8, 12);
  const fontPx = cellSize * 1.02;
  const cols = Math.ceil(width / cellSize) + 1;
  const rows = Math.ceil(height / cellSize) + 1;
  const total = cols * rows;

  const cx = width * 0.5;
  // 缩放：让面部占视口约 0.68 高，受宽度约束防止溢出；略小于以往，
  // 为“面部居中”后下巴与底部胶囊留出安全间距。
  const headSpanImg = (LM.headBottom - LM.headTop) * size;
  const screenSpan = clamp(Math.min(height * 0.68, width * 0.98), 340, 720);
  const scale = screenSpan / headSpanImg;
  // 让“面部椭圆几何中心”对准画面垂直中心。锚点是双眼中点（偏上），
  // 需补偿其与面部中心的差值；再加极小上偏，视觉更稳、避免下巴压胶囊。
  const cy =
    height * 0.5 - (LM.faceCenter.y - ANCHOR.y) * size * scale - height * 0.02;
  const placement: Placement = { size, scale, cx, cy };

  const px = new Float32Array(total);
  const py = new Float32Array(total);
  const ixArr = new Float32Array(total);
  const iyArr = new Float32Array(total);
  const digit = new Uint8Array(total);
  const mask = new Float32Array(total);
  const fog = new Float32Array(total);
  const grain = new Float32Array(total);
  const baseInk = new Float32Array(total);
  const dynamic: number[] = [];
  const dynamicKind = new Int8Array(total);

  const fcx = LM.faceCenter.x * size;
  const fcy = LM.faceCenter.y * size;

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const idx = row * cols + col;
      const cellX = col * cellSize + cellSize / 2;
      const cellY = row * cellSize + cellSize / 2;
      px[idx] = cellX;
      py[idx] = cellY;

      const { ix, iy } = toImage(cellX, cellY, placement);
      ixArr[idx] = ix;
      iyArr[idx] = iy;
      digit[idx] = hash(col, row) > 0.5 ? 1 : 0;

      // 颗粒下限放低：让部分字符更暗，皮肤呈现细密明暗起伏的颗粒质感，
      // 避免大片均匀全亮带来的“饱满平滑”塑料感。
      const g = 0.62 + hash(col * 1.7, row * 2.3) * 0.38;
      grain[idx] = g;

      const m = faceMaskAt(ix, iy, size);
      mask[idx] = m;

      // 雾场：以脸为中心向外衰减的极低透明度噪点，保证连续存在场
      const du = (ix - fcx) / (LM.faceRX * size);
      const dv = (iy - fcy) / (LM.faceRY * size);
      const dist = Math.sqrt(du * du + dv * dv);
      const fogRadial = smoothStep(3.4, 0.7, dist);
      const lowNoise = 0.55 + 0.45 * hash(col * 0.23 + 3.1, row * 0.19 + 7.3);
      fog[idx] = (0.01 + 0.05 * fogRadial * lowNoise) * g;

      const kind = m > 0.04 ? dynamicKindAt(ix, iy, size) : 0;
      dynamicKind[idx] = kind;

      if (kind !== 0) {
        dynamic.push(idx);
        baseInk[idx] = 0; // 交给逐帧动态层
      } else {
        const luma = sampleLuma(src, ix, iy);
        const faceInk = m * inkCurve(luma);
        baseInk[idx] = Math.max(faceInk, fog[idx]) * g;
      }
    }
  }

  return {
    cols,
    rows,
    cellSize,
    fontPx,
    placement,
    px,
    py,
    ix: ixArr,
    iy: iyArr,
    digit,
    mask,
    fog,
    grain,
    baseInk,
    dynamic,
    dynamicKind
  };
};
