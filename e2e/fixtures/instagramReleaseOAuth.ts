/** Synthetic Meta HTTP only. Attempt ownership, selection and all writes stay real. */
import { verifyOAuthState } from "../../supabase/functions/_shared/oauthState.ts";
import { INSTAGRAM_RELEASE, type InstagramReleaseManifest } from "./instagramRelease.ts";

export class InstagramReleaseOAuthTransport {
  readonly calls: { operation: string }[] = [];
  private readonly codes = new Map<string, boolean>();
  private exchanged = false;
  private issued = false;
  constructor(private readonly manifest: InstagramReleaseManifest, private readonly onIssue: () => void) {}

  async authorize(endpoint: unknown): Promise<string> {
    if (typeof endpoint !== "string" || endpoint.length > 12_000) throw new Error("Synthetic authorization refused");
    const url = new URL(endpoint);
    if (url.origin !== "https://www.facebook.com" || url.pathname !== "/v22.0/dialog/oauth"
      || url.searchParams.get("client_id") !== INSTAGRAM_RELEASE.appId
      || url.searchParams.get("response_type") !== "code"
      || url.searchParams.get("redirect_uri") !== `${INSTAGRAM_RELEASE.apiUrl}/functions/v1/instagram-business-oauth`
      || !url.searchParams.get("scope")?.split(",").includes("instagram_manage_insights")) throw new Error("Synthetic authorization refused");
    const state = url.searchParams.get("state");
    if (!state) throw new Error("Synthetic authorization refused");
    const payload = await verifyOAuthState(state, { expectedPlatform: "instagram" });
    if (payload.user_id !== this.manifest.users.ownerB.id || payload.flow !== "facebook_business"
      || !payload.return_to?.startsWith(`${INSTAGRAM_RELEASE.appUrl}/profiles?`)) throw new Error("Synthetic owner/return origin refused");
    const code = `synthetic-code-${crypto.randomUUID()}`;
    this.codes.set(code, false);
    this.calls.push({ operation: "authorize" });
    const callback = new URL(`${INSTAGRAM_RELEASE.apiUrl}/functions/v1/instagram-business-oauth`);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", state);
    return callback.toString();
  }

  handles(url: URL): boolean {
    return url.origin === "https://graph.facebook.com"
      && ["/v22.0/oauth/access_token", "/v22.0/me", "/v22.0/me/accounts", "/v22.0/me/permissions"].includes(url.pathname);
  }

  reply(request: Request): Response {
    const url = new URL(request.url);
    if (!this.handles(url) || request.method !== "GET" || this.calls.length >= 30) throw new Error("Synthetic OAuth transport refused");
    const account = this.manifest.accounts.find((entry) => entry.key === "otherPage")!;
    const shortToken = `${account.token}-short`;
    const userToken = `${account.token}-renewed`;
    if (url.pathname.endsWith("/oauth/access_token")) {
      if (url.searchParams.get("client_id") !== INSTAGRAM_RELEASE.appId
        || url.searchParams.get("client_secret") !== INSTAGRAM_RELEASE.providerSecret) throw new Error("Synthetic OAuth application refused");
      if (url.searchParams.get("grant_type") === "fb_exchange_token") {
        if (!this.exchanged || url.searchParams.get("fb_exchange_token") !== shortToken) throw new Error("Synthetic token exchange refused");
        this.issued = true;
        this.onIssue();
        this.calls.push({ operation: "exchange_long_token" });
        return Response.json({ access_token: userToken, expires_in: 5_184_000 });
      }
      const code = url.searchParams.get("code");
      if (!code || this.codes.get(code) !== false
        || url.searchParams.get("redirect_uri") !== `${INSTAGRAM_RELEASE.apiUrl}/functions/v1/instagram-business-oauth`) throw new Error("Synthetic code exchange refused");
      this.codes.set(code, true);
      this.exchanged = true;
      this.calls.push({ operation: "exchange_code" });
      return Response.json({ access_token: shortToken, expires_in: 3_600 });
    }
    if (!this.issued || url.searchParams.get("access_token") !== userToken) throw new Error("Synthetic OAuth authority refused");
    if (url.pathname.endsWith("/permissions")) {
      this.calls.push({ operation: "permissions" });
      return Response.json({ data: ["instagram_basic", "instagram_manage_insights", "pages_read_engagement", "pages_show_list"]
        .map((permission) => ({ permission, status: "granted" })) });
    }
    if (url.pathname.endsWith("/accounts")) {
      this.calls.push({ operation: "pages" });
      return Response.json({ data: [{ id: `release_page_${this.manifest.namespace.slice(-12)}`, name: "Synthetic reconnect Page",
        access_token: `${account.token}-page`, instagram_business_account: { id: account.providerId, username: account.username } }] });
    }
    if (url.searchParams.get("fields") !== "id") throw new Error("Synthetic identity request refused");
    this.calls.push({ operation: "identity" });
    return Response.json({ id: `release_fb_${this.manifest.namespace.slice(-12)}` });
  }
}
