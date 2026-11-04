/**
 * The closed Kuwait days whose daily observation the owner history keeps
 * complete, counted back from the last closed day.
 *
 * The sync worker collects these days; the owner report counts them as the
 * days "all time" expects, so a day the worker has not collected yet shows as
 * missing instead of being left out of the period.
 *
 * Meta keeps account insights for two years
 * (docs/specs/2026-10-26-instagram-insights-and-competitor-tracking.md), so
 * a year of history is inside what the provider can still answer.
 */
export const ACCOUNT_DAY_HISTORY_DAYS = 365;
