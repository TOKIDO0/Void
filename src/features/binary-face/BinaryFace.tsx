import { useEffect, useRef } from "react";
import faceLumaUrl from "../../assets/void-face-luma.jpg";
import { useVoidFaceAnimation } from "../void-animation/useVoidFaceAnimation";
import {
  buildFaceField,
  createDefaultFaceState,
  editLuma,
  inkCurve,
  type FaceField,
  type FaceState,
  type LumaSource
} from "./binaryFaceField";

const INK_THRESHOLD = 0.012;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

/** 配置 2D 上下文用于绘制 0/1 字符。 */
function configureContext(ctx: CanvasRenderingContext2D, field: FaceField, dpr: number) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = `${field.fontPx}px "SFMono-Regular", "Cascadia Mono", "Consolas", monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
}

/** 绘制单个字符：墨水值即透明度；高墨水偏白并带极柔光晕。 */
function drawGlyph(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  digit: number,
  ink: number
) {
  ctx.globalAlpha = Math.min(ink, 1);
  if (ink > 0.62) {
    const t = clamp((ink - 0.62) / 0.38, 0, 1);
    const r = Math.round(206 + 38 * t);
    const g = Math.round(214 + 33 * t);
    const b = Math.round(210 + 34 * t);
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.shadowColor = "rgba(202, 224, 220, 0.5)";
    ctx.shadowBlur = 5;
  } else {
    ctx.fillStyle = "rgb(200, 208, 205)";
    ctx.shadowBlur = 0;
  }
  ctx.fillText(digit === 1 ? "1" : "0", x, y);
}

/** 把静态字符（除眼/嘴外的全部存在场）一次性烘焙到离屏画布。 */
function renderStaticLayer(field: FaceField, dpr: number): HTMLCanvasElement {
  const layer = document.createElement("canvas");
  const width = field.cols * field.cellSize;
  const height = field.rows * field.cellSize;
  layer.width = Math.ceil(width * dpr);
  layer.height = Math.ceil(height * dpr);
  const ctx = layer.getContext("2d");
  if (!ctx) {
    return layer;
  }
  configureContext(ctx, field, dpr);

  const { baseInk, digit, px, py } = field;
  for (let i = 0; i < baseInk.length; i += 1) {
    const ink = baseInk[i];
    if (ink < INK_THRESHOLD) {
      continue;
    }
    drawGlyph(ctx, px[i], py[i], digit[i], ink);
  }
  return layer;
}

/** 把已加载的灰度图解码为亮度采样源（取 R 通道归一化）。 */
function decodeLuma(image: HTMLImageElement): LumaSource | null {
  const size = Math.min(image.naturalWidth, image.naturalHeight);
  if (size <= 0) {
    return null;
  }
  const off = document.createElement("canvas");
  off.width = size;
  off.height = size;
  const ctx = off.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    return null;
  }
  ctx.drawImage(image, 0, 0, size, size);
  const { data: rgba } = ctx.getImageData(0, 0, size, size);
  const data = new Float32Array(size * size);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = rgba[i * 4] / 255;
  }
  return { size, data };
}

/**
 * BinaryFace：0/1 面部存在体的渲染入口。
 * 用真实人脸灰度图驱动每个 0/1 字符的透明度；静态部分烘焙为离屏图层逐帧 blit，
 * 仅眼/嘴动态区域逐帧重采样，配合 GSAP 驱动的 FaceState 实现眨眼、视线、张嘴；
 * 呼吸与头部微转作用在 canvas 元素的 transform 上。
 */
export function BinaryFace() {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<FaceState>(createDefaultFaceState());

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    let luma: LumaSource | null = null;
    let field: FaceField | null = null;
    let staticLayer: HTMLCanvasElement | null = null;
    let dpr = 1;
    let cssWidth = 0;
    let cssHeight = 0;
    let rafId = 0;
    let disposed = false;

    const setup = () => {
      if (!luma) {
        return;
      }
      const rect = wrap.getBoundingClientRect();
      cssWidth = Math.max(1, rect.width);
      cssHeight = Math.max(1, rect.height);
      dpr = clamp(window.devicePixelRatio || 1, 1, 2);

      canvas.width = Math.ceil(cssWidth * dpr);
      canvas.height = Math.ceil(cssHeight * dpr);
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;

      field = buildFaceField(cssWidth, cssHeight, luma);
      staticLayer = renderStaticLayer(field, dpr);
    };

    const render = () => {
      if (luma && field && staticLayer) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;
        ctx.clearRect(0, 0, cssWidth, cssHeight);
        ctx.drawImage(staticLayer, 0, 0, cssWidth, cssHeight);

        configureContext(ctx, field, dpr);
        const state = stateRef.current;
        const { dynamic, dynamicKind, ix, iy, mask, fog, grain, digit, px, py } = field;
        for (let k = 0; k < dynamic.length; k += 1) {
          const i = dynamic[k];
          const l = editLuma(luma, ix[i], iy[i], dynamicKind[i], state);
          const ink = Math.max(mask[i] * inkCurve(l), fog[i]) * grain[i];
          if (ink < INK_THRESHOLD) {
            continue;
          }
          drawGlyph(ctx, px[i], py[i], digit[i], ink);
        }
      }
      rafId = window.requestAnimationFrame(render);
    };

    const onReady = () => {
      if (disposed) {
        return;
      }
      luma = decodeLuma(image);
      setup();
    };

    const image = new Image();
    image.src = faceLumaUrl;
    if (typeof image.decode === "function") {
      image.decode().then(onReady).catch(() => undefined);
    } else {
      image.addEventListener("load", onReady, { once: true });
    }

    render();

    let resizeTimer = 0;
    const handleResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(setup, 160);
    };
    window.addEventListener("resize", handleResize);

    return () => {
      disposed = true;
      window.cancelAnimationFrame(rafId);
      window.clearTimeout(resizeTimer);
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  useVoidFaceAnimation({ stateRef, scopeRef: wrapRef, canvasRef });

  return (
    <div className="binary-face" ref={wrapRef} aria-label="VOID face">
      <canvas className="binary-face__canvas" ref={canvasRef} />
    </div>
  );
}
