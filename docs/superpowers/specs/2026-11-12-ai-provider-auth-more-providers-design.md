# More AI provider sign-ins: OpenRouter, xAI Grok, Kimi Code, MiniMax, Z.ai

Date: 2026-11-12. Status: design, owner-approved scope ("Everything 9router does", admin first, then users).
Builds on: PR #404 (`ai-provider-auth`, `_shared/aiOAuth/*`, migration `20261112120000_ai_provider_oauth.sql`).
Research: summarised in §2. Sources: vendor docs (OpenRouter OAuth guide, docs.z.ai devpack FAQ and usage policy, platform.minimax.io coding-plan quickstart, kimi.com Kimi Code membership guide), 9router at commit `1855aa44` (`src/lib/oauth/providers/*.js`, `open-sse/providers/registry/*.js`), pi-mono at commit `6249ca27` (`packages/ai/src/auth/oauth/*.ts`), and the pi-ai 0.73.1 npm package.
Required reading for any implementer: `ARCHITECTURE.md` §12–16 (edge function shape, Zod, sanitised errors), §23 (RLS, grants, regenerated types), §26–28 (idempotency, atomic claim), §31 (infrastructure seams).

## 1. Goal

The admin can connect five more AI providers through a sign-in instead of pasting a key, from the AI Providers card, the same way Claude and ChatGPT subscriptions work today. A later phase reuses the same flows per user in Settings → Integrations.

Pasted API keys for `xai`, `openrouter`, `minimax`, `moonshot` and `zai` already work (rows exist in `ai_providers`) and are not changed by this design.

## 2. What each provider supports

| Provider | Flow | Client | Token lifetime | Inference with the credential | Terms risk |
|---|---|---|---|---|---|
| OpenRouter | PKCE with a Postora HTTPS callback (official third-party flow) | none needed | permanent API key, no refresh | `https://openrouter.ai/api/v1`, OpenAI-compatible; pi-ai provider `openrouter` | low |
| xAI Grok (SuperGrok / X Premium) | device code (RFC 8628) at `auth.x.ai/oauth2/device/code`, token at `/oauth2/token` | shared public client `b1a00492-073a-47ea-816f-4c329264a828` (same as Grok CLI, pi, Hermes) | access token + **rotating** refresh token | Bearer to `https://api.x.ai/v1`; pi-ai provider `xai` with the access token as `apiKey` | medium; some tiers answer 403 after login |
| Kimi Code | device code at `auth.kimi.com/api/oauth/device_authorization`, token at `/api/oauth/token` (pending arrives as HTTP 200 `error: authorization_pending`) | Kimi CLI client `17e5f671-d194-4dfb-9706-5516cb48c098` (borrowed) | access + refresh | Bearer to `https://api.kimi.com/coding/v1` (OpenAI-compatible) | medium: membership "designed for programming scenarios"; User-Agent tampering can pause benefits |
| MiniMax (MiniMax Code) | device code + PKCE at `account.minimax.io/oauth2/device/code`, token at `/oauth2/token` (non-standard `{status}` envelope) | `mcode-public` (borrowed from MiniMax Code CLI) | access ~1 h + **single-use** refresh | internal gateway `https://agent.minimax.io/mavis/api/v1/llm/v1/messages`, Anthropic-messages shape | high: reverse-engineered internal gateway |
| Z.ai (GLM Coding Plan) | ZCode CLI poll flow: `zcode.z.ai/api/v1/oauth/cli/init` → browser → `/poll/<flow_id>` → `api.z.ai/api/auth/z/login` → create or read an API key named `zcode-api-key` | ZCode CLI flow (borrowed) | long-lived plan **API key**, no refresh | `https://api.z.ai/api/coding/paas/v4`, OpenAI-compatible; pi-ai provider `zai` | **high**: terms limit the plan to official tools, forbid multi-user access, ban after three violations |

Not built: the Grok CLI proxy (`cli-chat-proxy.grok.com`). It works only by impersonating the official CLI's identity headers. Postora sends no impersonated User-Agent or client identifier to any provider.

