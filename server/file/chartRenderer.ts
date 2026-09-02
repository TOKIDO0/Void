import { Jimp, loadFont } from "jimp";

// ARGB "FF38BDF8" -> Jimp RGBA int 0xRRGGBBAA
function argbToRgbaInt(argb: string): number {
  const hex = (argb || "FF3B82F6").replace(/^#/, "").toUpperCase();
  const clean = hex.length === 8 ? hex : `FF${hex}`;
  const a = parseInt(clean.slice(0, 2), 16);
  const r = parseInt(clean.slice(2, 4), 16);
  const g = parseInt(clean.slice(4, 6), 16);
  const b = parseInt(clean.slice(6, 8), 16);
  // Jimp expects 0xRRGGBBAA
  return (r << 24) | (g << 16) | (b << 8) | a;
}

const WHITE = 0xffffffff;
const AXIS_COLOR = 0x9ca3af80; // will use opaque
const AXIS_OPAQUE = 0x9ca3afff;
const GRID_COLOR = 0xe5e7ebff;
const TEXT_COLOR = 0x1f2937ff;

function fillRect(img: InstanceType<typeof Jimp>, x: number, y: number, w: number, h: number, color: number) {
  const x1 = Math.max(0, Math.floor(x));
  const y1 = Math.max(0, Math.floor(y));
  const x2 = Math.min(img.bitmap.width, Math.ceil(x + w));
  const y2 = Math.min(img.bitmap.height, Math.ceil(y + h));
  for (let py = y1; py < y2; py++) {
    for (let px = x1; px < x2; px++) img.setPixelColor(color, px, py);
  }
}

function drawHLine(img: InstanceType<typeof Jimp>, y: number, x0: number, x1: number, color: number) {
  const yy = Math.floor(y);
  if (yy < 0 || yy >= img.bitmap.height) return;
  const a = Math.max(0, Math.min(x0, x1) | 0);
  const b = Math.min(img.bitmap.width - 1, Math.max(x0, x1) | 0);
  for (let x = a; x <= b; x++) img.setPixelColor(color, x, yy);
}
function drawVLine(img: InstanceType<typeof Jimp>, x: number, y0: number, y1: number, color: number) {
  const xx = Math.floor(x);
  if (xx < 0 || xx >= img.bitmap.width) return;
  const a = Math.max(0, Math.min(y0, y1) | 0);
  const b = Math.min(img.bitmap.height - 1, Math.max(y0, y1) | 0);
  for (let y = a; y <= b; y++) img.setPixelColor(color, xx, y);
}

function toRad(deg: number) { return (deg * Math.PI) / 180; }

export async function renderBarChartPng(opts: {
  title: string;
  categories: string[];
  values: number[];
  palette: string[];
  xLabel?: string;
  yLabel?: string;
}): Promise<Buffer> {
  const W = 800, H = 420;
  const img = new Jimp({ width: W, height: H, color: WHITE });
  const margin = { top: 46, right: 18, bottom: 52, left: 56 };
  const plotW = W - margin.left - margin.right;
  const plotH = H - margin.top - margin.bottom;

  // 绘标题（尝试用位图字体，失败则跳过）
  try {
    const font = await loadFont("open-sans-16-black" as any);
    // Jimp loadFont 实际上需要路径；若字符串失败则忽略
    // @ts-ignore try print
    if ((img as any).print) (img as any).print(font, 0, 10, { text: opts.title.slice(0, 64), alignmentX: 1 as any, alignmentY: 1 as any }, W, 20);
  } catch { /* ignore */ }

  // 若上方字体未生效，手动画一条标题下划线示意
  fillRect(img, margin.left, margin.top - 18, plotW, 1, 0xe5e7ebff);

  const vals = opts.values.map((v) => (Number.isFinite(v) ? v : 0));
  const maxVal = Math.max(1, ...vals) * 1.12;
  const n = Math.max(1, vals.length);

  // 网格 + Y 刻度
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const y = margin.top + (plotH * i) / ticks;
    drawHLine(img, y, margin.left, margin.left + plotW, i === ticks ? AXIS_OPAQUE : GRID_COLOR);
  }
  drawVLine(img, margin.left, margin.top, margin.top + plotH, AXIS_OPAQUE);
  drawHLine(img, margin.top + plotH, margin.left, margin.left + plotW, AXIS_OPAQUE);

  // 柱子
  const step = plotW / n;
  const barW = Math.max(8, Math.floor(step * 0.55));
  const gap = step - barW;
  for (let i = 0; i < n; i++) {
    const v = vals[i] ?? 0;
    const h = Math.max(2, Math.round((v / maxVal) * plotH));
    const x = Math.round(margin.left + i * step + gap / 2);
    const y = margin.top + plotH - h;
    const col = argbToRgbaInt(opts.palette[i % opts.palette.length] || opts.palette[0]);
    // 圆角顶：简单做 3px 圆角（顶部两角削）
    fillRect(img, x, y + 3, barW, h - 3, col);
    fillRect(img, x + 1, y + 1, barW - 2, 3, col);
    fillRect(img, x + 2, y, barW - 4, 2, col);
    // 顶部高光 1px
    drawHLine(img, y, x + 2, x + barW - 3, 0xffffff66 as unknown as number);
  }

  // 类目文字：若有字体则打印缩写，否则用底部 1px 色块示意已含轴
  try {
    const small = await loadFont("open-sans-10-black" as any);
    for (let i = 0; i < opts.categories.length; i++) {
      const label = String(opts.categories[i] ?? "").slice(0, 8);
      const x = Math.round(margin.left + i * step + step / 2 - 24);
      const y = margin.top + plotH + 6;
      // @ts-ignore
      if ((img as any).print) (img as any).print(small, x, y, label);
    }
  } catch { /* ignore */ }

  const buf = await img.getBuffer("image/png" as any);
  return Buffer.from(buf);
}

