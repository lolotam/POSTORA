// Policy imports no handlers, so the platform router can consume both
// without introducing an authentication -> router -> handler import cycle.
import type { LimiterRiskClass } from "../../_shared/partnerApiMetering.ts";

export const PLATFORM_ACTION_SCOPES: Record<string, readonly string[]> = {
  create_workspace: ["platform:workspaces.manage"],
  list_platform_workspaces: ["platform:workspaces.read"],
  get_platform_workspace: ["platform:workspaces.read"],
  issue_workspace_key: ["platform:keys.manage"],
  revoke_workspace_key: ["platform:keys.manage"],
};

export const PLATFORM_ACTION_RISK: Record<string, LimiterRiskClass> = {
  create_workspace: "C",
  list_platform_workspaces: "A",
  get_platform_workspace: "A",
  issue_workspace_key: "C",
  revoke_workspace_key: "C",
};
