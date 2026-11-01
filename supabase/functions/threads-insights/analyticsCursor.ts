// Preserve the Threads cursor API and signing namespace while sharing the bounded codec with Facebook.
export {
  AnalyticsCursorError, analyticsCursorScope, decodeAnalyticsCursor, encodeAnalyticsCursor,
  type AnalyticsCursorScope, type AnalyticsCursorPosition,
} from "../_shared/metaAnalyticsCursor.ts";
