/** Canonical assembled fixture contract. Only outbound provider HTTP is synthetic. */
import { OWNER_RELEASE } from "./instagramOwnerReleaseSettings.mjs";
import { buildBusinessDiscoveryUrl } from "../../supabase/functions/competitor-snapshot-sync/graphProvider.ts";

export const INSTAGRAM_RELEASE = Object.freeze({
  apiUrl: OWNER_RELEASE.apiUrl, authUrl: OWNER_RELEASE.authUrl, restUrl: OWNER_RELEASE.restUrl,
  appUrl: "http://127.0.0.1:8080", password: "InstagramReleaseSyntheticPassword-2026!",
  cronSecret: "synthetic-instagram-release-cron-secret", appId: "770001",
  providerSecret: "synthetic-instagram-release-provider-secret",
});
export type ReleaseUserKey = "ownerA" | "ownerB" | "admin";
export type ReleaseAccountKey = "pageGranted" | "directEmpty" | "sibling" | "pageDenied" | "pageUnknown" | "pageMissing" | "pageFailed" | "pageExpired" | "threshold" | "otherPage";
export type ProviderScenario = "normal" | "token_expired" | "permission_denied" | "network_failure" | "threshold_unavailable" | "empty_metric";
export interface ReleaseUser { id: string; email: string; key: ReleaseUserKey }
export interface ReleaseAccount {
  id: string; owner: ReleaseUserKey; key: ReleaseAccountKey; providerId: string;
  loginKind: "direct" | "page_linked"; authority: "granted" | "denied" | "unknown" | "failed" | "expired";
  token: string; credentialId: string; username: string;
}
export interface ReleaseWatchlist { id: string; owner: ReleaseUserKey; username: string; scenario: string }
export interface InstagramReleaseManifest {
  version: 1; lane: "assembled"; namespace: string; referenceInstant: string;
  users: Record<ReleaseUserKey, ReleaseUser>; accounts: ReleaseAccount[]; watchlists: ReleaseWatchlist[];
}
const USER_KEYS: ReleaseUserKey[] = ["ownerA", "ownerB", "admin"];
const ACCOUNT_KEYS: ReleaseAccountKey[] = ["pageGranted", "directEmpty", "sibling", "pageDenied", "pageUnknown", "pageMissing", "pageFailed", "pageExpired", "threshold", "otherPage"];
const WATCHLIST_SCENARIOS = ["growth", "zero", "null", "missing", "stale", "source_switch", "negative", "first", "legacy", "partial", "cursor_tie", "retention_89", "retention_90"];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DAY = 86_400_000;

function releaseAccount(key: ReleaseAccountKey, namespace: string, index: number): ReleaseAccount {
  return { id: crypto.randomUUID(), key, owner: key === "otherPage" ? "ownerB" : "ownerA",
    providerId: `release_${namespace.slice(-12)}_${index}`, loginKind: key === "directEmpty" ? "direct" : "page_linked", authority: releaseAuthority(key),
    credentialId: crypto.randomUUID(), token: `synthetic-${namespace}-${key}`, username: `release_${key.toLowerCase()}` };
}

function releaseAuthority(key: ReleaseAccountKey): ReleaseAccount["authority"] {
  const authorities: Partial<Record<ReleaseAccountKey, ReleaseAccount["authority"]>> = { pageDenied: "denied", pageUnknown: "unknown", pageMissing: "unknown", pageFailed: "failed", pageExpired: "expired" };
  return authorities[key] ?? "granted";
}

