/**
 * 发版后处理：把 updater latest.json 里的 api.github.com 资产 URL 改写为
 * github.com 直链（.../releases/download/<tag>/<filename>）。
 *
 * 根因（AP8 真机 403）：tauri-action 生成的 feed 用 api.github.com 资产 URL，
 * 该形态匿名访问 fragile（Accept/限流/鉴权任一不对即 403，且与浏览器下载不是一条路）。
 * github.com 直链就是浏览器点下载走的那条路，匿名可用、无需特殊头、无 API 限流。
 * signature 字段原样保留（只换 url，验签不受影响）。
 *
 * 用法（CI，TAG/GH_TOKEN 由 workflow 给）：
 *   node scripts/rewrite-updater-feed.mjs
 * 单测：import { rewriteFeedUrls } from "./rewrite-updater-feed.mjs"（见 agent-updater-smoke）。
 */

import { execFileSync } from "node:child_process";

function buildAssetMap(assetsJsonText) {
  const assets = JSON.parse(assetsJsonText);
  const map = new Map();
  for (const asset of Array.isArray(assets) ? assets : []) {
    if (asset && typeof asset.id !== "undefined" && typeof asset.name === "string") {
      map.set(String(asset.id), asset.name);
    }
  }
  return map;
}

function pickFileName(platformKey, assetNames) {
  const names = [...assetNames];
  const isNsiEntry = platformKey.toLowerCase().includes("nsis");
  const msi = names.find((name) => name.toLowerCase().endsWith(".msi"));
  const nsis = names.find((name) => name.toLowerCase().includes("-setup.exe"));
  if (isNsiEntry) {
    return nsis ?? null;
  }
  return msi ?? nsis ?? null;
}

/**
 * 纯函数：改写 feed JSON 文本。返回改写后的文本（或原样 + warnings）。
 * 不确定能映射的平台条目保持原 URL，并在 warnings 里点名（fail-closed，不猜文件名）。
 */
export function rewriteFeedUrls(feedJsonText, tag, repo, assetsJsonText) {
  const warnings = [];
  let feed;
  try {
    feed = JSON.parse(feedJsonText);
  } catch {
    return { text: feedJsonText, warnings: ["feed 不是合法 JSON，未改写"] };
  }
  const assetMap = buildAssetMap(assetsJsonText);
  const platforms = feed && typeof feed === "object" && feed.platforms && typeof feed.platforms === "object"
    ? feed.platforms
    : null;
  if (!platforms) {
    return { text: feedJsonText, warnings: ["feed 无 platforms，未改写"] };
  }
  const assetNames = new Set(assetMap.values());
  for (const [platformKey, entry] of Object.entries(platforms)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const fileName = pickFileName(platformKey, assetNames);
    if (!fileName) {
      warnings.push(`平台 ${platformKey} 找不到对应安装包文件名，保持原 URL`);
      continue;
    }
    entry.url = `https://github.com/${repo}/releases/download/${tag}/${fileName}`;
  }
  return { text: JSON.stringify(feed, null, 2) + "\n", warnings };
}

function gh(args, input) {
  return execFileSync("gh", args, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"]
  });
}

async function main() {
  const tag = (process.env.TAG ?? "").trim();
  const repo = (process.env.REPO ?? "TOKIDO0/Void").trim();
  if (!tag) {
    throw new Error("缺少 TAG 环境变量");
  }
  const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "void-feed-"));
  try {
    gh(["release", "download", tag, "-p", "latest.json", "--clobber", "-D", dir]);
    const original = readFileSync(join(dir, "latest.json"), "utf8");
    const assetsJson = gh(["release", "view", tag, "--json", "assets", "--jq", ".assets"]);
    const { text, warnings } = rewriteFeedUrls(original, tag, repo, assetsJson);
    for (const warning of warnings) {
      console.warn(`[rewrite-updater-feed] ${warning}`);
    }
    writeFileSync(join(dir, "latest.json"), text, "utf8");
    gh(["release", "upload", tag, join(dir, "latest.json"), "--clobber"]);
    console.log("[rewrite-updater-feed] feed 已改写为 github.com 直链并回传");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("rewrite-updater-feed.mjs");
if (invokedDirectly) {
  main().catch((error) => {
    console.error("[rewrite-updater-feed] FAILED", error);
    process.exitCode = 1;
  });
}
