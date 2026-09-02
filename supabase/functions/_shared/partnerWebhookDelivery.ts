/**
 * Partner webhook delivery: the retry ladder, the signature, and the headers.
 *
 * Design record: docs/decisions/2026-09-02-d5-webhook-substrate.md.
 *
 * This module holds the parts of delivery that are pure enough to test without
 * a database or a network, which is most of them. The worker
 * (process-partner-webhooks) owns claiming and settling; this owns *what a
 * delivery is*.
 */

import { postWebhook } from "./webhookSecurity.ts";

/**
 * D5's ladder, verbatim: 1m / 5m / 30m / 2h / 6h.
 *
 * It lives here rather than in SQL so there is ONE ladder with one set of
 * tests. `settle_partner_webhook_delivery` takes the delay in seconds instead
 * of computing it, which is the difference between a constant and a copy that
 * can drift from it.
 */
export const RETRY_BACKOFF_SECONDS: readonly number[] = [60, 300, 1_800, 7_200, 21_600];

/** One first attempt plus one per rung. */
export const MAX_DELIVERY_ATTEMPTS = RETRY_BACKOFF_SECONDS.length + 1;

/** A single hop's ceiling. Five of these would exceed the 60s worker ceiling. */
export const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * Two, against the shared helper's default of five.
 *
 * Not a security argument -- webhookSecurity revalidates EVERY hop, and that
 * holds at either number. It is a budget argument: each hop carries its own
 * 10s timeout, so five hops is a 60s single delivery against a 60s worker
 * ceiling that kills the isolate with no log row. One delivery must not be
 * able to starve every other subscription queued behind it.
 */
export const DELIVERY_MAX_REDIRECTS = 2;

/**
 * How long to wait before the attempt after this one.
 *
 * @param attemptsSpent how many attempts have now been charged (the claim
 *   increments before the attempt runs, so the first failure arrives here as 1)
 * @returns seconds, or null when the ladder is exhausted and there is no next
 *   attempt to schedule
 */
export function backoffSecondsFor(attemptsSpent: number): number | null {
  if (attemptsSpent < 1) return RETRY_BACKOFF_SECONDS[0];
  const rung = RETRY_BACKOFF_SECONDS[attemptsSpent - 1];
  return rung ?? null;
}

export interface WebhookSecretState {
  secret: string;
  secret_version: number;
  previous_secret: string | null;
  previous_secret_version: number | null;
  previous_secret_expires_at: string | null;
}

export interface SelectedSecret {
  secret: string;
  /** The version actually used, which the caller must persist if it changed. */
  version: number;
  /**
   * True when the delivery's captured version could no longer be honoured and
   * it was re-signed under the current secret.
   */
  reVersioned: boolean;
}

/**
 * Pick the secret a delivery row must be signed with.
 *
 * The row captured its version at ENQUEUE. Reading "the current secret" at send
 * time instead would change the signature of an event whose id is immutable,
 * mid-ladder, and the receiver could not tell a replay from a rotation.
 *
 * Past the overlap the previous secret is gone, and the choice is between
 * delivering under a signature the partner *can* verify and failing delivery to
 * preserve one nobody holds any more. It delivers, and says so via
 * `reVersioned` so the row records what happened.
 */
export function selectSigningSecret(
  webhook: WebhookSecretState,
  deliverySecretVersion: number,
  now: Date,
): SelectedSecret {
  if (deliverySecretVersion === webhook.secret_version) {
    return { secret: webhook.secret, version: webhook.secret_version, reVersioned: false };
  }

  const overlapEnds = webhook.previous_secret_expires_at
    ? Date.parse(webhook.previous_secret_expires_at)
    : Number.NaN;
  const overlapIsLive = Number.isFinite(overlapEnds) && overlapEnds > now.getTime();

  if (
    overlapIsLive && webhook.previous_secret !== null &&
    webhook.previous_secret_version === deliverySecretVersion
  ) {
    return {
      secret: webhook.previous_secret,
      version: deliverySecretVersion,
      reVersioned: false,
    };
  }

  return { secret: webhook.secret, version: webhook.secret_version, reVersioned: true };
}

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * `sha256=<hex>` over `<timestamp>.<body>`.
 *
 * The timestamp is INSIDE the signed material, not merely alongside it. Signing
 * the body alone would let anyone who captured one delivery replay it forever
 * with a fresh timestamp header and a signature that still verifies -- the
 * header would be decoration. Bound together, a receiver that rejects old
 * timestamps gets a replay window it can actually enforce.
 */
export async function signWebhookPayload(
  secret: string,
  timestampSeconds: number,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestampSeconds}.${body}`),
  );
  return `sha256=${toHex(signature)}`;
}

export interface DeliveryHeadersInput {
  eventType: string;
  eventId: string;
  timestampSeconds: number;
  signature: string;
}

/** PRD §22.2's canonical set. */
export function deliveryHeaders(input: DeliveryHeadersInput): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "User-Agent": "Postora-Webhooks/1.0",
    "X-Postora-Event": input.eventType,
    "X-Postora-Event-Id": input.eventId,
    "X-Postora-Timestamp": String(input.timestampSeconds),
    "X-Postora-Signature": input.signature,
  };
}

export interface DeliveryOutcome {
  ok: boolean;
  statusCode: number | null;
  error: string | null;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * POST one delivery and classify the result.
 *
 * 2xx is success. Everything else is a failure that goes back on the ladder --
 * including a 4xx, deliberately. A receiver that answers 400 during a deploy
 * and 200 afterwards is the ordinary case, and treating a 4xx as permanent
 * would discard events for a partner whose endpoint recovered a minute later.
 * The ladder ends by itself.
 */
export async function deliverWebhook(
  url: string,
  headers: Record<string, string>,
  body: string,
  fetcher: Fetcher = fetch,
): Promise<DeliveryOutcome> {
  try {
    const response = await postWebhook(url, { method: "POST", headers, body }, fetcher, {
      timeoutMs: DELIVERY_TIMEOUT_MS,
      maxRedirects: DELIVERY_MAX_REDIRECTS,
    });
    // The body is never read. A partner's response is not data Postora needs,
    // and reading an unbounded stream from a partner-controlled endpoint is an
    // exposure with no upside.
    await response.body?.cancel();

    if (response.status >= 200 && response.status < 300) {
      return { ok: true, statusCode: response.status, error: null };
    }
    return {
      ok: false,
      statusCode: response.status,
      error: `endpoint responded ${response.status}`,
    };
  } catch (error) {
    // A refused target, an exhausted redirect budget and a timeout all land
    // here. None carries a status code, and saying so is more useful than
    // inventing one.
    return {
      ok: false,
      statusCode: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
