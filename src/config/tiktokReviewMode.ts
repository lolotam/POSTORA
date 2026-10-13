// Branch-only switch for the TikTok app review build. While true, non-admins get the
// review shell (Approvals, Calendar, Activity, Integrations, Workspace), admins keep the
// full dashboard, and signed-in users land on Approvals. Main never carries this file.
export const TIKTOK_REVIEW_MODE = true;

export const SIGNED_IN_HOME_PATH = TIKTOK_REVIEW_MODE ? "/approvals" : "/dashboard";
