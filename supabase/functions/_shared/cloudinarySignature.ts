/**
 * Cloudinary's upload/destroy request signature.
 *
 * SHA-1 is not a choice here: Cloudinary's signed-upload scheme specifies it,
 * and the digest is of a parameter string that already ends in the API secret,
 * so it authenticates rather than hashes anything secret on its own.
 *
 * Shared because two callers need the identical string today — the knowledge
 * graph export upload and the knowledge source file delete.
 */
export async function cloudinarySignature(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