export function createInstagramReleaseManifest(referenceInstant: string): InstagramReleaseManifest {
  const namespace = `instagram-release-${crypto.randomUUID()}`;
  const users = Object.fromEntries(USER_KEYS.map((key) => [key, { key, id: crypto.randomUUID(), email: `${key.toLowerCase()}-${namespace}@example.test` }])) as Record<ReleaseUserKey, ReleaseUser>;
  const watchlists: ReleaseWatchlist[] = WATCHLIST_SCENARIOS.map((scenario) => ({ id: crypto.randomUUID(), owner: "ownerA" as const,
    username: scenario === "growth" ? "release_competitor" : `release_${scenario}`, scenario }));
  watchlists.push(...Array.from({ length: 5 }, (_, index) => ({ id: crypto.randomUUID(), owner: "ownerB" as const,
    username: index === 0 ? "release_competitor" : `release_quota_${index}`, scenario: "quota" })));
  watchlists.push({ id: crypto.randomUUID(), owner: "admin", username: "release_admin", scenario: "quota" });
  const manifest: InstagramReleaseManifest = { version: 1, lane: "assembled", namespace, referenceInstant, users,
    accounts: ACCOUNT_KEYS.map((key, index) => releaseAccount(key, namespace, index)), watchlists };
  assertInstagramReleaseManifest(manifest);
  return manifest;
}

function fixtureRecord(candidate: unknown): Record<string, unknown> {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("Malformed Instagram release fixture");
  return candidate as Record<string, unknown>;
}

export function assertInstagramReleaseManifest(candidate: unknown): asserts candidate is InstagramReleaseManifest {
  const manifest = fixtureRecord(candidate);
  if (manifest.version !== 1 || manifest.lane !== "assembled" || typeof manifest.namespace !== "string"
    || !/^instagram-release-[a-f0-9-]{36}$/.test(manifest.namespace) || !UUID.test(manifest.namespace.slice(18))
    || typeof manifest.referenceInstant !== "string" || !Number.isFinite(Date.parse(manifest.referenceInstant))) throw new Error("Malformed Instagram release fixture header");
  const users = fixtureRecord(manifest.users);
  if (Object.keys(users).sort().join(",") !== "admin,ownerA,ownerB") throw new Error("Malformed Instagram release fixture users");
  const identities = USER_KEYS.map((key) => {
    const user = fixtureRecord(users[key]);
    if (user.key !== key || typeof user.id !== "string" || !UUID.test(user.id)
      || user.email !== `${key.toLowerCase()}-${manifest.namespace}@example.test`) throw new Error("Malformed Instagram release fixture identity");
    return user.id;
  });
  if (!Array.isArray(manifest.accounts) || manifest.accounts.length !== ACCOUNT_KEYS.length || !Array.isArray(manifest.watchlists)) throw new Error("Malformed Instagram release fixture resources");
  validateReleaseResources(manifest as unknown as InstagramReleaseManifest, identities);
}

function validateReleaseResources(manifest: InstagramReleaseManifest, userIdentities: readonly string[]): void {
  const identities = [...userIdentities];
  const keys = new Set<string>();
  for (const account of manifest.accounts) {
    assertReleaseAccount(account, manifest.namespace);
    if (keys.has(account.key)) throw new Error("Duplicate Instagram release fixture account");
    keys.add(account.key); identities.push(account.id, account.credentialId);
  }
  identities.push(...releaseWatchlistIds(manifest));
  if (new Set(identities).size !== identities.length) throw new Error("Duplicate Instagram release fixture identity");
}

function assertReleaseAccount(account: ReleaseAccount, namespace: string): void {
  if (!UUID.test(account.id) || !UUID.test(account.credentialId) || !ACCOUNT_KEYS.includes(account.key)
    || account.authority !== releaseAuthority(account.key)
    || account.token !== `synthetic-${namespace}-${account.key}`
    || account.providerId !== `release_${namespace.slice(-12)}_${ACCOUNT_KEYS.indexOf(account.key)}`
    || account.owner !== (account.key === "otherPage" ? "ownerB" : "ownerA")
    || account.loginKind !== (account.key === "directEmpty" ? "direct" : "page_linked")) throw new Error("Malformed Instagram release fixture account");
}

