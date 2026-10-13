/**
 * Routes a non-admin user may open in the TikTok review build. Everything else that renders
 * inside the dashboard layout sends them to the Approvals page, so a reviewer only ever sees
 * flows that work end to end.
 */
export const REVIEW_HOME_PATH = "/approvals";

export const REVIEW_PATHS = {
  activity: "/activity",
  calendar: "/calendar",
  approvals: "/approvals",
  workspace: "/settings",
  integrations: "/integrations",
  pricing: "/pricing",
} as const;

// TikTok OAuth lands on /tiktok-callback, which sends review users back to Integrations.
const OAUTH_RETURN_PATHS = ["/tiktok-callback"];

const ALLOWED_PATHS = new Set<string>([...Object.values(REVIEW_PATHS), ...OAUTH_RETURN_PATHS]);

export function isReviewPathAllowed(pathname: string): boolean {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return ALLOWED_PATHS.has(normalized);
}
