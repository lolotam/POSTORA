// Payload shapes extracted from the Evolution answers shared by the bridge actions.
// Lives outside index.ts so reconnect.ts can parse connect responses without importing
// the HTTP entrypoint.

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function extractQr(payload: unknown): string | null {
  const root = object(payload);
  const qr = object(root.qrcode || root.qr || root);
  const code = qr.base64 || qr.image || qr.code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

export function extractState(payload: unknown): string | null {
  const root = object(payload);
  const state = object(root.instance).state || root.state || root.connectionStatus;
  return typeof state === "string" && state.length > 0 ? state : null;
}
