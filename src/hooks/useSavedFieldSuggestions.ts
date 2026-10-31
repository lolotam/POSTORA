import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

export type FieldType = "people_tags" | "alt_text" | "collaborator" | "hashtags";

interface Suggestion {
  id: string;
  value: string;
  use_count: number;
  last_used_at: string;
}

export function useSavedFieldSuggestions(fieldType: FieldType, platform?: string | null) {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const userId = session?.user?.id;

  const queryKey = ["saved_field_suggestions", fieldType, platform ?? "shared"];

  const { data: suggestions = [], isLoading } = useQuery({
    queryKey,
    queryFn: async () => {
      let query = supabase
        .from("saved_field_suggestions")
        .select("id, value, use_count, last_used_at")
        .eq("user_id", userId!)
        .eq("field_type", fieldType)
        .order("use_count", { ascending: false })
        .limit(20);

      if (platform) {
        query = query.eq("platform", platform);
      } else {
        query = query.is("platform", null);
      }

      const { data, error } = await query;
      if (error) throw error;
      return (data || []) as Suggestion[];
    },
    enabled: !!userId,
  });

  const saveMutation = useMutation({
    mutationFn: async ({ value, isCommaMode }: { value: string; isCommaMode?: boolean }) => {
      if (!userId) return;

      const values = isCommaMode
        ? value.split(",").map((v) => v.trim()).filter(Boolean)
        : [value.trim()].filter(Boolean);

      const db = supabase;
      for (const val of values) {
        let existingQuery = db
          .from("saved_field_suggestions")
          .select("id, use_count")
          .eq("user_id", userId)
          .eq("field_type", fieldType)
          .eq("value", val);

        if (platform) {
          existingQuery = existingQuery.eq("platform", platform);
        } else {
          existingQuery = existingQuery.is("platform", null);
        }

        const { data: existing } = await existingQuery.maybeSingle();

        if (existing) {
          await db
            .from("saved_field_suggestions")
            .update({ use_count: existing.use_count + 1, last_used_at: new Date().toISOString() })
            .eq("id", existing.id);
        } else {
          await db
            .from("saved_field_suggestions")
            .insert({
              user_id: userId,
              field_type: fieldType,
              value: val,
              platform: platform ?? null,
            });
        }
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("saved_field_suggestions")
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  return {
    suggestions,
    isLoading,
    saveSuggestion: (value: string, isCommaMode?: boolean) =>
      saveMutation.mutateAsync({ value, isCommaMode }),
    deleteSuggestion: (id: string) => deleteMutation.mutateAsync(id),
  };
}