function releaseWatchlistIds(manifest: InstagramReleaseManifest): string[] {
  const watchlistKeys = new Set<string>();
  for (const watchlist of manifest.watchlists) {
    if (!UUID.test(watchlist.id) || !USER_KEYS.includes(watchlist.owner) || !/^release_[a-z0-9_]{1,22}$/.test(watchlist.username)) throw new Error("Malformed Instagram release fixture watchlist");
    const key = `${watchlist.owner}:${watchlist.username}`;
    if (watchlistKeys.has(key) || !validWatchlistScenario(watchlist)) throw new Error("Malformed Instagram release fixture watchlist scenario");
    watchlistKeys.add(key);
  }
  if (manifest.watchlists.length !== WATCHLIST_SCENARIOS.length + 6) throw new Error("Missing Instagram release fixture identity");
  return manifest.watchlists.map((watchlist) => watchlist.id);
}

function validWatchlistScenario(watchlist: ReleaseWatchlist): boolean {
  if (watchlist.owner === "ownerA") return WATCHLIST_SCENARIOS.includes(watchlist.scenario)
    && watchlist.username === (watchlist.scenario === "growth" ? "release_competitor" : `release_${watchlist.scenario}`);
  return watchlist.scenario === "quota" && (watchlist.owner === "admin" ? watchlist.username === "release_admin"
    : ["release_competitor", ...[1, 2, 3, 4].map((index) => `release_quota_${index}`)].includes(watchlist.username));
}

export function assertInstagramReleaseCleanupIdentity(manifest: InstagramReleaseManifest, candidate: unknown): void {
  assertInstagramReleaseManifest(manifest);
  const identity = fixtureRecord(candidate);
  const metadata = identity.app_metadata && typeof identity.app_metadata === "object" ? identity.app_metadata as Record<string, unknown> : {};
  if (!USER_KEYS.some((key) => manifest.users[key].id === identity.id && manifest.users[key].email === identity.email)
    || metadata.instagram_release_namespace !== manifest.namespace) throw new Error("Refusing cleanup outside the Instagram release namespace");
}

export function assertInstagramReleaseEnvironment(environment: Record<string, string | undefined>, approved: Record<string, string>): void {
  for (const [key, credential] of Object.entries(environment)) {
    const sensitive = /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|SERVICE_ROLE|PUBLISHABLE_KEY|ANON_KEY|DATABASE_URL|^PGPASSWORD|^TEST_USER_|^SUPABASE_|^VITE_|^FACEBOOK_|^INSTAGRAM_|^APIFY_|^CRON_|^PUBLIC_API_ORIGIN|^PUBLIC_APP_ORIGIN|^NODE_OPTIONS$|^NODE_EXTRA_CA_CERTS$|^NODE_USE_ENV_PROXY$|^DENO_(?:FLAGS|IMPORT_MAP)|^(?:HTTPS?|ALL)_PROXY$)/i.test(key);
    if (credential && sensitive && credential !== approved[key]) throw new Error(`Instagram release fixture refused inherited configuration: ${key}`);
  }
}

export function assertInstagramReleaseNetworkUrl(endpoint: string, lane: "browser" | "server"): void {
  const url = new URL(endpoint);
  const ports = lane === "browser" ? ["8080", "65431"] : ["65431", "65435", "65436"];
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !ports.includes(url.port) || url.username || url.password) throw new Error("Instagram release fixture refused unexpected network access");
}

export async function requireInstagramReleaseHealth(response: Response): Promise<InstagramReleaseManifest> {
  if (!response.ok) throw new Error("Instagram release fixture services unavailable");
  const health = fixtureRecord(await response.json());
  if (health.fixture !== "instagram-release" || health.authReachable !== true || health.sqlReachable !== true) throw new Error("Instagram release fixture health unavailable");
  assertInstagramReleaseManifest(health.manifest);
  return health.manifest;
}

export async function requireInstagramReleaseLogin(response: Response, expectedId: string): Promise<void> {
  if (!response.ok) throw new Error("Instagram release login failed");
  const session = fixtureRecord(await response.json());
  if (typeof session.access_token !== "string" || session.access_token.length < 20 || fixtureRecord(session.user).id !== expectedId) throw new Error("Instagram release login identity mismatch");
}

