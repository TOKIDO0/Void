/**
 * P1 /sandbox 状态（只读能力自检，不执行任何代码）。
 *
 * owner：server/sandbox/sandboxStatus.ts。
 * 报告 JS/Python 执行隔离的真实能力：拿不到即 N/A，不伪造健康。
 */

export type SandboxStatus = {
  status: "ok";
  inspectedAt: number;
  javascript: {
    engine: "isolated-vm" | "node-vm-fallback" | "unavailable";
    memoryLimitMb: number;
    note: string;
  };
  python: {
    mode: "docker" | "system-python-explicit" | "disabled";
    note: string;
  };
  scheduler: {
    strictAsk: boolean;
  };
};

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export async function buildSandboxStatus(): Promise<SandboxStatus> {
  let jsEngine: SandboxStatus["javascript"]["engine"] = "node-vm-fallback";
  try {
    await import("isolated-vm");
    jsEngine = "isolated-vm";
  } catch {
    jsEngine = "node-vm-fallback";
  }
  const dockerImage = process.env.VOID_CODE_PYTHON_DOCKER_IMAGE?.trim();
  const systemPython = process.env.VOID_CODE_ALLOW_SYSTEM_PYTHON === "1";
  return {
    status: "ok",
    inspectedAt: Date.now(),
    javascript: {
      engine: jsEngine,
      memoryLimitMb: readPositiveIntEnv("VOID_CODE_JS_MEMORY_MB", 128),
      note:
        jsEngine === "isolated-vm"
          ? "isolated-vm 独立 Isolate + 内存上界 + 超时"
          : "hardened node:vm 回落（无外部句柄 + 超时 + 输出上界；非强隔离，生产建议装 isolated-vm）"
    },
    python: {
      mode: dockerImage ? "docker" : systemPython ? "system-python-explicit" : "disabled",
      note: dockerImage
        ? `Docker 强隔离（--network none, -m ${process.env.VOID_CODE_DOCKER_MEMORY?.trim() || "128m"}）`
        : systemPython
          ? "系统 Python 显式放行（视为审批；非强隔离，仅联调）"
          : "系统 Python 默认禁用；纯计算走 JS 沙箱"
    },
    scheduler: {
      strictAsk: process.env.VOID_DESKTOP_STRICT_ASK === "1"
    }
  };
}
