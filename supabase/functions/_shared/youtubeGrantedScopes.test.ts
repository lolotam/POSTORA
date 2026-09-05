import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  dropGrantedScope,
  recordGrantedScopes,
} from "./youtubeGrantedScopes.ts";

function fakeAdmin(existing: Record<string, unknown>) {
  const writes: Array<Record<string, unknown>> = [];
  return {
    writes,
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: { account_metadata: existing },
              error: null,
            }),
        }),
      }),
      update: (patch: Record<string, unknown>) => {
        writes.push(patch);
        return { eq: () => Promise.resolve({ error: null }) };
      },
    }),
  };
}

Deno.test("recordGrantedScopes merges into existing metadata", async () => {
  const admin = fakeAdmin({
    comment_automation_handler: "internal",
    granted_scopes: ["old"],
  });
  await recordGrantedScopes(admin, "acc", "a b");
  assertEquals(admin.writes[0].account_metadata, {
    comment_automation_handler: "internal",
    granted_scopes: ["a", "b"],
  });
});

Deno.test("recordGrantedScopes writes nothing for an empty scope field", async () => {
  const admin = fakeAdmin({});
  await recordGrantedScopes(admin, "acc", undefined);
  assertEquals(admin.writes, []);
});

Deno.test("dropGrantedScope removes one scope and keeps the rest", async () => {
  const admin = fakeAdmin({ granted_scopes: ["a", "b"] });
  await dropGrantedScope(admin, "acc", "b");
  assertEquals(admin.writes[0].account_metadata, { granted_scopes: ["a"] });
});
