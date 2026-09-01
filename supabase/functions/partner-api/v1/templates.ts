// GET /v1/templates — the approved template catalogue (deliverable 3.7).
//
// D7 risk class **B**: it makes an outbound Meta Graph call, so it fails
// CLOSED on a limiter outage. That is enforced in `withPartnerAuth`, which
// passes the class straight to `checkRateLimit` — class B raises rather than
// proceeding when the limiter cannot resolve a budget, because an unbounded
// outbound call during a database incident is how one outage becomes two.
//
// Convergence with the alias's `list_templates` action (D1): both doors call
// the SAME `listTemplates`, and both inherit the same scope and risk class
// from `ACTION_SCOPES` / `ACTION_RISK_CLASSES`. What they do NOT share is the
// response envelope — the alias keeps `{success:true, …}` and /v1 answers a
// bare resource, deliberately (D2).

import { listTemplates } from "../../_shared/whatsappPartnerOps.ts";
import { v1ErrorResponse } from "./errors.ts";
import { resolveWhatsAppAccount, type V1AuthedContext } from "./authenticated.ts";

export async function getTemplates(
  _req: Request,
  authed: V1AuthedContext,
): Promise<Response> {
  const { requestId } = authed;

  const account = await resolveWhatsAppAccount(authed);
  if (!account.ok) return account.res;

  if (!account.wabaId) {
    // Same verdict the alias gives: without a WABA id there is no catalogue
    // to read, and that is a connection problem, not a request problem.
    return v1ErrorResponse("account_not_connected", requestId, {
      message: "No WABA id recorded for this account",
    });
  }

  const templates = await listTemplates(account.ctx, account.wabaId);

  // Cursor pagination is documented (§7.1) but Meta's template listing is
  // returned whole here, so there is no next page to name. `next_cursor: null`
  // states that positively rather than omitting the field, so a client can
  // write one pagination loop that terminates correctly on this endpoint too.
  return new Response(
    JSON.stringify({ data: templates, next_cursor: null }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-Postora-Request-Id": requestId,
      },
    },
  );
}

/** Surfaced for the route table's error path; kept beside the handler so a
 *  future paginated version cannot forget it. */
export const templatesInternalError = (requestId: string) =>
  v1ErrorResponse("internal_error", requestId);
