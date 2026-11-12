# AI agent quality for curemedkw — design

Date: 2026-11-12 · Owner: Waleed · Status: decisions locked, catalog details pending

## 1. Problem (evidence from the live conversation review)

1. Arabic product knowledge is mojibake: 202 of 297 chunks of `products_rows.csv` and all 5
   chunks of `categories_rows.csv` were stored as Latin-1 text (`Ø§Ù„Ø¹...`). The CSV is parsed by
   SheetJS (`parsing.ts` L91) without a UTF-8 codepage. Arabic questions ("كريم الكعب") miss.
2. No product page links: the file carries image URLs only; the agent answered "غير متوفر".
3. Greeting is a prompt instruction the model ignores.
4. Model chain: gemini-3.8-flash fails every call, nemotron `:free` times out (33 s),
   `typesafe-ai/jev` returns 403; the primary changed three times during testing.
5. `curemedkw_supabase_catalog` tool was called with empty filters and concluded "not found".
6. After an escalation the conversation sits 240 min in human mode with no acknowledgement.
7. An image reply came back in English in an Arabic conversation.

## 2. Owner decisions (2026-11-12)

| Topic | Decision |
|---|---|
| Product facts | Live catalog DB first, re-ingested CSV knowledge as fallback |
| Product link | Stored `product_url` column in the catalog (`https://curemedkw.com/<brand>/product/<slug>`), copied verbatim, never invented |
| Greeting | Fixed in code on the first message of a conversation: "وعليكم السلام ورحمة الله، أهلاً بك في كيور ميد 🌿 كيف نقدر نساعدك؟"; English mirror for English first messages; any question in the same message is still answered |
| Reply language | Language of the customer's latest message (Arabic script → Arabic), enforced in code for text, image and vision replies |
| Models | Dry-run table first (same real conversation, 5–6 models, nothing sent); owner picks primary + fallback |
| Not found | Retry with a looser query (AR/EN synonyms, brand); then ask for name or photo; hand off only on explicit request or after two failed searches |
| Human mode | One fixed acknowledgement the first time the customer writes during human mode, then silence until staff replies |
| Escalation timeout field | Stays active in AI First and Human then AI fallback, hidden in Human First; help text explains it per mode (done, `dbdb44d4`) |
| History window | 14 rows (seven customer messages with replies) instead of 6 (done, `6663fb3f`) |
| After the timeout expires | The system checks itself whether a staff member replied after the escalation. If none did, the first AI reply opens with an apology for the delay and then answers; if one did, the AI continues with that staff reply in its context. The customer is never asked something the system can know |
| Catalog data side | Owned by the curemedkw project: view `agent_catalog_products` (with computed `product_url`, `price_hidden`, `shopping_enabled`, `category_slugs`, `tags`) and RPC `agent_search_products(q, max_results)` with Arabic normalisation and pg_trgm ranking, over the anon key at `https://supabase.curemedkw.com`. Live after owner approval of their schema release |

## 3. Design

- **CSV UTF-8 (fallback path).** Decode CSV bytes as UTF-8 (BOM-aware) before SheetJS; re-ingest
  the two curemedkw files; regression test with an Arabic fixture.
- **Catalog tool.** Require a non-empty query; search AR + EN names with trigram similarity;
  return `product_url`, price, stock; on zero rows, one loosened retry before reporting none.
  Exact table, columns and connection are being confirmed with the curemedkw project
  (T3-Curemedkw-Manager); DB-side changes (column, backfill, indexes, read-only role) belong there.
- **Greeting / language / human-mode acknowledgement.** Deterministic steps in
  `ai-agent-reply` before and after the model call, each with a unit test.
- **Model chain.** A dry-run script replays a recorded conversation against candidate models and
  writes a comparison table (latency, language correctness, catalog-grounded answer). No sends.

- **Answer instead of escalating.** Escalation mostly happens when retrieval misses, so the
  fix is retrieval, not the timeout: the catalog RPC above, the UTF-8 re-ingest, and the
  retry-then-ask rule. The prompt tells the model to escalate only on an explicit request or
  after two failed searches.
- **Post-escalation apology.** When an expired escalation row exists and no outbound staff
  message is stored after its start, prepend a fixed apology line in the reply language. Staff
  replies sent from the inbox are included in the replayed history. Exact source table for
  staff outbound messages to be confirmed in the plan.

## 4. Out of scope

Changing the curemedkw catalog schema from this repo; turning on subscription (OAuth) tiers.
