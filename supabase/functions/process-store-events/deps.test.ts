import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { WhatsAppOpError } from "../_shared/whatsappPartnerOps.ts";
import {
  classifyQrTextResult,
  classifySendError,
  optedOutFromLookup,
  optOutLookupPhone,
  storeBindingMatches,
} from "./deps.ts";

const event = {
  connector_id: "connector-1",
  social_account_id: "account-1",
  user_id: "user-1",
};
const binding = { ...event };

Deno.test("classifySendError and a QR send without a message id", () => {
  const timedOut = new Error("request timed out");
  const aborted = new Error("operation aborted");
  const denied = new Error("unauthorized");
  (denied as Error & { status: number }).status = 401;
  const upstream = new Error("upstream");
  (upstream as Error & { status: number }).status = 500;
  const cases: Array<{ name: string; outcome: { accepted: false; definite: boolean; reason?: string } | { accepted: true; messageId: string } }> = [
    {
      name: "WhatsAppOpError indeterminate",
      outcome: classifySendError(new WhatsAppOpError("maybe sent", "internal_error", 500, undefined, true)),
    },
    { name: "status 500", outcome: classifySendError(upstream) },
    { name: "timed out", outcome: classifySendError(timedOut) },
    { name: "aborted", outcome: classifySendError(aborted) },
    { name: "401", outcome: classifySendError(denied) },
    { name: "QR send without messageId", outcome: classifyQrTextResult(undefined) },
  ];
  const expected = [
    { accepted: false, definite: false },
    { accepted: false, definite: false },
    { accepted: false, definite: false },
    { accepted: false, definite: false },
    { accepted: false, definite: true, reason: "unauthorized" },
    { accepted: false, definite: false },
  ];
  cases.forEach((item, index) => {
    assertEquals(item.outcome, expected[index], item.name);
  });
  assertEquals(classifyQrTextResult("wamid.1"), { accepted: true, messageId: "wamid.1" });
});

Deno.test("store binding must match the event connector, account, and user", () => {
  const cases: Array<{ name: string; binding: typeof binding | null; matches: boolean }> = [
    { name: "match", binding, matches: true },
    { name: "null", binding: null, matches: false },
    { name: "connector", binding: { ...binding, connector_id: "other" }, matches: false },
    { name: "account", binding: { ...binding, social_account_id: "other" }, matches: false },
    { name: "user", binding: { ...binding, user_id: "other" }, matches: false },
  ];
  for (const item of cases) {
    assertEquals(storeBindingMatches(item.binding, event), item.matches, item.name);
  }
});

Deno.test("opt-out lookup runs only for a phone the event named", () => {
  const cases: Array<{ name: string; phone: string | undefined; row: unknown; lookup: string | null; optedOut: boolean }> = [
    { name: "row for the phone", phone: "96555512345", row: { user_id: "user-1" }, lookup: "96555512345", optedOut: true },
    { name: "no row", phone: "96555512345", row: null, lookup: "96555512345", optedOut: false },
    { name: "missing phone", phone: undefined, row: { user_id: "user-1" }, lookup: null, optedOut: false },
    { name: "empty phone", phone: "", row: { user_id: "user-1" }, lookup: null, optedOut: false },
  ];
  for (const item of cases) {
    const lookup = optOutLookupPhone(item.phone);
    assertEquals(lookup, item.lookup, item.name);
    assertEquals(optedOutFromLookup(lookup, item.row), item.optedOut, item.name);
  }
});