## 3. Risk handling (owner chose full scope with the risks stated)

1. **Admin first.** Every flow in this design connects the platform's own account. This does **not** avoid Z.ai's multi-user clause: one admin plan answering for every Postora user is the "multi-user access" its usage policy forbids, and the Z.ai risk sentence says so. Whether users later get their own MiniMax, Kimi Code or Z.ai sign-in is an owner decision at the user phase (§12).
2. **Explicit acknowledgement.** Before `start` for xAI, Kimi, MiniMax or Z.ai, the dialog shows the provider's specific risk sentence (table above) and requires a checkbox. The acknowledgement is sent as `acknowledged_risk: true`; the function refuses `start` without it for those four (`risk_not_acknowledged`, logged).
3. **Per-provider switch.** New `system_settings` keys `feature_ai_oauth_<provider>` (default `false`) on top of the existing `feature_ai_provider_oauth`. Turning a provider's switch off hides its sign-in and stops it from being used for inference; a stored connection stays visible so it can be disconnected (same rule as today).
4. **Honest identification.** Requests carry Postora's own User-Agent. Kimi's `X-Msh-Platform` is `postora`. MiniMax's gateway headers (`User-Agent: MiniMaxAgent`, `X-Mavis-Agent-Id`) are required by that gateway; this is the one place the design matches a vendor CLI's headers, and it is called out in the MiniMax risk sentence.

## 4. Flow types in `_shared/aiOAuth`

`clients.ts` today has one shape, `OAuthClient` (PKCE, paste the redirect). It becomes a discriminated union keyed by `flow`:

```ts
type AiAuthClient = PastePkceClient | CallbackPkceClient | DeviceClient;

interface PastePkceClient { flow: "pkce_paste"; /* existing OAuthClient members */ }

interface CallbackPkceClient {
  flow: "pkce_callback";
  id: "openrouter";
  authorizeUrl(challenge: string, state: string, callbackUrl: string): string;
  exchangeRequest(code: string, verifier: string): { url: string; init: RequestInit };
  /** Turns the exchange response into the stored credential. */
  credentialFrom(body: unknown): StoredCredential;
}

interface DeviceClient {
  flow: "device";
  id: "xai" | "kimi-coding" | "minimax-code" | "zai-coding";
  startRequest(pkce: Pkce | null): { url: string; init: RequestInit };
  /** What the admin sees: a URL to open and, when the provider has one, a code to type. */
  parseStart(body: unknown): { verificationUrl: string; userCode: string | null; pollHandle: string; intervalSec: number; expiresInSec: number };
  pollRequest(pollHandle: string, pkce: Pkce | null): { url: string; init: RequestInit };
  /** Maps each provider's own pending / slow_down / denied / expired envelope to one result. */
  parsePoll(status: number, body: unknown): DevicePollResult;
  /** Z.ai only: the extra login + key-mint calls after the poll says ready. */
  finalize?(deps: LoginDeps, polled: unknown): Promise<StoredCredential>;
  refreshRequest?(refreshToken: string): { url: string; init: RequestInit };
}

type DevicePollResult =
  | { kind: "pending" } | { kind: "slow_down" }
  | { kind: "denied" } | { kind: "expired" }
  | { kind: "ready"; body: unknown };

type StoredCredential =
  | { kind: "oauth"; access: string; refresh: string | null; expires: number; accountLabel: string | null }
  | { kind: "api_key"; key: string; accountLabel: string | null };
```

`OAuthProviderId` widens to `"anthropic" | "openai-codex" | "openrouter" | "xai" | "kimi-coding" | "minimax-code" | "zai-coding"`. The ids are ours for the new five (pi-ai 0.73.1 has no OAuth for them).

