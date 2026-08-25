/**
 * 桌面应用启动（阶段 AC-P2/P3）。
 * 扫描开始菜单 .lnk + 通过 explorer 启动；不做任意路径 spawn、不解析 .lnk 目标。
 * 风险等级由工具层定义；高权限模式在 permissionGate 统一降级。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { spawn } from "node:child_process";
import { platform } from "node:os";

export type DesktopInstalledApp = {
  name: string;
  lnkPath: string;
};

export type DesktopLaunchResult = {
  name: string;
  lnkPath: string;
  launchedAt: number;
};

const MAX_APPS = 200;

function getStartMenuRoots(): string[] {
  const roots: string[] = [];
  const programData = process.env.ProgramData?.trim();
  const appData = process.env.APPDATA?.trim();
  if (programData) {
    roots.push(join(programData, "Microsoft", "Windows", "Start Menu", "Programs"));
  }
  if (appData) {
    roots.push(join(appData, "Microsoft", "Windows", "Start Menu", "Programs"));
  }
  return roots.filter((p) => p && existsSync(p));
}

function collectLnkFiles(dir: string, depth: number, out: string[]): void {
  if (depth < 0 || out.length >= MAX_APPS) return;
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as unknown as ReturnType<typeof readdirSync>;
  } catch {
    return;
  }
  for (const entry of entries as unknown as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>) {
    if (out.length >= MAX_APPS) break;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectLnkFiles(full, depth - 1, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".lnk")) {
      out.push(full);
    }
  }
}

export function listInstalledApplications(): DesktopInstalledApp[] {
  if (platform() !== "win32") {
    throw Object.assign(new Error("应用列表当前仅支持 Windows"), { desktopCode: "UNSUPPORTED_PLATFORM" });
  }
  const lnkPaths: string[] = [];
  for (const root of getStartMenuRoots()) {
    collectLnkFiles(root, 2, lnkPaths);
  }
  const seen = new Set<string>();
  const apps: DesktopInstalledApp[] = [];
  for (const lnkPath of lnkPaths) {
    const name = basename(lnkPath, ".lnk").trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    apps.push({ name, lnkPath });
    if (apps.length >= MAX_APPS) break;
  }
  apps.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  return apps;
}

export function launchApplicationByName(name: string): DesktopLaunchResult {
  if (platform() !== "win32") {
    throw Object.assign(new Error("应用启动当前仅支持 Windows"), { desktopCode: "UNSUPPORTED_PLATFORM" });
  }
  const trimmed = name.trim();
  if (!trimmed) {
    throw Object.assign(new Error("应用名不能为空"), { desktopCode: "INVALID_REQUEST" });
  }
  const apps = listInstalledApplications();
  const lower = trimmed.toLowerCase();
  // 精确匹配优先
  let matched = apps.find((a) => a.name.toLowerCase() === lower);
  let candidates: DesktopInstalledApp[] = [];
  if (!matched) {
    candidates = apps.filter((a) => a.name.toLowerCase().includes(lower));
    if (candidates.length === 1) {
      matched = candidates[0];
      candidates = [];
    } else if (candidates.length > 1) {
      // 多候选：返回列表让模型澄清
      throw Object.assign(
        new Error(`找到 ${candidates.length} 个匹配“${trimmed}”的应用：${candidates.slice(0, 8).map((c) => c.name).join("、")}。请明确要打开哪一个。`),
        { desktopCode: "AMBIGUOUS_APP_NAME", details: { candidates: candidates.slice(0, 8) } }
      );
    }
  }
  if (!matched) {
    throw Object.assign(new Error(`未找到应用“${trimmed}”`), { desktopCode: "APP_NOT_FOUND", details: { query: trimmed } });
  }
  // 校验 lnk 仍存在且非 symlink 逃逸（开始菜单固定根内）
  if (!existsSync(matched.lnkPath)) {
    throw Object.assign(new Error(`应用快捷方式不存在：${matched.name}`), { desktopCode: "PATH_NOT_FOUND" });
  }
  try {
    const stat = statSync(matched.lnkPath);
    if (!stat.isFile()) {
      throw new Error("not file");
    }
  } catch {
    throw Object.assign(new Error(`应用快捷方式不可用：${matched.name}`), { desktopCode: "PATH_NOT_FOUND" });
  }
  // 用 explorer 启动 .lnk（系统合法宿主，零路径解析、零 Shell 注入面）
  const child = spawn("explorer.exe", [matched.lnkPath], { detached: true, stdio: "ignore" });
  child.unref();
  return { name: matched.name, lnkPath: matched.lnkPath, launchedAt: Date.now() };
}
