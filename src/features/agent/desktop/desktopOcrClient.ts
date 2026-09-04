/**
 * AQ 读屏 OCR 直调客户端（Windows 原生 OCR 经 Rust command，不走 sidecar HTTP）。
 * 桌面端专用；纯 Web 下 invoke 不可用，如实报 NOT_DESKTOP。
 */

import { invoke } from "@tauri-apps/api/core";

export type OcrWordView = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type OcrLineView = {
  text: string;
  words: OcrWordView[];
};

export async function ocrImageFile(path: string): Promise<OcrLineView[]> {
  try {
    return await invoke<OcrLineView[]>("ocr_image_file", { path });
  } catch (error) {
    const message = typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "读屏识别失败";
    const err = new Error(message) as Error & { ocrCode: string };
    err.ocrCode = /桌面端|Tauri|__TAURI__|not allowed|not found/i.test(message) ? "NOT_DESKTOP" : "OCR_FAILED";
    throw err;
  }
}