export interface ReleaseProviderCall { account: ReleaseAccountKey; operation: string; scenario: ProviderScenario; observedAt: string }
export class InstagramReleaseMetaTransport {
  readonly calls: ReleaseProviderCall[] = [];
  readonly scenarios = new Map<ReleaseAccountKey, ProviderScenario>();
  constructor(readonly manifest: InstagramReleaseManifest) { assertInstagramReleaseManifest(manifest); }

  async reply(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" || !["https://graph.facebook.com", "https://graph.instagram.com"].includes(url.origin) || !url.pathname.startsWith("/v22.0/")) throw new Error("Instagram release provider refused request");
    const account = this.manifest.accounts.find((entry) => [entry.providerId, ...[0, 1].map((index) => `${entry.providerId}_media_${index}`),
      ...Array.from({ length: 21 }, (_, index) => `${entry.providerId}_history_${index}`)].includes(url.pathname.split("/")[2]));
    if (!account || url.searchParams.get("access_token") !== account.token
      || url.hostname !== (account.loginKind === "direct" ? "graph.instagram.com" : "graph.facebook.com")) throw new Error("Instagram release provider refused authority");
    const operation = providerOperation(url, account, this.manifest);
    if (this.calls.length >= 500) throw new Error("Instagram release provider request budget exceeded");
    const scenario = this.scenarios.get(account.key) ?? "normal";
    this.calls.push({ account: account.key, operation, scenario, observedAt: this.manifest.referenceInstant });
    if (scenario === "network_failure") throw new TypeError("Synthetic provider transport unavailable");
    if (scenario === "token_expired" || scenario === "permission_denied") return Response.json({ error: { code: scenario === "token_expired" ? 190 : 10 } }, { status: 400 });
    return Response.json(providerBody({ url, account, operation, manifest: this.manifest, scenario }));
  }
}

function providerOperation(url: URL, account: ReleaseAccount, manifest: InstagramReleaseManifest): string {
  if (!/^\/v22\.0\/[^/]+(?:\/(?:media|insights))?$/.test(url.pathname)) throw new Error("Instagram release provider refused request path");
  if (new Set(url.searchParams.keys()).size !== [...url.searchParams.keys()].length) throw new Error("Instagram release provider refused duplicate request parameters");
  if (url.searchParams.get("fields")?.startsWith("business_discovery")) {
    assertDiscoveryRequest(url, account, manifest);
    return "discovery";
  }
  const allowed = url.pathname.endsWith("/insights") ? ["metric", "period", "metric_type", "since", "until", "access_token"]
    : url.pathname.endsWith("/media") ? ["fields", "limit", "after", "access_token"] : ["fields", "access_token"];
  if ([...url.searchParams.keys()].some((key) => !allowed.includes(key))) throw new Error("Instagram release provider refused request parameters");
  if (url.pathname.endsWith("/insights")) return validateMetricRequest(url);
  if (url.pathname.endsWith("/media")) {
    assertInventoryRequest(url, account);
    return "inventory";
  }
  if (!["followers_count,media_count", "id,username,name,biography,followers_count,follows_count,media_count,profile_picture_url,website"].includes(url.searchParams.get("fields") ?? "")) throw new Error("Instagram release provider refused profile request");
  return "profile";
}

function assertDiscoveryRequest(url: URL, account: ReleaseAccount, manifest: InstagramReleaseManifest): void {
  const handle = /username\(([^)]+)\)/.exec(url.searchParams.get("fields") ?? "")?.[1];
  const cursor = /\.after\(([^)]+)\)/.exec(url.searchParams.get("fields") ?? "")?.[1] ?? null;
  if (!handle || !manifest.watchlists.some((entry) => entry.username === handle) || cursor !== null && cursor !== "release_page_2"
    || url.href !== buildBusinessDiscoveryUrl({ apiVersion: "v22.0", viewerIgUserId: account.providerId, handle, token: account.token, cursor })) throw new Error("Instagram release provider refused discovery request");
}

