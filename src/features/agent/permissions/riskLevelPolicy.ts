// 风险等级在高权限模式下的有效映射（阶段 AC-P1）。
// 普通模式：原样返回；高权限模式：静态 L2→L1 免确认。
// 豁免：已由动态安全 hook 抬升的敏感文件读取（file.readText + 敏感路径）保持 L2——
// 高权限 ≠ 无脑放行密钥文件。该豁免由调用方在合并动态风险前判断；此处只做静态映射。

import type { RiskLevel } from "../tools/toolTypes";
import { isHighPermissionMode } from "../../settings/highPermissionMode";

export function resolveEffectiveStaticRiskLevel(staticRisk: RiskLevel): RiskLevel {
  if (!isHighPermissionMode()) {
    return staticRisk;
  }
  if (staticRisk === "L2") {
    return "L1";
  }
  return staticRisk;
}
