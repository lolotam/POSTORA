// Frontend twin of GENERIC_SCOPES in supabase/functions/_shared/partnerScopes.ts.
// Kept honest by __tests__/partnerScopes.test.ts, which asserts equality with
// docs/api/openapi.yaml GenericScope. Legacy whatsapp:* scopes are never
// offered (decision D3): they are frozen and not issuable to new keys.

export interface PartnerScopeOption {
  value: string;
  description: string;
}

export const PARTNER_SCOPES: readonly PartnerScopeOption[] = [
  { value: "accounts:read", description: "List and read bound social accounts" },
  { value: "conversations:read", description: "List conversations" },
  { value: "media:read", description: "Read uploaded media" },
  { value: "media:write", description: "Upload media (billed storage)" },
  { value: "messages:read", description: "Read messages" },
  { value: "messages:send", description: "Send WhatsApp messages (consumes monthly quota)" },
  { value: "posts:publish", description: "Publish posts immediately" },
  { value: "posts:read", description: "Read posts and their status" },
  { value: "posts:schedule", description: "Schedule and unschedule posts" },
  { value: "posts:write", description: "Create posts" },
  { value: "templates:read", description: "List approved WhatsApp templates" },
  { value: "usage:read", description: "Read this key's usage meters" },
  { value: "webhooks:manage", description: "Create, update, delete and test webhooks" },
  { value: "webhooks:read", description: "List webhooks" },
] as const;
