// Branch-only switch for the TikTok app review build. While true, the dashboard
// nav keeps only Posting (Create Post, History) and TikTok Management, and
// signed-in users land on the TikTok publish page. Main never carries this file.
export const TIKTOK_REVIEW_MODE = true;

export const SIGNED_IN_HOME_PATH = TIKTOK_REVIEW_MODE ? "/tiktok-publish" : "/dashboard";
