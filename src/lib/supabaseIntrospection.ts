// What a Supabase project will tell a browser that holds its anon key.
//
// PostgREST's root endpoint (`GET {project_url}/rest/v1/`) answers with an
// OpenAPI document whose `paths` are the exposed tables and whose
// `definitions` carry each table's columns — one request feeds both the
// table picker and the column picker in the connector card.
//
// Two limits shape the callers of this module:
// - Schemas are NOT enumerable with an anon key. Only schemas the project
//   owner exposed are reachable at all, so "which schemas exist" cannot be a
//   fetched list; the card suggests `public` and validates by whether this
//   fetch succeeds under the schema the user typed (`Accept-Profile`).
// - The anon key is never returned to the browser for a saved connector
//   (blank means keep-existing), so introspection only works while a key is
//   present in the form. Without one the card falls back to free text.

export interface SupabaseIntrospection {
  tables: string[];
  columnsByTable: Record<string, string[]>;
}

/**
 * The tables and columns in a PostgREST OpenAPI document.
 *
 * Tolerant on purpose: a shape this parser does not recognise yields empty
 * lists rather than a throw, so a PostgREST version that reshapes the
 * document degrades the card to free text instead of breaking the form.
 */
export function parseOpenApiDocument(document: unknown): SupabaseIntrospection {
  if (typeof document !== "object" || document === null) {
    return { tables: [], columnsByTable: {} };
  }
  const { paths, definitions } = document as { paths?: unknown; definitions?: unknown };

  const tables: string[] = [];
  if (typeof paths === "object" && paths !== null) {
    for (const path of Object.keys(paths)) {
      // "/" is the root itself; "/rpc/..." are functions, which the adapter
      // refuses anyway — offering them here would sell something unusable.
      if (path === "/" || path.startsWith("/rpc/")) continue;
      const table = path.replace(/^\//, "");
      if (table) tables.push(table);
    }
  }
  tables.sort((a, b) => a.localeCompare(b));

  const columnsByTable: Record<string, string[]> = {};
  if (typeof definitions === "object" && definitions !== null) {
    for (const [table, definition] of Object.entries(definitions as Record<string, unknown>)) {
      if (typeof definition !== "object" || definition === null) continue;
      const { properties } = definition as { properties?: unknown };
      if (typeof properties !== "object" || properties === null) continue;
      columnsByTable[table] = Object.keys(properties);
    }
  }

  return { tables, columnsByTable };
}

/**
 * Fetches the OpenAPI document with the user's own anon key, from the
 * browser. Deliberately not proxied through an edge function: the key is
 * already a browser credential on the target project, the card needs the
 * answer at the moment the user typed it, and a server proxy would add an
 * SSRF surface for zero gain.
 */
export async function fetchSupabaseIntrospection(
  projectUrl: string,
  anonKey: string,
  schema: string,
  fetcher: typeof fetch = fetch,
): Promise<SupabaseIntrospection> {
  const base = projectUrl.trim().replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetcher(`${base}/rest/v1/`, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        // How PostgREST selects a non-default schema for GETs. For "public"
        // it is a no-op, so it is always sent rather than special-cased.
        "Accept-Profile": schema.trim() || "public",
      },
    });
  } catch {
    throw new Error(
      "Could not reach the project. Check the URL — and if it is self-hosted, its CORS settings.",
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("The project refused the anon key. Check the key and try again.");
  }
  if (response.status === 406) {
    // PostgREST's answer to an unexposed schema via Accept-Profile.
    throw new Error(`Schema "${schema}" is not exposed by this project. Try "public".`);
  }
  if (!response.ok) {
    throw new Error(`The project answered HTTP ${response.status}.`);
  }
  const parsed = parseOpenApiDocument(await response.json().catch(() => null));
  if (parsed.tables.length === 0) {
    throw new Error(
      `No tables are exposed in schema "${schema}". Check the schema name and the project's API settings.`,
    );
  }
  return parsed;
}
