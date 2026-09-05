/** Threads and YouTube have no private messages: funnels there reply publicly or not at all. */
export function platformSupportsPrivateReply(platform: string): boolean {
  return platform === "facebook" || platform === "instagram";
}
