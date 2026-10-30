/**
 * Who is calling process-video / transcode-video. Identity comes from the Authorization
 * header; the body's `user_id` is only a claim that must agree with it. Both functions are
 * browser-only, so a service-role bearer (which would need a body user id) is refused.
 */

import { authenticateCaller } from "./auth-helper.ts";
import { OpeninaryVideoError } from "./openinaryVideoTransform.ts";

export type Authenticate = (req: Request, bodyUserId?: string | null) => Promise<{ userId: string }>;

export async function identifyVideoCaller(
  req: Request,
  claimedUserId: string | null | undefined,
  authenticate: Authenticate = authenticateCaller,
): Promise<string> {
  let userId: string;
  try {
    ({ userId } = await authenticate(req, null));
  } catch {
    throw new OpeninaryVideoError("UNAUTHORIZED", "Authentication failed. Please refresh the page and try again.");
  }
  if (claimedUserId && claimedUserId !== userId) {
    throw new OpeninaryVideoError("FORBIDDEN", "You don't own this media file.");
  }
  return userId;
}
