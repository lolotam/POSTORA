function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const size = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < size; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export async function verifyEvolutionWebhookToken(
  token: string,
  jwtKey: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const segments = token.split(".");
  if (segments.length !== 3) return false;
  try {
    const header = JSON.parse(new TextDecoder().decode(decodeBase64Url(segments[0]))) as { alg?: string };
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(segments[1]))) as {
      exp?: number;
      app?: string;
      action?: string;
    };
    if (header.alg !== "HS256" || payload.app !== "evolution" || payload.action !== "webhook") return false;
    if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) return false;

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(jwtKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const expected = new Uint8Array(await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${segments[0]}.${segments[1]}`),
    ));
    return constantTimeEqual(expected, decodeBase64Url(segments[2]));
  } catch {
    return false;
  }
}
