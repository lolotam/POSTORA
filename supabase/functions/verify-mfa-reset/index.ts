import { restrictedCorsHeaders } from "../_shared/cors.ts";

const disabledResponse = (req: Request): Response =>
  new Response(JSON.stringify({ error: "This endpoint is disabled" }), {
    status: 410,
    headers: { ...restrictedCorsHeaders(req), "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: restrictedCorsHeaders(req) });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...restrictedCorsHeaders(req), "Content-Type": "application/json" },
    });
  }

  try {
    return disabledResponse(req);
  } catch {
    return disabledResponse(req);
  }
});
