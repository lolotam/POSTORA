import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { CONNECTOR_TYPES as PICKER_CONNECTOR_TYPES } from "../../hooks/useAiAgentTools";
import {
  CONNECTOR_TYPES as BROWSER_CONNECTOR_TYPES,
  connectorDefinition as browserConnectorDefinition,
  shouldUseAdapter as browserShouldUseAdapter,
} from "../connectorRegistry";
import {
  CONNECTOR_TYPES as SHARED_CONNECTOR_TYPES,
  connectorDefinition as sharedConnectorDefinition,
  SERVER_CONNECTOR_TYPES,
  shouldUseAdapter as sharedShouldUseAdapter,
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

// Emptied by PR-3's Migration A (20260831130000_connector_scope_and_sharing.sql),
// which rebuilt the DB connector_type CHECK with all twelve registry types.
// While it was non-empty, those four types existed in the registry and the
// picker but the CHECK rejected them -- which was exactly why PR-4 had to
// wait for the migration before returning them. The gap is history: registry,
// picker, allow-list and CHECK now name the same twelve. Kept so a future
// type can be staged here again while its migration is pending.
const PENDING_DB_TYPES: string[] = [];

function sorted(types: readonly string[]): string[] {
  return [...types].sort();
}

let migrationTypesCache: string[] | undefined;

function connectorTypesFromMigration(): string[] {
  if (migrationTypesCache) return migrationTypesCache;
  // A CHECK cannot be altered in place, so every widening of the
  // connector_type list is a new migration that drops and recreates it. The
  // effective DB contract is therefore defined by the LAST migration that
  // writes it -- reading any earlier one would describe a contract that no
  // longer exists (20260825120000 held eight types until PR-3's Migration A
  // replaced them with twelve).
  const migrationsDir = resolve(process.cwd(), "supabase/migrations");
  const checkPattern = /CHECK\s*\(connector_type\s+IN\s*\(\s*([\s\S]*?)\s*\)\)/i;

  // Newest first, stopping at the first match. The eager .map() this replaces
  // read EVERY migration into memory before filtering, twice -- once per test.
  // Alone that costs milliseconds; running beside 157 other test files it blew
  // vitest's 5s limit and failed the suite intermittently while passing in
  // isolation, which is the worst shape a test can have.
  const names = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .reverse();

  let lastDefining: { name: string; content: string } | undefined;
  for (const name of names) {
    const content = readFileSync(resolve(migrationsDir, name), "utf8");
    if (checkPattern.test(content)) {
      lastDefining = { name, content };
      break;
    }
  }

  if (!lastDefining) {
    throw new Error("no migration defines the connector_type CHECK");
  }

  const check = lastDefining.content.match(checkPattern);

  if (!check) {
    throw new Error(`connector_type CHECK list not found in ${lastDefining.name}`);
  }

  migrationTypesCache = [...check[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  return migrationTypesCache;
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
    // in ai_upsert_tool and turn the old silent downgrade into a constraint
    // violation on save -- a 500 where there was a wrong-but-working row.
    // This assertion is what made the derivation safe, and it is what goes
    // green again whenever a future pending type re-populates the constant.
    expect(sorted(SERVER_CONNECTOR_TYPES)).toEqual(sorted(connectorTypesFromMigration()));
  });
});

describe("browser mirror parity", () => {
  // The mirror is hand-maintained by design (Deno and the browser cannot
  // share the runtime module), so every fact the UI derives from it must be
  // pinned against the shared registry or it drifts silently: the credential
  // form renders from the mirror's fields and the Test-connection button is
  // derived from the mirror's capabilities, so a mirror that lags a new
  // registry entry ships a form that cannot configure the new connector.
  it("defines every connector identically to the shared registry", () => {
    for (const type of SHARED_CONNECTOR_TYPES) {
      expect(browserConnectorDefinition(type)).toEqual(sharedConnectorDefinition(type));
    }
  });

  it("agrees with the shared registry on which types have a live adapter", () => {
    for (const type of SHARED_CONNECTOR_TYPES) {
      expect(browserShouldUseAdapter({ connector_type: type }))
        .toBe(sharedShouldUseAdapter({ connector_type: type }));
    }
  });
});
