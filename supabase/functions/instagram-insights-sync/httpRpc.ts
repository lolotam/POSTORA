/** PostgREST retries SQLSTATE 40001; deterministic job refusals must use non-retrying HTTP wrappers. */
const fencedHttpRpcs = new Map([
  ["persist_instagram_collection_snapshot", "persist_instagram_collection_snapshot_http"],
  ["record_instagram_collection_job_progress", "record_instagram_collection_job_progress_http"],
  ["complete_instagram_collection_job", "complete_instagram_collection_job_http"],
  ["record_instagram_provider_throttle", "record_instagram_provider_throttle_http"],
  ["read_instagram_direct_collection_credential", "read_instagram_direct_collection_credential_http"],
]);

export function ownerHttpRpcName(functionName: string): string {
  return fencedHttpRpcs.get(functionName) ?? functionName;
}

// Native SQL callers retain 40001; PostgREST callers receive the equivalent definitive HTTP conflict.
export function isStaleCollectionSqlstate(sqlstate: string | null): boolean {
  return sqlstate === "40001" || sqlstate === "PT409";
}
