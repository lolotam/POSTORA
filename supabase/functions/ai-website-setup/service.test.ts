import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applySetup, type SetupDb, SetupError } from "./service.ts";
import { parseDraft } from "./draft.ts";

const request = {
  job_id: "job",
  fields: ["business_profile.products"],
  expected_config_updated_at: "2026-09-06T10:00:00Z",
};
const result = parseDraft(
  {
    business_profile: { products: "Mugs" },
    evidence: { "business_profile.products": ["https://example.com"] },
  },
  ["https://example.com"],
  { mode: "page", pages: 1, truncated: false },
);

Deno.test("apply never interprets unreadable configuration as a blank config", async () => {
  const db: SetupDb = {
    rpc: () => Promise.resolve({ data: null, error: { code: "57014" } }),
  };
  await assertRejects(
    () => applySetup(db, "owner", request),
    Error,
    "database operation failed",
  );
});

Deno.test("apply sends the caller's exact version to the atomic write and surfaces concurrent edits", async () => {
  const db: SetupDb = {
    rpc: (name, args) => {
      if (name === "read_ai_website_setup") {
        return Promise.resolve({
          data: {
            config: { updated_at: request.expected_config_updated_at },
            jobs: [{ id: "job", status: "ready", result }],
          },
          error: null,
        });
      }
      assertEquals(args.p_user_id, "owner");
      assertEquals(
        args.p_expected_updated_at,
        request.expected_config_updated_at,
      );
      assertEquals(args.p_business_profile, { products: "Mugs" });
      return Promise.resolve({ data: null, error: { code: "40001" } });
    },
  };
  await assertRejects(
    () => applySetup(db, "owner", request),
    SetupError,
    "Configuration changed",
  );
});

Deno.test("repeated application returns current config without overwriting later edits", async () => {
  const config = { business_profile_text: "Edited after application" };
  const db: SetupDb = {
    rpc: (name) => {
      assertEquals(name, "read_ai_website_setup");
      return Promise.resolve({
        data: { config, jobs: [{ id: "job", status: "applied", result }] },
        error: null,
      });
    },
  };
  assertEquals((await applySetup(db, "owner", request)).config, config);
});

Deno.test("a supplied future version cannot authorize a merge built from an older snapshot", async () => {
  const db: SetupDb = {
    rpc: (name) => {
      assertEquals(name, "read_ai_website_setup");
      return Promise.resolve({
        data: {
          config: { updated_at: "2026-09-06T09:00:00Z" },
          jobs: [{ id: "job", status: "ready", result }],
        },
        error: null,
      });
    },
  };
  await assertRejects(
    () => applySetup(db, "owner", request),
    SetupError,
    "Configuration changed",
  );
});
