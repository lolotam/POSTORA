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

/**
 * The quota period a read should render.
 *
 * last_reset_at advances only when a send RESERVES, so a read that arrives in
 * a new calendar month before the first send would otherwise report the
 * period that just ended — with its exhausted counters — as if it were
 * current. A read must not write, so the row is not reset; it is rendered
 * the way the next reservation will reset it: the current UTC month, empty
 * (`stale`). Date.UTC throughout, so the same row is one period in every
 * server timezone.
 */
export function usagePeriodFor(
  lastResetAt: Date,
  now: Date,
): { start: string; end: string; stale: boolean } {
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const stale = lastResetAt < currentMonthStart;
  const start = stale ? currentMonthStart : lastResetAt;
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString(), stale };
}

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

  const period = usagePeriodFor(new Date(data.last_reset_at as string), new Date());
  const counter = (column: string) => period.stale ? 0 : data[column] as number;

  const body = {
    period: { start: period.start, end: period.end },
    meters: [
      {
        meter: "messages",
        limit: (data.monthly_quota as number | null) ?? null,
        reserved: counter("usage_reserved"),
        confirmed: counter("usage_confirmed"),
        indeterminate: counter("usage_indeterminate"),
        charged: counter("current_usage_count"),
      },
    ],
    rate_limit: { per_minute: data.rate_limit_per_min as number },
    request_id: requestId,
  };

  return v1JsonResponse(body, requestId);
}