Routing today (`_shared/ai-fallback.ts`, `callChatCompletion` and `callAiChain`): a tier carries `provider` (an `ai_providers.provider_code`) and `authMethod`. `authMethod === 'oauth'` sends it through `callOAuthTier`, which maps the code with `oauthProviderForCode` and validates the model with `isOAuthTierModel` against pi-ai's registry. Consequences:

- `xai` and `openrouter` keep their existing provider rows. Key tiers and sign-in tiers for the same code are told apart by `authMethod`, as Claude and OpenAI already are.
- Kimi Code, MiniMax Code and the Z.ai Coding Plan are **not** the Moonshot, MiniMax or Z.ai key products: different credentials, base URLs and model ids. They get **their own `ai_providers` rows**, `kimi-coding`, `minimax-code` and `zai-coding`, seeded inactive, so a key tier can never be routed to a coding-plan endpoint or the other way round.
- `isOAuthTierModel` cannot use pi-ai's registry for the new ids. Each new client declares its model list (`models: readonly string[]`, seeded from pi-ai 1.5.2 and 9router), and `isOAuthTierModel` consults the client list first, pi-ai second.
- Synced models do **not** pass this gate. "Sync models" fills `ai_models`, the API-key catalogue, from the key endpoint; nothing proves the subscription endpoint serves those ids. A sign-in tier is therefore offered and accepted only for an id in the client list or pi-ai's registry: the Auth group's picker and `isOAuthTierModel` read the same list, so an admin cannot save a sign-in tier the gate would refuse. Widening the sign-in tier to synced ids needs proof per provider that its subscription endpoint serves them, and is a separate change.

Constants are copied, not imported: pi-ai 1.5.2 (`@earendil-works/pi-ai`, `src/auth/oauth/{xai,kimi-coding,openrouter}.ts`) and 9router (`src/lib/oauth/providers/{minimax-code-shared,glm}.js`) are the references; the file header names the source and commit, as `clients.ts` already does. We do not upgrade pi-ai in this work: its OpenRouter module needs `node:http`, and the major bump is a separate change.

## 5. Edge function contract (`ai-provider-auth`)

Unchanged actions keep their shape. New and widened:

| Action | Body | Answer |
|---|---|---|
| `start` | `{ oauth_provider, acknowledged_risk? }` | paste PKCE: `{ flow: "pkce_paste", authorize_url }` (as today); callback PKCE: `{ flow: "pkce_callback", authorize_url }`; device: `{ flow: "device", attempt_id, verification_url, user_code, interval_sec, expires_at }` |
| `poll` (new) | `{ oauth_provider, attempt_id }` | `{ status: "pending" \| "connected" \| "denied" \| "expired", account_label? }` |
| `finish` | `{ oauth_provider, pasted }` for both PKCE flows: the paste box sends what the admin pasted, the callback route sends the address the provider redirected to | `{ status: "connected", account_label }` |

One `finish` shape keeps one parser (`parseAuthorizationInput`) for the code and the state. The callback route reads both from the same address the edge function parses, so they can never come from different places. (Amended 2026-11-13 from separate `code` and `state` fields.)

Rules:
- The device code, poll handle, PKCE verifier and Z.ai poll token stay server-side in the login-attempt row; the browser only ever holds `attempt_id`. Same storage and 10-minute TTL as the PKCE verifier today (`loginFlow.ts`, `LOGIN_TTL_MS`); device attempts use the provider's own `expires_in`, capped at 15 minutes.
- `poll` is rate-limited to the provider's `interval_sec` per attempt server-side (a too-early poll answers `pending` without calling the provider); a `slow_down` adds 5 s, per RFC 8628.
- The browser drives polling (every `interval_sec`, stops on a terminal status, on dialog close, or at `expires_at`). The edge function makes at most one provider call per `poll`; no long-running loops inside a request.
- Exception, bounded finalization: when a `poll` sees the provider report the login ready, the same request runs the client's `finalize` hook (Z.ai: the login call, then reading or minting the API key) before answering `connected`. `finalize` makes at most two provider calls, each under the existing exchange timeout, and never loops. If it fails, the attempt row keeps the ready poll token, the answer is `pending`, and the next `poll` retries `finalize` only, without polling the provider again. No extra status is exposed to the browser.
- OpenRouter's callback is a front-end route, `/admin/settings/ai/oauth/openrouter/callback`, which reads `code` and `state` and calls `finish`. `state` is the `oauth_states` primary key and binds to the admin's user id. The callback origin comes from the allow-list the social OAuth flows already use for return origins (`_shared/oauthState.ts` and its return-origin checks), never from a raw request header. OpenRouter's docs accept any callback URL, localhost included, and recommend a public one; re-check scheme and port rules when building PR A.
- Every refusal is logged (`logRefusal`) with a stable code: `risk_not_acknowledged`, `provider_disabled`, `attempt_not_found`, `attempt_expired`, `poll_too_early` (not logged; normal), `exchange_failed`, `device_denied`.

