import type { V1Route } from "../v1/router.ts";
import { withPlatformAuth } from "./authenticated.ts";
import { createWorkspace, getWorkspace, listWorkspaces } from "./workspaces.ts";
import { issueWorkspaceKey, revokeWorkspaceKey } from "./keys.ts";

export const PLATFORM_ROUTES: V1Route[] = [
  {
    pattern: "/v1/platform/workspaces",
    methods: {
      POST: withPlatformAuth("create_workspace", "C", createWorkspace),
      GET: withPlatformAuth("list_platform_workspaces", "A", listWorkspaces),
    },
  },
  {
    pattern: "/v1/platform/workspaces/{id}",
    methods: {
      GET: withPlatformAuth("get_platform_workspace", "A", getWorkspace),
    },
  },
  {
    pattern: "/v1/platform/workspaces/{id}/keys",
    methods: {
      POST: withPlatformAuth("issue_workspace_key", "C", issueWorkspaceKey),
    },
  },
  {
    pattern: "/v1/platform/keys/{id}",
    methods: {
      DELETE: withPlatformAuth("revoke_workspace_key", "C", revokeWorkspaceKey),
    },
  },
];
