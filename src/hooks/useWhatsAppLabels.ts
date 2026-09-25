import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";

export interface ConversationLabel {
  id: string;
  name: string;
  color: string;
  created_at: string;
}

export interface LabelAssignment {
  id: string;
  conversation_id: string;
  label_id: string;
}

export function useWhatsAppLabels() {
  const { session } = useAuth();
  const userId = session?.user?.id;
  const qc = useQueryClient();

  const labelsQuery = useQuery({
    queryKey: ["whatsapp-labels", userId],
    queryFn: async () => {
      if (!userId) return [];
      const { data, error } = await supabase
        .from("whatsapp_conversation_labels")
        .select("*")
        .eq("user_id", userId)
        .order("name");
      if (error) throw error;
      return (data || []) as ConversationLabel[];
    },
    enabled: !!userId,
    // The AI agent applies labels server-side; an open inbox picks them up
    // without a reload.
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const assignmentsQuery = useQuery({
    queryKey: ["whatsapp-label-assignments", userId],
    queryFn: async () => {
      if (!userId) return [];
      const { data, error } = await supabase
        .from("whatsapp_conversation_label_assignments")
        .select("*")
        .eq("user_id", userId);
      if (error) throw error;
      return (data || []) as LabelAssignment[];
    },
    enabled: !!userId,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const createLabel = useMutation({
    mutationFn: async (params: { name: string; color: string }) => {
      const { data, error } = await supabase
        .from("whatsapp_conversation_labels")
        .insert({ user_id: userId!, name: params.name, color: params.color })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["whatsapp-labels"] }),
  });

  const deleteLabel = useMutation({
    mutationFn: async (labelId: string) => {
      const { error } = await supabase.from("whatsapp_conversation_labels").delete().eq("id", labelId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["whatsapp-labels"] });
      qc.invalidateQueries({ queryKey: ["whatsapp-label-assignments"] });
    },
  });

  const assignLabel = useMutation({
    mutationFn: async (params: { conversationId: string; labelId: string }) => {
      const { error } = await supabase.from("whatsapp_conversation_label_assignments").insert({
        user_id: userId!,
        conversation_id: params.conversationId,
        label_id: params.labelId,
      });
      if (error && !error.message.includes("duplicate")) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["whatsapp-label-assignments"] }),
  });

  const unassignLabel = useMutation({
    mutationFn: async (params: { conversationId: string; labelId: string }) => {
      const { error } = await supabase
        .from("whatsapp_conversation_label_assignments")
        .delete()
        .eq("conversation_id", params.conversationId)
        .eq("label_id", params.labelId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["whatsapp-label-assignments"] }),
  });

  const getLabelsForConversation = (conversationId: string): ConversationLabel[] => {
    const assignments = assignmentsQuery.data?.filter((a) => a.conversation_id === conversationId) || [];
    const labelIds = assignments.map((a) => a.label_id);
    return labelsQuery.data?.filter((l) => labelIds.includes(l.id)) || [];
  };

  return {
    labels: labelsQuery.data || [],
    assignments: assignmentsQuery.data || [],
    isLoading: labelsQuery.isLoading,
    createLabel,
    deleteLabel,
    assignLabel,
    unassignLabel,
    getLabelsForConversation,
  };
}
