import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { readCatalogue } from "./readCatalogue.ts";

for (const failLater of [false, true]) {
  Deno.test(`edge catalogue reads beyond a capped page, later failure=${failLater}`, async () => {
    const catalogue = Array.from({ length: 1205 }, (_, index) => ({ id: String(index), name: 'Same name',
      model_id: `model-${index}`, auth_method: index % 2 ? 'oauth' : 'api_key' }));
    const admin = createClient('https://database.example.test', crypto.randomUUID(), { global: { fetch: (async input => {
      const url = new URL(String(input));
      const offset = Number(url.searchParams.get('offset') ?? 0);
      if (failLater && offset > 0) return Response.json({ message: 'unavailable' }, { status: 503 });
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 1000), 173);
      return Response.json(catalogue.slice(offset, offset + limit));
    }) as typeof fetch } });
    if (failLater) { await assertRejects(() => readCatalogue(admin)); return; }
    const groups = await readCatalogue(admin);
    assertEquals(groups.models.length, 603);
    assertEquals(groups.oauthModels.length, 602);
    assertEquals(groups.models.at(-1)?.model_id, 'model-1204');
  });
}