## 6. Storage

Live definitions:
- Table `ai_provider_oauth_connections` (`20261112120000`).
- RPCs `save_ai_oauth_credentials`, `claim_ai_oauth_refresh`, `complete_ai_oauth_refresh`, `fail_ai_oauth_refresh` as redefined in `20261112150000_ai_oauth_refresh_fence.sql`.
- Login attempts in the shared `oauth_states` table (`20260820130000`: `state` PK, `provider_code`, `code_verifier`, `redirect_uri`, `scope_kind`, `user_id`, `return_to`, `expires_at`, RLS deny-all).

New migration (never edit the applied ones):
- Widen `ai_provider_oauth_connections.oauth_provider` CHECK to the seven ids.
- Add `credential_kind text NOT NULL DEFAULT 'oauth' CHECK (credential_kind IN ('oauth','api_key'))`; `save_ai_oauth_credentials` gains a defaulted `p_credential_kind`.
- Seed inactive `ai_providers` rows `kimi-coding`, `minimax-code`, `zai-coding` (§4).
- `oauth_states`: add `flow text`, `device_payload jsonb` (device code, poll token, Z.ai poll bearer; protected like `code_verifier` today: service-role only, RLS deny-all, deleted on finish or expiry) and `next_poll_at timestamptz`. MiniMax keeps its PKCE verifier in `code_verifier`; other device flows store an empty string there.
- RPCs stay `SECURITY DEFINER`, `search_path = public, pg_temp`, service-role only.
- Regenerate `src/integrations/supabase/types.ts`.
- SQL proof in `supabase/tests/ai_oauth_more_providers.sql`, registered in `scripts/db-harness.sh`: new ids accepted, unknown id refused, anon/authenticated cannot read either table, an attempt cannot be polled after `expires_at`.

## 7. Credentials and refresh

`getFreshOAuthCredential` keeps its lease (`claim_ai_oauth_refresh`), which already makes refresh single-flight. That matters for xAI (rotating refresh tokens) and MiniMax (single-use refresh): a second refresh with an already-used token would log the connection out.

