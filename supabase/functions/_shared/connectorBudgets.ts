// Time and size ceilings shared by the connector CALLER (ai-agent-reply) and the
// connector CALLEE (ai-agent-adapters).
//
// They live in _shared because both sides need the same numbers and they are
// deployed as SEPARATE edge functions. Declaring them in the caller and
// importing across would pull ai-agent-reply's module graph — composio, tools,
// telemetry — into the adapters function's bundle, coupling two independently
// deployed workers for the sake of two integers.

/** Every non-Supabase vendor's caller ceiling. Unchanged. */
export const ADAPTER_CALL_TIMEOUT_MS = 6_000;

/**
 * Supabase pages through several PostgREST requests inside ONE tool call, so a
 * caller ceiling below the callee's own deadline aborts the loop mid-flight and
 * discards rows already fetched. Supabase alone gets a taller ceiling.
 */
export const SUPABASE_CALL_TIMEOUT_MS = 12_000;

/** Wall-clock ceiling for the adapter's whole page loop, inside the above. */
export const SUPABASE_LOOP_BUDGET_MS = 8_000;

/**
 * A hop is never started with less than this left, so the loop cannot overrun
 * its caller by beginning a request it has no time to finish.
 */
export const SUPABASE_MIN_HOP_MS = 1_500;

/** Every vendor's reply-side serialization cap. Unchanged. */
export const ADAPTER_OUTPUT_LIMIT = 8_000;

/**
 * The Supabase envelope can legitimately run to the adapter's own 60k
 * character budget, so its reply-side backstop sits proportionally higher.
 * Serializing at the generic 8000 cut a paged envelope mid-JSON -- the exact
 * 2026-09-01 incident this family of constants exists to prevent.
 */
export const SUPABASE_ADAPTER_OUTPUT_LIMIT = 80_000;
