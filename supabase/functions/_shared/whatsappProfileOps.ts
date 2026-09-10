// Cloud API business profiles. Each door resolves and authorizes the account.
// deno-lint-ignore no-import-prefix
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { WhatsAppOpError, type Fetcher, type WhatsAppOpsContext } from "./whatsappPartnerOps.ts";

// Preserve the browser profile endpoint's provider version and validation.
const GRAPH_API = "https://graph.facebook.com/v21.0";
const PATCHABLE = ["about", "address", "description", "email", "websites", "vertical"] as const;
const UpdateSchema = z.object({
  about: z.string().max(139).optional(),
  address: z.string().max(256).optional(),
  description: z.string().max(512).optional(),
  email: z.string().email().max(128).optional().or(z.literal("")),
  websites: z.array(z.string().url()).max(2).optional(),
  vertical: z.string().max(128).optional(),
});
const ProfileSchema = z.object({
  about: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  websites: z.array(z.string()).optional(),
  vertical: z.string().nullable().optional(),
  profile_picture_url: z.string().nullable().optional(),
});

function assertCloudProfile(ctx: WhatsAppOpsContext): void {
  if (ctx.connectionMode === "evolution_qr") {
    throw new WhatsAppOpError("The business profile is a Cloud API capability, unavailable for Direct QR numbers.", "unsupported_capability", 422);
  }
  if (!ctx.phoneNumberId || !ctx.accessToken) {
    throw new WhatsAppOpError("Reconnect this number to restore its Cloud API credentials", "account_not_connected", 409);
  }
}

function unknownOutcome(): WhatsAppOpError {
  return new WhatsAppOpError("Could not confirm the Meta business profile response", "meta_error", 502, undefined, true);
}

async function profileRequest(ctx: WhatsAppOpsContext, init: RequestInit, fetcher: Fetcher): Promise<Record<string, unknown>> {
  assertCloudProfile(ctx);
  const controller = new AbortController();
  // Cover headers AND body; a stalled body must not strand the write claim.
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const fields = init.method === "GET" ? `?fields=${PATCHABLE.join(",")},profile_picture_url` : "";
    const response = await fetcher(`${GRAPH_API}/${ctx.phoneNumberId}/whatsapp_business_profile${fields}`, {
      ...init, signal: controller.signal,
      headers: { Authorization: `Bearer ${ctx.accessToken}`, "Content-Type": "application/json" },
    });
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw unknownOutcome();
    const result = body as Record<string, unknown>;
    if (response.status >= 500) throw unknownOutcome();
    if (!response.ok || result.error) {
      const code = (result.error as { code?: number } | undefined)?.code;
      throw new WhatsAppOpError(
        code === 190 ? "WhatsApp access token is invalid or expired — reconnect the account." : "Meta rejected the business profile request",
        code === 190 ? "account_needs_reauth" : "meta_error", code === 190 ? 401 : 422, code,
      );
    }
    return result;
  } catch (error) {
    if (error instanceof WhatsAppOpError) throw error;
    throw unknownOutcome();
  } finally {
    clearTimeout(timer);
  }
}

export async function getBusinessProfile(ctx: WhatsAppOpsContext, fetcher: Fetcher = fetch) {
  const body = await profileRequest(ctx, { method: "GET" }, fetcher);
  // A malformed read is never an empty profile that a client could save back.
  const parsed = z.object({ data: z.array(ProfileSchema).min(1) }).safeParse(body);
  if (!parsed.success) throw unknownOutcome();
  const profile = parsed.data.data[0];
  return {
    about: profile.about ?? null, address: profile.address ?? null,
    description: profile.description ?? null, email: profile.email ?? null,
    websites: profile.websites ?? [], vertical: profile.vertical ?? null,
    profile_picture_url: profile.profile_picture_url ?? null,
  };
}

export async function updateBusinessProfile(ctx: WhatsAppOpsContext, patch: unknown, fetcher: Fetcher = fetch) {
  assertCloudProfile(ctx);
  const parsed = UpdateSchema.safeParse(patch);
  if (!parsed.success) throw new WhatsAppOpError("Invalid business profile fields", "invalid_request", 400);
  const payload: Record<string, unknown> = {};
  for (const key of PATCHABLE) {
    if (Object.prototype.hasOwnProperty.call(parsed.data, key) && parsed.data[key] !== undefined) payload[key] = parsed.data[key];
  }
  if (Object.keys(payload).length === 0) throw new WhatsAppOpError("Provide at least one business profile field", "invalid_request", 400);
  const result = await profileRequest(ctx, {
    method: "POST", body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
  }, fetcher);
  if (result.success !== true) throw unknownOutcome();
  return { success: true };
}
