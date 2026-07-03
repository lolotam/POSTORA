import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export interface AutoReplyRule {
  id: string;
  user_id: string;
  name: string;
  rule_type: "away" | "keyword";
  keywords: string[] | null;
  reply_message: string;
  is_active: boolean;
  schedule_start: string | null;
  schedule_end: string | null;
  schedule_days: number[] | null;
  created_at: string;
  updated_at: string;
}

export type AutoReplyRuleInput = Omit<AutoReplyRule, "id" | "user_id" | "created_at" | "updated_at">;

/**
 * Shared CRUD implementation for the auto-reply-rules tables (whatsapp_auto_replies,
 * messenger_auto_replies). Both tables encode the same rule — a user-scoped keyword/away
 * reply rule — so this is the one place that logic lives; useWhatsAppAutoReplies and
 * useMessengerAutoReplies are thin, differently-shaped wrappers around it.
 */
export function useAutoReplyRules(
  table: "whatsapp_auto_replies" | "messenger_auto_replies",
  queryKey: readonly unknown[],
  scope: Record<string, string> = {},
  enabled = true,
) {
  const queryClient = useQueryClient();

  const { data: rules = [], isLoading } = useQuery({
    queryKey,
    queryFn: async () => {
      // Typed as `any`: chaining .eq() in a loop over a union-typed table name defeats
      // Supabase's generated query-builder types (excessively deep type instantiation).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let query: any = supabase.from(table).select("*");
      for (const [column, value] of Object.entries(scope)) {
        query = query.eq(column, value);
      }
      const { data, error } = await query.order("created_at", { ascending: false });
      if (error) throw error;
      return data as AutoReplyRule[];
    },
    enabled,
  });

  const createRule = useMutation({
    mutationFn: async (input: AutoReplyRuleInput) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");
      const { error } = await supabase.from(table).insert({
        ...input,
        ...scope,
        user_id: user.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast.success("Auto-reply rule created");
    },
    onError: (e) => toast.error(`Failed to create rule: ${e.message}`),
  });

  const updateRule = useMutation({
    mutationFn: async ({ id, ...input }: Partial<AutoReplyRuleInput> & { id: string }) => {
      const { error } = await supabase.from(table).update(input).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast.success("Rule updated");
    },
    onError: (e) => toast.error(`Failed to update: ${e.message}`),
  });

  const deleteRule = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from(table).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast.success("Rule deleted");
    },
    onError: (e) => toast.error(`Failed to delete: ${e.message}`),
  });

  const toggleRule = useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      const { error } = await supabase.from(table).update({ is_active }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (e) => toast.error(`Failed to toggle: ${e.message}`),
  });

  return { rules, isLoading, createRule, updateRule, deleteRule, toggleRule };
}
