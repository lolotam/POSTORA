import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseCredentialUpsertResult } from "./credentialVaultRpc.ts";

const MALFORMED = "Malformed response storing connector credentials";

/**
 * Production regression, 2026-08-31: every attempt to save a WooCommerce
 * connector failed with "Malformed response storing connector credentials".
 *
 * `public.upsert_connector_credential_secret` is declared
 * `RETURNS TABLE(secret_id uuid, configured_fields text[])`, which makes it
 * set-returning (`pg_proc.proretset = true`). PostgREST serialises a
 * set-returning function as a JSON **array**, so `supabase-js`'s `.rpc()`
 * hands back `[{...}]`, never `{...}`. The Edge Function cast the payload to a
 * single object, so `secret_id` was always `undefined`.
 *
 * The literal below is the verbatim body captured from the deployed stack:
 *
 *   POST http://<kong>:8000/rest/v1/rpc/upsert_connector_credential_secret
 *   -> HTTP 200
 *   [{"secret_id":"ad243b9c-...","configured_fields":["probe_key"]}]
 *
 * It is the evidence, not an assumption about PostgREST. Do not delete it.
 */
Deno.test("the set-returning array PostgREST actually returns is parsed", () => {
  assertEquals(
    parseCredentialUpsertResult([
      { secret_id: "ad243b9c-aa67-49f7-b297-ba3083fc9f7b", configured_fields: ["probe_key"] },
    ]),
    { secretId: "ad243b9c-aa67-49f7-b297-ba3083fc9f7b", configuredFields: ["probe_key"] },
  );
});

Deno.test("both wire shapes resolve to the same result", async (t) => {
  const accepted: Array<[string, unknown]> = [
    // What a WooCommerce save actually returns: an array, three secret fields
    // minus the url-kind one the registry routes into `settings`.
    ["the array of a multi-field save", [{
      secret_id: "11111111-2222-3333-4444-555555555555",
      configured_fields: ["consumer_key", "consumer_secret"],
    }]],
    // Cheap insurance: adding `.single()` to the call, or redeclaring the SQL
    // as a scalar, flips the shape back to an object. The parser must not be
    // the thing that breaks when it does.
    ["a bare object", {
      secret_id: "11111111-2222-3333-4444-555555555555",
      configured_fields: ["consumer_key", "consumer_secret"],
    }],
  ];

  for (const [label, payload] of accepted) {
    await t.step(label, () => {
      assertEquals(parseCredentialUpsertResult(payload), {
        secretId: "11111111-2222-3333-4444-555555555555",
        configuredFields: ["consumer_key", "consumer_secret"],
      });
    });
  }
});

Deno.test("an unreadable payload is refused, never read as a successful write", async (t) => {
  // Reading any of these as success would let the row write that follows
  // persist a null vault link, stranding the secret just created.
  const refused: Array<[string, unknown]> = [
    ["an empty result set", []],
    ["a row with no secret_id", [{ configured_fields: ["a"] }]],
    ["a row with no configured_fields", [{ secret_id: "s-1" }]],
    ["a non-string field name", [{ secret_id: "s-1", configured_fields: ["a", 2] }]],
    ["null", null],
    ["a bare string", "ok"],
  ];

  for (const [label, payload] of refused) {
    await t.step(label, () => {
      assertThrows(() => parseCredentialUpsertResult(payload), Error, MALFORMED);
    });
  }
});
