// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  backoffSecondsFor,
  deliverWebhook,
  deliveryHeaders,
  DELIVERY_MAX_REDIRECTS,
  MAX_DELIVERY_ATTEMPTS,
  RETRY_BACKOFF_SECONDS,
  selectSigningSecret,
  signWebhookPayload,
} from "./partnerWebhookDelivery.ts";

const OVERLAP_LIVE = "2026-09-03T00:00:00.000Z";
const NOW = new Date("2026-09-02T12:00:00.000Z");

function webhook(overrides: Record<string, unknown> = {}) {
  return {
    secret: "whsec_current",
    secret_version: 2,
    previous_secret: "whsec_old",
    previous_secret_version: 1,
    previous_secret_expires_at: OVERLAP_LIVE,
    ...overrides,
  };
}

// --- The ladder ------------------------------------------------------------

Deno.test("L1: the ladder is D5's, and it ends", () => {
  assertEquals(RETRY_BACKOFF_SECONDS, [60, 300, 1800, 7200, 21600]);
  // One first attempt plus one per rung. Off by one here and either the last
  // rung never runs or the row never exhausts.
  assertEquals(MAX_DELIVERY_ATTEMPTS, 6);
  assertEquals(backoffSecondsFor(1), 60);
  assertEquals(backoffSecondsFor(5), 21600);
  assertEquals(
    backoffSecondsFor(MAX_DELIVERY_ATTEMPTS),
    null,
    "the attempt that spends the last rung has no next attempt to schedule",
  );
});

// --- Rotation --------------------------------------------------------------

Deno.test("R1: a row on the current version signs with the current secret", () => {
  const chosen = selectSigningSecret(webhook(), 2, NOW);
  assertEquals(chosen.secret, "whsec_current");
  assertEquals(chosen.reVersioned, false);
});

Deno.test("R2: a row captured before a rotation signs with the PREVIOUS secret", () => {
  // The load-bearing rotation case. Sign this with the current secret instead
  // and a receiver sees one immutable event id arrive under two different
  // signatures mid-ladder, with no way to tell replay from rotation.
  const chosen = selectSigningSecret(webhook(), 1, NOW);
  assertEquals(chosen.secret, "whsec_old");
  assertEquals(chosen.version, 1);
  assertEquals(chosen.reVersioned, false);
});

Deno.test("R3: past the overlap the row is re-signed and SAYS so", () => {
  const expired = webhook({ previous_secret_expires_at: "2026-09-01T00:00:00.000Z" });
  const chosen = selectSigningSecret(expired, 1, NOW);
  assertEquals(chosen.secret, "whsec_current");
  assertEquals(chosen.version, 2);
  // Delivering is the right call -- a signature nobody holds any more verifies
  // for nobody. Delivering SILENTLY is not: the flag is what makes the row
  // record which secret actually signed it.
  assertEquals(chosen.reVersioned, true);
});

Deno.test("R3b: a webhook that never rotated re-versions rather than crashing", () => {
  const fresh = webhook({
    secret_version: 1,
    previous_secret: null,
    previous_secret_version: null,
    previous_secret_expires_at: null,
  });
  // A row claiming version 7 against a webhook that only ever had version 1 is
  // corrupt data, not a rotation. It must still deliver under a real secret.
  const chosen = selectSigningSecret(fresh, 7, NOW);
  assertEquals(chosen.secret, "whsec_current");
  assertEquals(chosen.reVersioned, true);
});

// --- The signature ---------------------------------------------------------

Deno.test("S1: the timestamp is INSIDE the signed material", async () => {
  const body = JSON.stringify({ id: "evt_1" });
  const atNoon = await signWebhookPayload("whsec_k", 1_800_000_000, body);
  const aSecondLater = await signWebhookPayload("whsec_k", 1_800_000_001, body);

  assert(atNoon.startsWith("sha256="));
  // If the body alone were signed, anyone who captured one delivery could
  // replay it forever with a fresh timestamp header and a signature that still
  // verified -- the header would be decoration and the receiver's replay
  // window unenforceable.
  assert(atNoon !== aSecondLater, "the same body at a different second must sign differently");
});

Deno.test("S1b: the same timestamp and body sign identically", async () => {
  // The control for S1. Without it, S1 would pass against a signer that simply
  // returned random bytes.
  const first = await signWebhookPayload("whsec_k", 1_800_000_000, "{}");
  const second = await signWebhookPayload("whsec_k", 1_800_000_000, "{}");
  assertEquals(first, second);
  const otherKey = await signWebhookPayload("whsec_other", 1_800_000_000, "{}");
  assert(first !== otherKey, "a different secret must produce a different signature");
});

Deno.test("S2: the canonical header set is exactly PRD §22.2's", () => {
  const headers = deliveryHeaders({
    eventType: "webhook.test",
    eventId: "evt_1",
    timestampSeconds: 1_800_000_000,
    signature: "sha256=abc",
  });
  assertEquals(headers["X-Postora-Event"], "webhook.test");
  assertEquals(headers["X-Postora-Event-Id"], "evt_1");
  assertEquals(headers["X-Postora-Timestamp"], "1800000000");
  assertEquals(headers["X-Postora-Signature"], "sha256=abc");
});

// --- Delivery classification ----------------------------------------------

function response(status: number): Response {
  return new Response(null, { status });
}

Deno.test("D1: 2xx succeeds, everything else goes back on the ladder", async () => {
  const ok = await deliverWebhook("https://hooks.example.com/x", {}, "{}", () =>
    Promise.resolve(response(204)));
  assertEquals(ok.ok, true);
  assertEquals(ok.statusCode, 204);

  // A 4xx is deliberately RETRYABLE. A receiver answering 400 during a deploy
  // and 200 a minute later is the ordinary case; treating 4xx as permanent
  // would discard events for a partner whose endpoint recovered.
  const rejected = await deliverWebhook("https://hooks.example.com/x", {}, "{}", () =>
    Promise.resolve(response(422)));
  assertEquals(rejected.ok, false);
  assertEquals(rejected.statusCode, 422);
});

Deno.test("D2: an internal redirect is refused without being requested", async () => {
  const requested: string[] = [];
  const outcome = await deliverWebhook("https://hooks.example.com/start", {}, "{}", (input) => {
    requested.push(String(input));
    return Promise.resolve(
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } }),
    );
  });

  assertEquals(outcome.ok, false);
  assertEquals(outcome.statusCode, null);
  // The proof is the REQUEST LIST, not the return value: a guard that validated
  // after fetching would also report a failure, having already made the
  // metadata-service call.
  assertEquals(requested, ["https://hooks.example.com/start"]);
});

Deno.test("D3: the redirect budget is spent, not unlimited", async () => {
  let hops = 0;
  const outcome = await deliverWebhook("https://a.example.com/0", {}, "{}", () => {
    hops++;
    return Promise.resolve(
      new Response(null, {
        status: 302,
        headers: { location: `https://a.example.com/${hops}` },
      }),
    );
  });

  assertEquals(outcome.ok, false);
  // Each hop carries its own 10s timeout, so an unbounded chain is a single
  // delivery that can eat the whole 45s tick and starve every subscription
  // behind it.
  assertEquals(hops, DELIVERY_MAX_REDIRECTS + 1);
});
