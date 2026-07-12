import { spawn } from "node:child_process";

/** 固定启动 Windows 资源管理器；参数必须由上层受限映射生成，绝不经过 shell。 */
export function launchWindowsExplorer(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("explorer.exe", args, {
      windowsHide: true,
      shell: false,
      detached: true,
      stdio: "ignore"
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      // explorer 会立即脱离，不能用其退出码判断窗口是否成功创建。
      resolve();
    });
  });
}
