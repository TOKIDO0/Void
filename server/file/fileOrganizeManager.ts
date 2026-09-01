import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { assertAllowedFilePath } from "./filePathPolicy";
import { createFileError, resolveDownloadFinalRoot } from "./fileRuntimePaths";
import type { FileOrganizeDirectoryData } from "./fileTypes";

const CATEGORY_MAP: Record<string, string> = {
  // Images
  ".jpg": "Images", ".jpeg": "Images", ".png": "Images", ".gif": "Images", ".webp": "Images", ".bmp": "Images", ".svg": "Images", ".heic": "Images", ".psd": "Images", ".tiff": "Images",
  // Documents
  ".pdf": "Documents", ".doc": "Documents", ".docx": "Documents", ".txt": "Documents", ".md": "Documents", ".rtf": "Documents", ".odt": "Documents",
  // Spreadsheets
  ".xls": "Spreadsheets", ".xlsx": "Spreadsheets", ".csv": "Spreadsheets", ".ods": "Spreadsheets",
  // Presentations
  ".ppt": "Presentations", ".pptx": "Presentations", ".odp": "Presentations", ".key": "Presentations",
  // Archives
  ".zip": "Archives", ".rar": "Archives", ".7z": "Archives", ".tar": "Archives", ".gz": "Archives", ".bz2": "Archives", ".xz": "Archives",
  // Videos
  ".mp4": "Videos", ".avi": "Videos", ".mkv": "Videos", ".mov": "Videos", ".webm": "Videos", ".flv": "Videos",
  // Audios
  ".mp3": "Audios", ".wav": "Audios", ".flac": "Audios", ".aac": "Audios", ".ogg": "Audios", ".m4a": "Audios", ".wma": "Audios",
  // Code
  ".js": "Code", ".ts": "Code", ".jsx": "Code", ".tsx": "Code", ".py": "Code", ".java": "Code", ".cpp": "Code", ".c": "Code", ".h": "Code", ".html": "Code", ".css": "Code", ".json": "Code", ".yaml": "Code", ".yml": "Code", ".go": "Code", ".rs": "Code", ".php": "Code", ".rb": "Code", ".sh": "Code", ".ps1": "Code", ".bat": "Code",
  // Executables
  ".exe": "Executables", ".msi": "Executables", ".dmg": "Executables", ".appimage": "Executables",
};

function categorizeFile(fileName: string): string {
  const ext = extname(fileName).toLowerCase();
  return CATEGORY_MAP[ext] ?? "Others";
}

function isSensitiveFileName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower === ".env" || lower.startsWith(".env.") || [".key", ".pem", ".p12", ".pfx"].some((ext) => lower.endsWith(ext)) || ["id_rsa", "id_dsa", "id_ed25519"].includes(lower);
}

function uniqueTargetPath(targetDir: string, fileName: string): string {
  let candidate = join(targetDir, fileName);
  if (!existsSync(candidate)) return candidate;
  const ext = extname(fileName);
  const base = basename(fileName, ext);
  let counter = 1;
  while (existsSync(candidate)) {
    candidate = join(targetDir, `${base} (${counter})${ext}`);
    counter += 1;
    if (counter > 1000) break;
  }
  return candidate;
}

export class FileOrganizeManager {
  organizeDirectory(input: { path?: string; dryRun?: boolean }): FileOrganizeDirectoryData {
    const rawPath = input.path?.trim() ? input.path.trim() : resolveDownloadFinalRoot();
    const dryRun = input.dryRun === true;
    const basePath = assertAllowedFilePath(rawPath);
    const baseStat = statSync(basePath);
    if (!baseStat.isDirectory()) {
      throw createFileError("INVALID_REQUEST", `整理目标不是目录：${basePath}`);
    }

    const entries = readdirSync(basePath, { withFileTypes: true });
    const moves: FileOrganizeDirectoryData["moves"] = [];
    const skipped: FileOrganizeDirectoryData["skipped"] = [];
    const categoryCounts = new Map<string, number>();

    for (const entry of entries) {
      const entryPath = join(basePath, entry.name);
      // 只处理顶层文件，目录本身不移动
      if (entry.isDirectory()) {
        skipped.push({ path: entryPath, reason: "目录不移动" });
        continue;
      }
      // 符号链接不跟随
      try {
        if (lstatSync(entryPath).isSymbolicLink()) {
          skipped.push({ path: entryPath, reason: "符号链接不处理" });
          continue;
        }
      } catch {
        skipped.push({ path: entryPath, reason: "无法读取文件状态" });
        continue;
      }
      if (!entry.isFile()) {
        skipped.push({ path: entryPath, reason: "非普通文件" });
        continue;
      }
      if (isSensitiveFileName(entry.name)) {
        skipped.push({ path: entryPath, reason: "敏感文件不移动" });
        continue;
      }

      const category = categorizeFile(entry.name);
      const targetDir = join(basePath, category);
      const targetPath = uniqueTargetPath(targetDir, entry.name);

      categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);

      if (dryRun) {
        moves.push({ from: entryPath, to: targetPath, category });
        continue;
      }

      // 实际移动：确保目标目录存在
      mkdirSync(targetDir, { recursive: true });
      // 安全校验：目标仍在允许根内
      assertAllowedFilePath(targetPath);
      try {
        renameSync(entryPath, targetPath);
        moves.push({ from: entryPath, to: targetPath, category });
      } catch (error) {
        skipped.push({ path: entryPath, reason: error instanceof Error ? error.message : "移动失败" });
        // 回退计数
        categoryCounts.set(category, (categoryCounts.get(category) ?? 1) - 1);
      }
    }

    const categories = Array.from(categoryCounts.entries())
      .filter(([, count]) => count > 0)
      .map(([category, count]) => ({ category, count, targetDir: join(basePath, category) }))
      .sort((a, b) => a.category.localeCompare(b.category));

    return {
      path: basePath,
      strategy: "byExtension",
      dryRun,
      totalFiles: entries.filter((e) => e.isFile()).length,
      movedCount: moves.length,
      skippedCount: skipped.length,
      categories,
      moves,
      skipped,
      organizedAt: Date.now()
    };
  }
}

export const fileOrganizeManager = new FileOrganizeManager();