- `credential_kind = 'api_key'` (OpenRouter, Z.ai) is returned as is; never refreshed.
- Refresh failures that mean "log in again" (`invalid_grant`, 400/401 from the token endpoint) set `reauth_required`, as today (`isReauthRefreshError`).
- If a refresh response has no new refresh token, keep the old one (pi-ai's behaviour).

## 8. Inference wiring (`piCall.ts`, `chainTier.ts`)

| Provider | How a call is made |
|---|---|
| OpenRouter, Z.ai | pi-ai 0.73.1 API-key provider (`openrouter`, `zai`) with the stored key as `apiKey`. |
| xAI | pi-ai `xai` provider with the access token as `apiKey`. A 403 on inference is reported as `subscription_tier_not_allowed`, not as a broken login. |
| Kimi Code | pi-ai 0.73.1 already ships provider `kimi-coding` (base `https://api.kimi.com/coding`, `anthropic-messages`): first choice, with the access token as `apiKey`. If the live probe shows that endpoint refuses an OAuth token, use a model object on `https://api.kimi.com/coding/v1`, `openai-completions` (pi 1.5.2's choice), with `X-Msh-Platform: postora`. |
| MiniMax | pi-ai model object with `baseUrl: https://agent.minimax.io/mavis/api/v1/llm`, api `anthropic-messages`, Bearer access token, gateway headers from §3.4. |

`test` uses the same path with one short prompt, as today.

**Probe before building UI (PR B, PR C).** For each device-code provider, a live probe (`*.live.test.ts`) first proves that a token from its flow is accepted on the exact endpoint and API shape above. pi 1.5.2 sends xAI OAuth tokens through the Responses API, while pi-ai 0.73.1's `xai` provider uses chat completions; if chat completions refuses the token, xAI gets a Responses-shaped model object instead.

## 9. UI

- `SubscriptionLoginsStrip` (PR #407) lists every enabled provider from `capabilities`, not just two. `capabilities` adds `flow` and `risk` (`low | medium | high`) per provider.
- `SubscriptionLoginSection` branches on `flow`:
  - `pkce_paste`: unchanged.
  - `pkce_callback`: "Sign in with OpenRouter" opens `authorize_url` in the same tab; the callback route finishes and returns to the AI settings tab with a toast.
  - `device`: risk sentence + acknowledgement checkbox (medium/high), then a panel with the user code (copy button), "Open sign-in page" (opens `verification_url`), a countdown to `expires_at`, and a live status line driven by `poll`. Z.ai shows no user code (its flow has none).
- Gateway (`aiProviderAuthGateway.ts`) widens its Zod schemas to the new answers; hooks gain `usePollAiOAuth`.

## 10. Delivery (each its own PR, migration applied to prod before merge, owner approves each merge)

1. **PR A — framework + OpenRouter.** Union client type, storage migration, `pkce_callback`, callback route, `credential_kind`. Lowest risk; proves the framework.
2. **PR B — device code + xAI + Kimi Code.** `poll` action, device UI, acknowledgement, per-provider switches.
3. **PR C — MiniMax + Z.ai.** The two reverse-engineered flows, behind switches that stay off until the owner turns them on.
4. **Later — users.** The user-level AI auth feature already queued reuses these flows; which providers it offers is the owner's decision at that phase (§12).

## 11. Tests

- Deno, per client: start/poll/exchange request shapes; each provider's pending / slow_down / denied / expired envelope mapped correctly (Kimi's HTTP-200 pending, MiniMax's `{status}` envelope, xAI's HTTP-400 errors); Z.ai finalize reads an existing `zcode-api-key` before creating one.
- Deno, handler: `start` without acknowledgement refused for the four risky providers; `poll` before `next_poll_at` makes no provider call; a disabled provider's `start` is refused and logged; device secrets never appear in any response.
- Deno, credentials: rotating refresh keeps single-flight under two concurrent callers; missing refresh token keeps the old one; `api_key` kind never refreshes.
- Vitest: device panel countdown and terminal states; acknowledgement gate; callback route calls `finish` with `code` and `state` and handles a missing `code`.
- Live probes (`*.live.test.ts`, not in CI) per provider, run by the owner after connecting.

## 12. Open items

- User phase: the owner chose "Everything 9router does" and "admin first, then users". Before the user phase, ask by card whether users get MiniMax, Kimi Code and Z.ai sign-ins given §2's terms risk, or only OpenRouter and xAI.
- §9 builds on `SubscriptionLoginsStrip` from PR #407; PR A is cut after #407 merges, or based on its branch.

- xAI subscription OAuth is documented only through third parties; if xAI publishes a per-app client registration, switch to it.
- Model lists differ between sources for every provider. The admin's "Sync models" button stays the source of truth for **API-key** tiers; sign-in tiers use the client list and pi-ai's registry only (§4).
- China endpoints (minimaxi.com, bigmodel.cn, kimi.ai overseas split) are out of scope for sign-in; API-key rows may add them later.
