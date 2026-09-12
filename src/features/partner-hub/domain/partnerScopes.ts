// Frontend twin of GENERIC_SCOPES in supabase/functions/_shared/partnerScopes.ts.
// Kept honest by __tests__/partnerScopes.test.ts, which asserts equality with
// docs/api/openapi.yaml GenericScope. The frozen LEGACY_SCOPES (whatsapp:
// template.send, templates.read, webhooks.manage) are never offered (decision
// D3); the generic whatsapp:numbers.* and whatsapp:profile.* scopes are not
// legacy and are.

export interface PartnerScopeOption {
  value: string;
  description: string;
}

export const PARTNER_SCOPES: readonly PartnerScopeOption[] = [
  { value: "accounts:read", description: "List and read bound social accounts" },
  { value: "agents:read", description: "List human agents and conversation assignments" },
  { value: "agents:manage", description: "Create, update and delete human agents; assign and unassign conversations" },
  { value: "automation:read", description: "Read AI agent config and tools, handlers, audience, conversation modes and auto-replies" },
  { value: "automation:manage", description: "Change AI agent config and tools, handlers, conversation modes and auto-replies" },
  { value: "comments:read", description: "List and read public comments on connected accounts" },
  { value: "comments:manage", description: "Reply to, hide and delete public comments" },
  { value: "connectors:manage", description: "Create connect links for Composio-backed tools" },
  { value: "connectors:read", description: "List connected tools and their usage" },
  { value: "conversations:read", description: "List conversations" },
  { value: "media:read", description: "Read uploaded media" },
  { value: "media:write", description: "Upload media (billed storage)" },
  { value: "messages:read", description: "Read messages" },
  { value: "messages:send", description: "Send WhatsApp messages (consumes monthly quota)" },
  // Platform-tier scopes act only through a platform key (pl_live_/pl_test_).
  // On a partner key they authorise nothing: the platform router authenticates
  // against partner_platform_keys, which this dialog never mints. Listed so the
  // twin equals GenericScope; whether the dialog should hide them is open.
  { value: "platform:keys.manage", description: "Platform tier only: issue and revoke workspace keys" },
  { value: "platform:workspaces.manage", description: "Platform tier only: provision workspaces" },
  { value: "platform:workspaces.read", description: "Platform tier only: list and read provisioned workspaces" },
  { value: "posts:publish", description: "Publish posts immediately" },
  { value: "posts:read", description: "Read posts and their status" },
  { value: "posts:schedule", description: "Schedule and unschedule posts" },
  { value: "posts:write", description: "Create posts" },
  { value: "templates:read", description: "List approved WhatsApp templates" },
  { value: "tools:execute", description: "Execute connected tools headlessly (metered, not billed)" },
  { value: "usage:read", description: "Read this key's usage meters" },
  { value: "webhooks:manage", description: "Create, update, delete and test webhooks" },
  { value: "webhooks:read", description: "List webhooks" },
  { value: "whatsapp:numbers.read", description: "List WhatsApp numbers, pairing and history-sync state" },
  { value: "whatsapp:numbers.manage", description: "Register numbers, start pairing and history sync, end sessions" },
  { value: "whatsapp:profile.read", description: "Read the WhatsApp business profile" },
  { value: "whatsapp:profile.manage", description: "Update the WhatsApp business profile" },
] as const;
