/** The real ports: Openinary listings and deletes, and system_logs. */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logToDatabase } from "../_shared/logging.ts";
import { deleteFromOpeninary, getOpeninaryConfig, listOpeninaryEntries, listOpeninaryFolder } from "../_shared/openinary.ts";
import { type SweepPorts, userFolderPaths } from "./run.ts";

const DELETE_TIMEOUT_MS = 15_000;

export function createSweepLogger(): SweepPorts["log"] {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) throw new Error("sweep backend unavailable");
  const admin = createClient(supabaseUrl, serviceRoleKey);
  return (level, message, metadata) => logToDatabase(admin, { level, category: "system", source: "sweep-ai-image-staging", message, metadata });
}

export function createSweepPorts(): SweepPorts {
  const config = getOpeninaryConfig();
  if (!config) throw new Error("Openinary is not configured");
  const root = `${config.folderPrefix}/postora`;

  return {
    listUserFolders: async () => userFolderPaths(root, (await listOpeninaryEntries(config, root)).folders),
    listStaged: (userFolder) => listOpeninaryFolder(config, `${userFolder}/ai-tmp`),
    remove: (path) => deleteFromOpeninary(config, path, DELETE_TIMEOUT_MS),
    log: createSweepLogger(),
  };
}
