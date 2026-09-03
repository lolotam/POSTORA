import { supabase } from "@/integrations/supabase/client";
import type {
  CommentWorkflowPlatform,
  CommentWorkflowRule,
  CommentWorkflowRuleInput,
  CommentWorkflowStats,
} from "../domain/rule";

/**
 * Supabase adapters for Comment Workflow. Every read and write goes through RLS as the signed-in
 * user; there is no edge function in this path because there is nothing here the browser is not
 * already allowed to do.
 *
 * A failed read raises. It must never look like "no workflows" or "no activity": on screen the
 * two are the same picture, and only one of them is true.
 */

export interface MediaOption {
  id: string;
  label: string;
}

export interface PostOption {
  id: string;
  label: string;
}

export async function fetchRules(): Promise<CommentWorkflowRule[]> {
  const { data, error } = await supabase
    .from("comment_workflow_rules")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as CommentWorkflowRule[];
}

export async function fetchStats(): Promise<CommentWorkflowStats[]> {
  const { data, error } = await supabase.from("comment_workflow_rule_stats").select("*");
  if (error) throw error;
  return data ?? [];
}

export async function createRule(input: CommentWorkflowRuleInput): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in.");
  const { error } = await supabase.from("comment_workflow_rules").insert({ ...input, user_id: user.id });
  if (error) throw error;
}

export async function updateRule(id: string, input: Partial<CommentWorkflowRuleInput>): Promise<void> {
  const { error } = await supabase.from("comment_workflow_rules").update(input).eq("id", id);
  if (error) throw error;
}

export async function deleteRule(id: string): Promise<void> {
  const { error } = await supabase.from("comment_workflow_rules").delete().eq("id", id);
  if (error) throw error;
}

/**
 * Files the funnel may attach.
 *
 * Two filters, and both matter. `storage_bucket = 'media'` is the only bucket the send path
 * signs, and the path prefix is the caller's own id because the send path refuses any other —
 * media_files' insert policy constrains the row's owner but not its file_path, so a row can
 * name an object its owner does not have. Offering such a row here would produce a workflow
 * that silently ships without its link.
 */
export async function fetchAttachableMedia(): Promise<MediaOption[]> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in.");
  const { data, error } = await supabase
    .from("media_files")
    .select("id, file_path, file_type, file_size")
    .eq("storage_bucket", "media")
    .like("file_path", `${user.id}/%`)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id,
    label: `${row.file_path.split("/").pop() ?? row.file_path} · ${row.file_type}`,
  }));
}

/**
 * Recent posts to aim a funnel at, read through the comment manager's existing account
 * actions rather than a new endpoint — those already resolve the right Graph host for
 * Page-backed and direct-login Instagram alike.
 */
export async function fetchRecentPosts(
  platform: CommentWorkflowPlatform,
  socialAccountId: string,
  platformUserId: string,
): Promise<PostOption[]> {
  if (platform === "threads") return [];

  const body = platform === "facebook"
    ? { action: "get_page_comments", social_account_id: socialAccountId, page_id: platformUserId }
    : { action: "get_ig_comments", social_account_id: socialAccountId, ig_user_id: platformUserId };

  const { data, error } = await supabase.functions.invoke("comment-manager", { body });
  if (error) throw error;
  // The comment manager returns Meta's own shape, including its errors.
  if (data?.error) throw new Error(data.error?.message ?? "The platform refused the post list.");

  const rows: Array<Record<string, unknown>> = Array.isArray(data?.data) ? data.data : [];
  return rows
    .filter((row) => typeof row.id === "string")
    .map((row) => {
      const caption = String(row.message ?? row.caption ?? "").trim();
      return {
        id: String(row.id),
        label: caption ? caption.slice(0, 80) : `Post ${String(row.id).slice(-8)}`,
      };
    });
}
