import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createFileError, resolveRuntimeRoot } from "./fileRuntimePaths";

function normalizeForComparison(pathValue: string): string {
  const normalized = resolve(pathValue).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInside(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizeForComparison(candidate);
  const normalizedRoot = normalizeForComparison(root);
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

export function listAllowedFileRoots(): string[] {
  const configured = [resolveRuntimeRoot()];
  const extra = process.env.VOID_FILE_ALLOW_ROOTS?.trim();
  if (extra) {
    configured.push(...extra.split(";").map((item) => item.trim()).filter(Boolean));
  }
  return configured.map((root) => {
    if (!isAbsolute(root)) {
      throw createFileError("INVALID_REQUEST", `允许根必须是绝对路径：${root}`);
    }
    if (!existsSync(root)) {
      throw createFileError("FILE_NOT_FOUND", `允许根不存在：${root}`);
    }
    return realpathSync.native(root);
  });
}

/**
 * 校验绝对路径和符号链接逃逸。mustExist=false 时通过最近存在父级的 realpath
 * 还原目标位置，供 verify/create/move 的预检复用。
 */
export function assertAllowedFilePath(
  pathValue: string,
  options: { mustExist?: boolean } = {}
): string {
  const trimmed = pathValue?.trim();
  if (!trimmed) {
    throw createFileError("INVALID_REQUEST", "path 不能为空");
  }
  if (!isAbsolute(trimmed)) {
    throw createFileError("INVALID_REQUEST", `path 必须是绝对路径：${trimmed}`);
  }

  const requestedPath = resolve(trimmed);
  const mustExist = options.mustExist !== false;
  let resolvedPath: string;
  if (existsSync(requestedPath)) {
    resolvedPath = realpathSync.native(requestedPath);
  } else {
    if (mustExist) {
      throw createFileError("FILE_NOT_FOUND", `路径不存在：${requestedPath}`);
    }
    let existingAncestor = dirname(requestedPath);
    while (!existsSync(existingAncestor)) {
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) {
        throw createFileError("FILE_NOT_FOUND", `找不到路径的存在父级：${requestedPath}`);
      }
      existingAncestor = parent;
    }
    const realAncestor = realpathSync.native(existingAncestor);
    resolvedPath = resolve(realAncestor, relative(existingAncestor, requestedPath));
  }

  const allowedRoots = listAllowedFileRoots();
  if (!allowedRoots.some((root) => isInside(resolvedPath, root))) {
    throw createFileError(
      "PATH_NOT_ALLOWED",
      `路径不在允许根内：${requestedPath}`,
      { allowedRoots }
    );
  }
  return resolvedPath;
}
