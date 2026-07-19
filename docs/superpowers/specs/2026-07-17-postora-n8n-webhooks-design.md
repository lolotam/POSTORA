# Postora n8n Webhooks Design

## Goal

Ship `n8n-nodes-postora` version `1.1.14` with safe webhook management, a
media lookup action, and an event trigger. The release keeps the existing
`Postora` node and its current workflows compatible.

## Scope

- Harden `n8n-api` webhook URL handling. Webhook targets must use HTTPS and
  must not be localhost, private, loopback, link-local, multicast, or reserved
  IP addresses.
- Apply the same validation when a webhook is registered, tested, and sent.
- Add `Webhook` to the existing Postora node with Register, List, Test, and
  Delete operations backed by the existing `/api/v1/webhooks` routes.
- Add `Media -> Get` to the existing Postora node, backed by the existing
  ownership-scoped `/api/v1/media/:id` route.
- Add a separate `Postora Trigger` node. When activated, it registers n8n's
  generated webhook URL for post events; when deactivated, it deletes that
  registration.
- Update the README, tests, package metadata, and committed build output in
  both node copies.

## Architecture

The backend retains the current `app_settings` webhook persistence model and
existing API routes. A shared URL validator will be the single gate before any
server-side webhook request. This prevents a registered value from becoming an
SSRF path later through either the test route or notification delivery.

The existing `Postora` action node will only make authenticated API calls. Its
new operations use the same per-item execution and `continueOnFail` behavior as
the current resources. The Trigger is a distinct n8n node type so it can use
n8n's lifecycle hooks to register and clean up its callback URL without changing
the action node's input/output contract.

## Data Flow

1. A user configures the trigger or Webhook Register action.
2. Postora validates and stores the HTTPS callback URL for that API key's user.
3. A post status event is delivered only to enabled subscriptions matching the
   event name.
4. The Trigger receives the payload and emits it as n8n workflow data.
5. Deactivation deletes the trigger-owned webhook registration.

## Error Handling And Tests

The backend returns a client error for invalid or unsafe webhook URLs and never
attempts delivery to them. The node surfaces API failures per input item when
Continue On Fail is enabled. Tests will cover Webhook and Media request shapes,
trigger registration lifecycle, and rejection of unsafe URLs. Existing actions
and their saved parameter names remain unchanged.

## Release

The source of truth for publishing is `F:\N8N\Postora-n8n-community-node`.
Its source, tests, README, package metadata, and `dist` output must match the
vendored copy at `F:\Postora_new\Postora-n8n-community-node`. The backend is
deployed with the node release because webhook actions depend on its validation.
After validation, commit the standalone repository, push `main`, create GitHub
release `v1.1.14`, verify npm publication, then commit and push the scoped
vendored and backend changes in the Postora repository.
