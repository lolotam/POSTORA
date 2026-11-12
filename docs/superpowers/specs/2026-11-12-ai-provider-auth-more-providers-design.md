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

1. **Admin only.** Every flow in this design connects the platform's own account. MiniMax, Kimi Code and Z.ai sign-ins are never offered at user level (§8); users get API keys or OpenRouter / xAI sign-in there.
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

`OAuthProviderId` widens to `"anthropic" | "openai-codex" | "openrouter" | "xai" | "kimi-coding" | "minimax-code" | "zai-coding"`. The ids are ours for the new five (pi-ai 0.73.1 has no OAuth for them), and `OAUTH_PROVIDER_CODE` maps them to the existing `ai_providers.provider_code`: `openrouter → openrouter`, `xai → xai`, `kimi-coding → moonshot`, `minimax-code → minimax`, `zai-coding → zai`.

Constants are copied, not imported: pi-ai 1.5.2 (`@earendil-works/pi-ai`, `src/auth/oauth/{xai,kimi-coding,openrouter}.ts`) and 9router (`src/lib/oauth/providers/{minimax-code-shared,glm}.js`) are the references; the file header names the source and commit, as `clients.ts` already does. We do not upgrade pi-ai in this work: its OpenRouter module needs `node:http`, and the major bump is a separate change.

## 5. Edge function contract (`ai-provider-auth`)

Unchanged actions keep their shape. New and widened:

| Action | Body | Answer |
|---|---|---|
| `start` | `{ oauth_provider, acknowledged_risk? }` | paste PKCE: `{ flow: "pkce_paste", authorize_url }` (as today); callback PKCE: `{ flow: "pkce_callback", authorize_url }`; device: `{ flow: "device", attempt_id, verification_url, user_code, interval_sec, expires_at }` |
| `poll` (new) | `{ oauth_provider, attempt_id }` | `{ status: "pending" \| "connected" \| "denied" \| "expired", account_label? }` |
| `finish` | `{ oauth_provider, pasted }` for paste PKCE; `{ oauth_provider, code, state }` for callback PKCE | `{ status: "connected", account_label }` |

Rules:
- The device code, poll handle, PKCE verifier and Z.ai poll token stay server-side in the login-attempt row; the browser only ever holds `attempt_id`. Same storage and 10-minute TTL as the PKCE verifier today (`loginFlow.ts`, `LOGIN_TTL_MS`); device attempts use the provider's own `expires_in`, capped at 15 minutes.
- `poll` is rate-limited to the provider's `interval_sec` per attempt server-side (a too-early poll answers `pending` without calling the provider); a `slow_down` adds 5 s, per RFC 8628.
- The browser drives polling (every `interval_sec`, stops on a terminal status, on dialog close, or at `expires_at`). The edge function makes at most one provider call per `poll`; no long-running loops inside a request.
- OpenRouter's callback is a front-end route, `/admin/settings/ai/oauth/openrouter/callback`, which reads `code` and `state` and calls `finish`. `state` binds to the attempt row and the admin's user id. The callback URL is built from the app origin (`APP_ORIGIN` env), never from the request.
- Every refusal is logged (`logRefusal`) with a stable code: `risk_not_acknowledged`, `provider_disabled`, `attempt_not_found`, `attempt_expired`, `poll_too_early` (not logged; normal), `exchange_failed`, `device_denied`.

## 6. Storage

New migration (do not edit `20261112120000`, already applied to prod):

- Widen `ai_provider_oauth_connections.oauth_provider` CHECK to the seven ids.
- Add `credential_kind text NOT NULL DEFAULT 'oauth' CHECK (credential_kind IN ('oauth','api_key'))`.
- Login attempts: add `flow text`, `device_payload_secret_id uuid` (Vault, holds device code / poll token / verifier), `next_poll_at timestamptz`, `expires_at timestamptz` to the attempts table used by `loginFlow.ts`.
- RPCs stay `SECURITY DEFINER`, `search_path = public, pg_temp`, service-role only. `save_ai_oauth_connection` gains `p_credential_kind`.
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
| Kimi Code | pi-ai model object with `baseUrl: https://api.kimi.com/coding/v1`, api `openai-completions`, Bearer access token, `X-Msh-Platform: postora`. |
| MiniMax | pi-ai model object with `baseUrl: https://agent.minimax.io/mavis/api/v1/llm`, api `anthropic-messages`, Bearer access token, gateway headers from §3.4. |

`test` uses the same path with one short prompt, as today.

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
4. **Later — users.** The user-level AI auth feature already queued reuses these flows for OpenRouter and xAI only; MiniMax, Kimi Code and Z.ai sign-ins stay admin-only (§3.1).

## 11. Tests

- Deno, per client: start/poll/exchange request shapes; each provider's pending / slow_down / denied / expired envelope mapped correctly (Kimi's HTTP-200 pending, MiniMax's `{status}` envelope, xAI's HTTP-400 errors); Z.ai finalize reads an existing `zcode-api-key` before creating one.
- Deno, handler: `start` without acknowledgement refused for the four risky providers; `poll` before `next_poll_at` makes no provider call; a disabled provider's `start` is refused and logged; device secrets never appear in any response.
- Deno, credentials: rotating refresh keeps single-flight under two concurrent callers; missing refresh token keeps the old one; `api_key` kind never refreshes.
- Vitest: device panel countdown and terminal states; acknowledgement gate; callback route calls `finish` with `code` and `state` and handles a missing `code`.
- Live probes (`*.live.test.ts`, not in CI) per provider, run by the owner after connecting.

## 12. Open items

- xAI subscription OAuth is documented only through third parties; if xAI publishes a per-app client registration, switch to it.
- Model lists differ between sources for every provider; the admin's "Sync models" button stays the source of truth.
- China endpoints (minimaxi.com, bigmodel.cn, kimi.ai overseas split) are out of scope for sign-in; API-key rows may add them later.