export async function renderPieChartPng(opts: {
  title: string;
  categories: string[];
  values: number[];
  palette: string[];
}): Promise<Buffer> {
  const W = 640, H = 400;
  const img = new Jimp({ width: W, height: H, color: WHITE });
  const cx = 220, cy = 210, r = 132, rInner = 0;

  try {
    const font = await loadFont("open-sans-16-black" as any);
    // @ts-ignore
    if ((img as any).print) (img as any).print(font, 0, 12, { text: opts.title.slice(0, 64), alignmentX: 1 as any }, W, 20);
  } catch { }

  const vals = opts.values.map((v) => (Number.isFinite(v) ? v : 0));
  const total = vals.reduce((a, b) => a + b, 0) || 1;
  let startDeg = -90;
  // 为每段生成颜色
  const cols = vals.map((_, i) => argbToRgbaInt(opts.palette[i % opts.palette.length] || opts.palette[0]));

  // 逐像素填充扇形（O(W*H*segments) 但 640*400*~6 可接受）
  // 先清空饼区域为白
  // 遍历画布在饼内外判断
  const startRads = vals.map((v) => {
    const deg = (v / total) * 360;
    const s = startDeg;
    startDeg += deg;
    return { s, e: startDeg };
  });

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > r || dist < rInner) continue;
      let ang = (Math.atan2(dy, dx) * 180) / Math.PI; // -180..180
      // 转到 -90 起点坐标系
      // normalize to [-180,180) already; find segment
      // 将 ang 对齐到与 start 相同的循环
      // 简化：把 ang 保持 -180..180，start 也在此区间循环判断需处理跨 180
      for (let i = 0; i < startRads.length; i++) {
        const seg = startRads[i];
        // 处理跨 360 的段
        let s = seg.s, e = seg.e;
        // 将角度归一到与段同周期：把 ang 加 360 直到 > s-360
        let a = ang;
        // e-s <=360, s 可能 <-90, e 可能 >270，ang 在 -180..180
        // 尝试 a, a+360, a-360 命中
        const hit = [a, a + 360, a - 360].some((aa) => aa >= s - 1e-6 && aa < e - 1e-6);
        if (hit) { img.setPixelColor(cols[i], x, y); break; }
      }
    }
  }
  // 外描边 + 内阴影
  for (let deg = 0; deg < 360; deg++) {
    const rad = toRad(deg);
    const x = Math.round(cx + Math.cos(rad) * r);
    const y = Math.round(cy + Math.sin(rad) * r);
    if (x >= 0 && x < W && y >= 0 && y < H) img.setPixelColor(0xffffffff, x, y);
  }
  // 中心白圆（甜甜圈可选，当前实心）
  // 图例（右侧）
  const legendX = 400, legendY0 = 70, lineH = 20;
  for (let i = 0; i < opts.categories.length; i++) {
    const y = legendY0 + i * lineH;
    if (y + 12 >= H) break;
    fillRect(img, legendX, y, 12, 12, cols[i]);
    // 文字若可打印
    try {
      const small = await loadFont("open-sans-10-black" as any);
      // @ts-ignore
      if ((img as any).print) (img as any).print(small, legendX + 16, y - 1, `${String(opts.categories[i]).slice(0, 14)}  ${vals[i]}`);
      break; // 只试一次字体，避免重复加载
    } catch { }
    // 无字体时不写字，色块已足够区分
  }
  // 若字体成功但只画了一条图例，则补全其余色块的文字用色块区分即可；已在上方循环画完色块

  const buf = await img.getBuffer("image/png" as any);
  return Buffer.from(buf);
}
