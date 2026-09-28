import { handleMediaRetentionRequest } from "../media-retention/handler.ts";

// Retired. The admin page and any leftover cron call still hit this name;
// both paths run the retention module (preview when dryRun, otherwise a real run).
Deno.serve((req) => handleMediaRetentionRequest(req));
