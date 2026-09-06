// B 自动更新冒烟：配置/插件/权限/UI 接线断言（纯静态，不碰私钥）。
// 真更新流需首个签名 release，见 .md/todo AP8 真机项。
// 用法：node scripts/agent-updater-smoke.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const read = (rel) => readFileSync(path.join(projectRoot, rel), "utf8");

  // tauri.conf.json：updater 激活 + feed + 公钥 + 产物开关
  const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
  assert(conf?.plugins?.updater?.active === true, "updater 应激活");
  const endpoints = conf?.plugins?.updater?.endpoints ?? [];
  assert(
    endpoints.some((url) => typeof url === "string" && url.startsWith("https://github.com/") && url.endsWith("latest.json")),
    "feed 应指向 GitHub Releases latest.json"
  );
  const pubkey = conf?.plugins?.updater?.pubkey ?? "";
  const decoded = Buffer.from(pubkey, "base64");
  assert(pubkey.length > 100 && decoded.length >= 64, "公钥应为有效 base64（minisign 格式）");
  assert(conf?.bundle?.createUpdaterArtifacts === true, "应产出 updater artifacts");

  // Rust：插件初始化 + 命令注册
  const libRs = read("src-tauri/src/lib.rs");
  assert(libRs.includes("tauri_plugin_updater::Builder::new().build()"), "缺 updater 插件初始化");
  assert(libRs.includes("tauri_plugin_process::init()"), "缺 process 插件初始化（更新后重启）");

  // Cargo：插件依赖
  const cargoToml = read("src-tauri/Cargo.toml");
  assert(cargoToml.includes('tauri-plugin-updater = "2"'), "缺 updater 依赖");
  assert(cargoToml.includes('tauri-plugin-process = "2"'), "缺 process 依赖");

  // capabilities：updater + process 默认集
  const capabilities = JSON.parse(read("src-tauri/capabilities/default.json"));
  assert(capabilities.permissions.includes("updater:default"), "缺 updater 权限集");
  assert(capabilities.permissions.includes("process:default"), "缺 process 权限集");

  // 前端：UpdaterSection 挂载 + npm 包
  const modal = read("src/features/settings/ModelSettingsModal.tsx");
  assert(modal.includes("<UpdaterSection language={language} />"), "设置页未挂载更新区");
  const packageJson = JSON.parse(read("package.json"));
  assert(packageJson.dependencies["@tauri-apps/plugin-updater"], "缺 updater JS 包");
  assert(packageJson.dependencies["@tauri-apps/plugin-process"], "缺 process JS 包");
  const updaterSection = read("src/features/settings/UpdaterSection.tsx");
  for (const marker of ["check()", ".download(", ".install()", "relaunch()", "检查更新", "下载并安装"]) {
    assert(updaterSection.includes(marker), `更新区缺 ${marker}`);
  }

  console.log("[agent-updater-smoke] PASSED");
  console.log(" - 配置：updater 激活 + GitHub feed + 公钥有效 + 产物开关 + 插件/权限/UI 接线全对");
}

main().catch((error) => {
  console.error("[agent-updater-smoke] FAILED", error);
  process.exitCode = 1;
});
