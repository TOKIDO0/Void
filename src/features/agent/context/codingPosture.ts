// 轻量姿态路由：对标 Hermes agent/coding_context.py 冻结姿态思想。
// 目标：代码目录少废话、给校验指引；非代码目录省 token。纯只读探测，无 Shell、无 daemon。

export type CodingPosture = {
  isCoding: boolean;
  workspaceBlock: string | null;
  guidance: string | null;
};

let cached: CodingPosture | null = null;

const CODING_GUIDANCE = [
  "【代码工作区姿态】当前在代码仓库内：先读后改再验。",
  "遵循：定位文件→只读抽取→最小改动→tsc/测试验证→汇报。",
  "可用命令：npx tsc --noEmit -p tsconfig.json；npm run build；对应包管理器 test。",
  "编辑优先用受限 file 工具，不猜测路径，缺参先确认。"
].join("\n");

export function resolveCodingPosture(forceRefresh = false): CodingPosture {
  if (cached && !forceRefresh) {
    return cached;
  }
  const isCoding = detectIsCodingWorkspace();
  const posture: CodingPosture = isCoding
    ? {
        isCoding: true,
        workspaceBlock: buildWorkspaceBlock(),
        guidance: CODING_GUIDANCE
      }
    : {
        isCoding: false,
        workspaceBlock: null,
        guidance: null
      };
  cached = posture;
  return posture;
}

export function resetCodingPostureCache(): void {
  cached = null;
}

function detectIsCodingWorkspace(): boolean {
  // 启发式：VOID 本身即代码仓库（package.json + .git），探测成功即 isCoding。
  // 优先尝试 Node fs（Tauri/Web 下无 process 时回退为 true，避免误判 general）。
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    if (g.process?.platform) {
      // Node 侧：同步探测 500 entries 上限思路的极简版
      // 动态 require 避免 Web 侧类型压力
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = eval("require")("node:fs") as any;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const path = eval("require")("node:path") as any;
      const cwd = g.process.cwd?.() ?? "D:\\AI\\Codex\\void";
      const markers = ["package.json", "Cargo.toml", "pyproject.toml", ".git", "pnpm-lock.yaml"];
      for (const m of markers) {
        try {
          if (fs.existsSync(path.join(cwd, m))) {
            return true;
          }
        } catch {}
      }
      // 再试父级一层（Hermes _marker_root 思路）
      try {
        const parent = path.dirname(cwd);
        for (const m of markers) {
          if (fs.existsSync(path.join(parent, m))) {
            return true;
          }
        }
      } catch {}
      return false;
    }
  } catch {}
  // 浏览器侧无 fs：默认视为代码姿态（VOID 桌面壳始终在仓库内），由上层按意图降权
  return true;
}

function buildWorkspaceBlock(): string {
  // 极简快照：对标 Hermes build_coding_workspace_block 的 Root/Branch/Verify
  // 真实 git 信息由构建时注入，此处用静态快照避免异步与权限
  return [
    "【工作区快照】",
    "Root: D:\\AI\\Codex\\void",
    "Branch: main (clean)",
    "Verify: npx tsc --noEmit -p tsconfig.json；npm run build"
  ].join("\n");
}

// 供 turnCapabilityRouter 前置降权：非代码意图且非研究意图时，仅代码姿态才收敛
export function shouldConstrainToCodingTools(userInput: string, isCoding: boolean): boolean {
  if (isCoding) {
    return false;
  }
  // 非代码仓库且非研究意图：避免把通用闲聊误导进代码工具
  const codeIntent = /(?:\.ts|\.js|\.py|npm |cargo |git |代码|仓库|文件路径)/i.test(userInput);
  return !codeIntent;
}
