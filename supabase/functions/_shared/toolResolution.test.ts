import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveToolsForAccount, type ResolvableTool } from "./toolResolution.ts";

// Which connectors one conversation may call.
//
// Until PR-5 ai-agent-reply loaded every tool the USER owned, so account A's
// WooCommerce store answered account B's customers. Scoping the table in
// Migration A changed nothing on its own -- this predicate is what makes it
// real, and the cross-account case below is the gate for the whole PR.

const tool = (over: Partial<ResolvableTool> & { id: string; name: string }): ResolvableTool => ({
  description: "d",
  url: "https://example.test/hook",
  secret: null,
  admin_only: false,
  scope: "account",
  social_account_id: null,
  connector_type: "custom_rest",
  ...over,
});

const ACCOUNT = "acc-a";
const OTHER = "acc-b";

Deno.test("an all_accounts connector resolves for every account", () => {
  const shared = tool({ id: "t1", name: "woo", scope: "all_accounts" });
  assertEquals(
    resolveToolsForAccount([shared], [], ACCOUNT).tools.map((t) => t.id),
    ["t1"],
  );
});

Deno.test("another account's connector does not resolve — the gate for this PR", () => {
  // The defect this whole change exists to close: one login with several
  // connected pages had every page's agent answering out of every other page's
  // store.
  const theirs = tool({ id: "t1", name: "woo", social_account_id: OTHER });
  assertEquals(resolveToolsForAccount([theirs], [], ACCOUNT).tools, []);
});

Deno.test("an account's own connector resolves", () => {
  const mine = tool({ id: "t1", name: "woo", social_account_id: ACCOUNT });
  assertEquals(resolveToolsForAccount([mine], [], ACCOUNT).tools.map((t) => t.id), ["t1"]);
});

Deno.test("a connector shared through the link table resolves", () => {
  const theirs = tool({ id: "t1", name: "woo", social_account_id: OTHER });
  const links = [{ tool_id: "t1", social_account_id: ACCOUNT }];
  assertEquals(resolveToolsForAccount([theirs], links, ACCOUNT).tools.map((t) => t.id), ["t1"]);
});

Deno.test("a link belonging to a different account is not a grant", () => {
  const theirs = tool({ id: "t1", name: "woo", social_account_id: OTHER });
  const links = [{ tool_id: "t1", social_account_id: "acc-c" }];
  assertEquals(resolveToolsForAccount([theirs], links, ACCOUNT).tools, []);
});

Deno.test("the account's own tool wins a name collision, and the loser is reported", () => {
  // §12.3 layer 2. A Map keyed by name silently keeps the LAST row, so without
  // this the model is handed two functions with one name -- behaviour no
  // provider defines, and a coin flip over which store is queried.
  const mine = tool({ id: "own", name: "woo", social_account_id: ACCOUNT });
  const shared = tool({ id: "glob", name: "woo", scope: "all_accounts" });

  const bothOrders = [
    resolveToolsForAccount([shared, mine], [], ACCOUNT),
    resolveToolsForAccount([mine, shared], [], ACCOUNT),
  ];
  for (const outcome of bothOrders) {
    assertEquals(outcome.tools.map((t) => t.id), ["own"]);
    assertEquals(outcome.droppedDuplicates, [
      { name: "woo", kept_tool_id: "own", dropped_tool_id: "glob" },
    ]);
  }
});

Deno.test("an explicitly linked tool beats an all_accounts one of the same name", () => {
  // Linked is a deliberate choice about THIS account; all_accounts is inherited.
  // The more specific configuration wins, the same way scope='account' does.
  const linked = tool({ id: "link", name: "woo", social_account_id: OTHER });
  const shared = tool({ id: "glob", name: "woo", scope: "all_accounts" });
  const links = [{ tool_id: "link", social_account_id: ACCOUNT }];

  const outcome = resolveToolsForAccount([shared, linked], links, ACCOUNT);
  assertEquals(outcome.tools.map((t) => t.id), ["link"]);
});

Deno.test("two connectors of the same TYPE but different names both survive", () => {
  // The collision rule is about the function NAME the model is handed, not the
  // vendor. A shared wholesale store and an owned retail store are two callable
  // functions; dropping one because both are WooCommerce would delete a working
  // connector nobody asked to remove.
  const retail = tool({ id: "r", name: "woo_retail", social_account_id: ACCOUNT, connector_type: "woocommerce" });
  const wholesale = tool({ id: "w", name: "woo_wholesale", scope: "all_accounts", connector_type: "woocommerce" });

  const outcome = resolveToolsForAccount([retail, wholesale], [], ACCOUNT);
  assertEquals(outcome.tools.map((t) => t.id).sort(), ["r", "w"]);
  assertEquals(outcome.droppedDuplicates, []);
});

Deno.test("a null or unmatched account still resolves the all_accounts corpus", () => {
  // The sandbox passes the literal "test" when a caller names no account, so
  // this runs with an id that matches nothing. It must degrade, never throw:
  // an exception here kills the reply for a customer.
  const shared = tool({ id: "t1", name: "woo", scope: "all_accounts" });
  const owned = tool({ id: "t2", name: "cal", social_account_id: ACCOUNT });

  assertEquals(resolveToolsForAccount([shared, owned], [], null).tools.map((t) => t.id), ["t1"]);
  assertEquals(resolveToolsForAccount([shared, owned], [], "test").tools.map((t) => t.id), ["t1"]);
});

Deno.test("ordering is stable so two identical calls send the same tools array", () => {
  // The tools array is part of the prompt. An unstable order would change the
  // request bytes between turns for no reason, defeating prompt caching.
  const tools = [
    tool({ id: "b", name: "beta", scope: "all_accounts" }),
    tool({ id: "a", name: "alpha", social_account_id: ACCOUNT }),
  ];
  assertEquals(
    resolveToolsForAccount(tools, [], ACCOUNT).tools.map((t) => t.name),
    resolveToolsForAccount([...tools].reverse(), [], ACCOUNT).tools.map((t) => t.name),
  );
});
