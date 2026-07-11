export type {
  ConfirmationDecision,
  ConfirmationRequest,
  RiskPolicy
} from "./permissionTypes";

export { DEFAULT_RISK_POLICY } from "./permissionTypes";

export {
  createConfirmationRequest,
  requiresUserConfirmation,
  resolveEffectiveRiskLevel
} from "./permissionGate";