function assertInventoryRequest(url: URL, account: ReleaseAccount): void {
  const fields = account.loginKind === "direct" ? "id,media_type,timestamp,permalink,thumbnail_url,like_count,comments_count"
    : "id,caption,media_type,media_product_type,timestamp,permalink,thumbnail_url,like_count,comments_count";
  const ownDiscoveryFields = "id,media_type,media_product_type,media_url,thumbnail_url,timestamp,like_count,comments_count,permalink,caption";
  if (![fields, ownDiscoveryFields].includes(url.searchParams.get("fields") ?? "")
    || !["25", "50"].includes(url.searchParams.get("limit") ?? "") || url.searchParams.has("after")) throw new Error("Instagram release provider refused inventory request");
}

function validateMetricRequest(url: URL): string {
  const metrics = (url.searchParams.get("metric") ?? "").split(",");
  const allowed = ["reach", "views", "accounts_engaged", "total_interactions", "likes", "comments", "saved", "shares", "profile_visits", "follows", "replies"];
  if (!metrics.length || metrics.some((metric) => !allowed.includes(metric)) || new Set(metrics).size !== metrics.length) throw new Error("Instagram release provider refused metric request");
  if (url.searchParams.get("metric_type") !== "total_value") return "media_insights";
  const since = Number(url.searchParams.get("since"));
  const until = Number(url.searchParams.get("until"));
  if (url.searchParams.get("period") !== "day" || !Number.isInteger(since) || until - since !== 86400) throw new Error("Instagram release provider refused account window");
  return "account_day";
}

function syntheticMedia(account: ReleaseAccount, referenceInstant: string, index: number) {
  return { id: `${account.providerId}_media_${index}`, media_type: "VIDEO", ...(account.loginKind === "direct" ? {} : { media_product_type: index === 1 ? "FEED" : "REELS", caption: `Synthetic release media ${index}` }),
    timestamp: new Date(Date.parse(referenceInstant) - (index + 3) * DAY).toISOString(),
    like_count: index === 0 ? null : 20, comments_count: 3, view_count: index === 1 ? null : 300, media_url: "", thumbnail_url: "", permalink: "" };
}

function providerBody(input: { url: URL; account: ReleaseAccount; operation: string; manifest: InstagramReleaseManifest; scenario: ProviderScenario }): unknown {
  const { url, account, operation, manifest, scenario } = input;
  if (operation === "profile") return { id: account.providerId, username: account.username, followers_count: account.key === "threshold" ? 99 : 120, media_count: 2 };
  if (operation === "inventory") return { data: [0, 1].map((index) => syntheticMedia(account, manifest.referenceInstant, index)) };
  if (operation === "discovery") {
    const handle = /username\(([^)]+)\)/.exec(url.searchParams.get("fields") ?? "")![1];
    const second = url.searchParams.get("fields")!.includes(".after(");
    const targetAccount = { ...account, providerId: `release_target_${handle}` };
    return { business_discovery: { id: `release_target_${handle}`, username: handle, name: "Synthetic release competitor", followers_count: 120, media_count: 2,
      media: { data: [syntheticMedia(targetAccount, manifest.referenceInstant, second ? 1 : 0)],
        ...(second ? {} : { paging: { cursors: { after: "release_page_2" }, next: "https://graph.facebook.com/synthetic-cursor-never-followed" } }) } } };
  }
  if (scenario === "empty_metric") return { data: [] };
  // No approved provider threshold signal exists. Do not invent a reason from follower count.
  if (scenario === "threshold_unavailable") return { data: [] };
  const metrics = url.searchParams.get("metric")!.split(",");
  return { data: metrics.map((name) => operation === "account_day" ? { name, total_value: { value: name === "reach" ? 11 : 0 } }
    : { name, values: [{ value: name === "views" ? 300 : 0 }] }) };
}
