// GET /v1/usage — quota and rate-limit visibility (Phase 10.1, deliverable 2.7).
//
// D7 class A — a bounded local read of the key's own counters. The charged
// total is the sum of the three buckets so a reservation cannot be hidden
// behind a different column; the meter is extensible so a second counter can
// be added without a field rename.
//
// The period is derived from last_reset_at in UTC via Date.UTC so a server in
// any timezone renders the same instant; local time would make the same row
// two periods under two zones.

import { v1ErrorResponse } from "./errors.ts";
import { v1JsonResponse } from "./respond.ts";
import type { V1AuthedContext } from "./authenticated.ts";

export async function getUsage(
  _req: Request,
  authed: V1AuthedContext,
): Promise<Response> {
  const { admin, record, requestId } = authed;

  const { data, error } = await admin
    .from("partner_api_keys")
    .select(
      "monthly_quota, rate_limit_per_min, usage_reserved, usage_confirmed, usage_indeterminate, current_usage_count, last_reset_at",
    )
    .eq("id", record.id)
    .maybeSingle();

  if (error) {
    return v1ErrorResponse("internal_error", requestId);
  }
  if (!data) {
    return v1ErrorResponse("internal_error", requestId);
  }

  const lastReset = new Date(data.last_reset_at as string);
  const startIso = lastReset.toISOString();
  const y = lastReset.getUTCFullYear();
  const m = lastReset.getUTCMonth();
  const endIso = new Date(Date.UTC(y, m + 1, 1)).toISOString();

  const body = {
    period: { start: startIso, end: endIso },
    meters: [
      {
        meter: "messages",
        limit: (data.monthly_quota as number | null) ?? null,
        reserved: data.usage_reserved as number,
        confirmed: data.usage_confirmed as number,
        indeterminate: data.usage_indeterminate as number,
        charged: data.current_usage_count as number,
      },
    ],
    rate_limit: { per_minute: data.rate_limit_per_min as number },
    request_id: requestId,
  };

  return v1JsonResponse(body, requestId);
}
