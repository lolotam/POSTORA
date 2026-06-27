const BACKUP_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;

export function normalizeBackupCode(code) {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function isValidBackupCode(code) {
  return BACKUP_CODE_PATTERN.test(normalizeBackupCode(code));
}

export async function hashBackupCode(code, pepper) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(normalizeBackupCode(code)),
  );

  return Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
