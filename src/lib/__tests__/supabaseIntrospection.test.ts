import { describe, expect, it, vi } from "vitest";
import {
  fetchSupabaseIntrospection,
  fetchTableColumns,
  parseOpenApiDocument,
  TableListUnavailableError,
} from "@/lib/supabaseIntrospection";

// The shape a real PostgREST root answers with, cut down to what the parser
// reads. Captured from a live Supabase project, not invented.
const OPENAPI_DOC = {
  swagger: "2.0",
  paths: {
    "/": { get: {} },
    "/price_table": { get: {} },
    "/orders": { get: {} },
    "/rpc/refresh_prices": { post: {} },
  },
  definitions: {
    price_table: {
      properties: {
        id: { type: "string" },
        type_name: { type: "string" },
        price: { type: "string" },
        image_url: { type: "string" },
      },
    },
    orders: {
      properties: { id: { type: "integer" }, total: { type: "number" } },
    },
  },
};

describe("parseOpenApiDocument", () => {
  it("lists tables from paths, excluding the root and RPC functions", () => {
    // RPC paths are refused by the adapter, so offering them would sell
    // something unusable.
    expect(parseOpenApiDocument(OPENAPI_DOC).tables).toEqual(["orders", "price_table"]);
  });

  it("maps each table to its columns", () => {
    const { columnsByTable } = parseOpenApiDocument(OPENAPI_DOC);
    expect(columnsByTable.price_table).toEqual(["id", "type_name", "price", "image_url"]);
    expect(columnsByTable.orders).toEqual(["id", "total"]);
  });

  it("degrades an unrecognised document to empty lists, not a throw", () => {
    // The card falls back to free text; a parser throw would break the form.
    for (const document of [null, "html error page", 42, {}, { paths: "?" }]) {
      expect(parseOpenApiDocument(document)).toEqual({ tables: [], columnsByTable: {} });
    }
  });
});

describe("fetchSupabaseIntrospection", () => {
  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });

  it("sends the anon key and the schema profile", async () => {
    let captured: Request | null = null;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input, init);
      return jsonResponse(OPENAPI_DOC);
    });

    const result = await fetchSupabaseIntrospection(
      "https://proj.supabase.co/",
      "anon-key-1",
      "public",
      fetcher as unknown as typeof fetch,
    );
    expect(result.tables).toContain("price_table");
    expect(captured!.url).toBe("https://proj.supabase.co/rest/v1/");
    expect(captured!.headers.get("apikey")).toBe("anon-key-1");
    expect(captured!.headers.get("Accept-Profile")).toBe("public");
  });

  it("explains a refused key rather than surfacing a bare status", async () => {
    const fetcher = async () => new Response("", { status: 401 });
    await expect(
      fetchSupabaseIntrospection("https://p.co", "bad", "public", fetcher as typeof fetch),
    ).rejects.toThrow(/anon key/);
  });

  it("names the schema when the project does not expose it", async () => {
    const fetcher = async () => new Response("", { status: 406 });
    await expect(
      fetchSupabaseIntrospection("https://p.co", "k", "privates", fetcher as typeof fetch),
    ).rejects.toThrow(/"privates" is not exposed/);
  });

  it("treats an empty table list as a schema problem, not success", async () => {
    // Rendering an empty dropdown reads as "your project has no tables".
    const fetcher = async () => jsonResponse({ paths: { "/": {} }, definitions: {} });
    await expect(
      fetchSupabaseIntrospection("https://p.co", "k", "public", fetcher as typeof fetch),
    ).rejects.toThrow(/No tables are exposed/);
  });

  it("turns a network failure into a CORS-aware message", async () => {
    const fetcher = async () => {
      throw new TypeError("Failed to fetch");
    };
    await expect(
      fetchSupabaseIntrospection("https://p.co", "k", "public", fetcher as typeof fetch),
    ).rejects.toThrow(/CORS/);
  });
});

// ---------------------------------------------------------------------------
// Supabase Cloud gates the OpenAPI root to the service_role key. Discovered in
// production (2026-09-01): a provably working anon key -- the same key the
// connector reads price_table with, HTTP 200 -- got 401 from the root with
// {"hint":"Only the `service_role` API key can be used for this endpoint."}
// The old code blamed the operator's key, sending them hunting a typo that
// did not exist. Columns are instead learned per named table, from one sample
// row -- the same read the connector itself performs.
// ---------------------------------------------------------------------------

describe("service_role-gated projects", () => {
  it("a service_role-gated 401 is TableListUnavailable, not a bad key", async () => {
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          message: "Invalid API key",
          hint: "Only the `service_role` API key can be used for this endpoint.",
        }),
        { status: 401 },
      );
    await expect(
      fetchSupabaseIntrospection("https://p.co", "valid-anon", "public", fetcher as typeof fetch),
    ).rejects.toBeInstanceOf(TableListUnavailableError);
  });

  it("a plain 401 still blames the key", async () => {
    const fetcher = async () => new Response(JSON.stringify({ message: "Invalid API key" }), { status: 401 });
    await expect(
      fetchSupabaseIntrospection("https://p.co", "bad", "public", fetcher as typeof fetch),
    ).rejects.toThrow(/Check the key/);
  });
});

describe("fetchTableColumns", () => {
  it("derives the columns from one sample row", async () => {
    let captured = "";
    const fetcher = async (input: RequestInfo | URL) => {
      captured = String(input);
      return new Response(
        JSON.stringify([{ id: "1", type_name: "كتاكيت جميزة", price: "١٨ جنية" }]),
        { status: 200 },
      );
    };
    const columns = await fetchTableColumns(
      "https://p.co/",
      "anon-1",
      "public",
      "price_table",
      fetcher as typeof fetch,
    );
    expect(columns).toEqual(["id", "type_name", "price"]);
    expect(captured).toBe("https://p.co/rest/v1/price_table?limit=1");
  });

  it("an empty table is named and explained, not returned as zero columns", async () => {
    // RLS returning nothing here means the connector would also see nothing.
    const fetcher = async () => new Response("[]", { status: 200 });
    await expect(
      fetchTableColumns("https://p.co", "k", "public", "empty_table", fetcher as typeof fetch),
    ).rejects.toThrow(/empty, or hidden by RLS/);
  });

  it("a missing table names the table and the schema", async () => {
    const fetcher = async () => new Response("", { status: 404 });
    await expect(
      fetchTableColumns("https://p.co", "k", "public", "typo_table", fetcher as typeof fetch),
    ).rejects.toThrow(/"typo_table" was not found in schema "public"/);
  });
});
