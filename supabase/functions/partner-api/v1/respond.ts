// The one builder of a /v1 SUCCESS response, mirroring errors.ts for the
// failure side (deliverable 2.3).
//
// It exists for the same reason `v1ErrorResponse` does: a response header set
// that is spelled out at each call site drifts one call site at a time. The
// header that matters is X-Postora-Request-Id — it is the only handle a
// partner has when they report "this call returned the wrong thing", and a
// success path that forgets it is exactly the case where they most need it,
// because nothing in the body says which request produced it.
//
// `withPartnerAuth` appends the X-RateLimit-* headers afterwards and does not
// overwrite what a handler already set, so those are deliberately absent here.

export function v1JsonResponse(
  body: unknown,
  requestId: string,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Postora-Request-Id": requestId,
    },
  });
}

/**
 * The collection envelope every /v1 listing returns.
 *
 * `next_cursor` is always present and explicitly null on the last page,
 * never omitted. A client writes one loop — "call again while next_cursor is
 * not null" — and it terminates correctly on every listing, including the
 * ones that are never paginated. Omitting the field on those would make
 * `undefined` and "no more pages" the same value, which is fine in JavaScript
 * and wrong in every language with a distinction.
 */
export function v1Collection<T>(
  data: T[],
  nextCursor: string | null,
  requestId: string,
): Response {
  return v1JsonResponse({ data, next_cursor: nextCursor }, requestId);
}
