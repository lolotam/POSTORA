import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { CONNECTOR_TYPES as PICKER_CONNECTOR_TYPES } from "../../hooks/useAiAgentTools";
import { CONNECTOR_TYPES as BROWSER_CONNECTOR_TYPES } from "../connectorRegistry";
import {
  CONNECTOR_TYPES as SHARED_CONNECTOR_TYPES,
  SERVER_CONNECTOR_TYPES,
} from "../../../supabase/functions/_shared/connectorRegistry.ts";

const EXPECTED_CONNECTOR_TYPES = [
  "custom_rest",
  "formula",
  "higgsfield",
  "mcp_custom",
  "myfatoorah",
  "mysql_postgres",
  "salla",
  "shopify",
  "stripe",
  "supabase",
  "woocommerce",
  "zid",
];

// Emptied by PR-3's Migration A. While it is non-empty, these four types
// exist in the registry and the picker but the CHECK constraint would
// reject them -- which is exactly why PR-4 must not start returning them
// before that migration is applied.
const PENDING_DB_TYPES = ["higgsfield", "mcp_custom", "myfatoorah", "stripe"];

function sorted(types: readonly string[]): string[] {
  return [...types].sort();
}

function connectorTypesFromMigration(): string[] {
  // This is currently the only migration that defines the connector_type
  // CHECK. If a later migration rewrites it, this fixture must read the last
  // such migration so the assertion describes the effective DB contract.
  const migration = readFileSync(
    resolve(
      process.cwd(),
      "supabase/migrations/20260825120000_ai_agent_tools_connector_fields.sql",
    ),
    "utf8",
  );
  const check = migration.match(/CHECK\s*\(connector_type\s+IN\s*\(\s*([\s\S]*?)\s*\)\)/i);

  if (!check) {
    throw new Error("connector_type CHECK list not found in migration");
  }

  return [...check[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

describe("connector type contract", () => {
  it("keeps the picker, browser mirror, and shared registry on the same twelve ids", () => {
    expect(sorted(PICKER_CONNECTOR_TYPES)).toEqual(EXPECTED_CONNECTOR_TYPES);
    expect(sorted(BROWSER_CONNECTOR_TYPES)).toEqual(EXPECTED_CONNECTOR_TYPES);
    expect(sorted(SHARED_CONNECTOR_TYPES)).toEqual(EXPECTED_CONNECTOR_TYPES);
  });

  it("keeps the database subset declared and its pending gap exact", () => {
    const dbTypes = sorted(connectorTypesFromMigration());
    const registryTypes = sorted(SHARED_CONNECTOR_TYPES);

    expect(dbTypes.every((type) => registryTypes.includes(type))).toBe(true);
    expect(registryTypes.filter((type) => !dbTypes.includes(type))).toEqual(PENDING_DB_TYPES);
  });

  it("never lets the server accept a type the database would reject", () => {
    // SERVER_CONNECTOR_TYPES is derived by subtracting the registry's own
    // PENDING_DB_CONNECTOR_TYPES, and nothing above ties that constant to the
    // migration. Without this, a wrong entry there would widen the allow-list
    // in ai_upsert_tool and turn today's silent downgrade into a constraint
    // violation on save -- a 500 where there is currently a wrong-but-working
    // row. This is the assertion that makes the derivation safe, and it is
    // what must go green again when PR-3 empties the constant.
    expect(sorted(SERVER_CONNECTOR_TYPES)).toEqual(sorted(connectorTypesFromMigration()));
  });
});
