import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import { useEffect } from "react";

export interface WhatsAppAgent {
  id: string;
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  status: "online" | "away" | "offline";
  max_conversations: number;
  current_conversations: number;
  last_seen_at: string;
  created_at: string;
}

export interface ConversationAssignment {
  id: string;
  conversation_id: string;
  agent_id: string | null;
  assigned_by: string | null;
  notes: string | null;
  assigned_at: string;
  unassigned_at: string | null;
  agent?: WhatsAppAgent;
}

export interface AssignmentHistoryEntry {
  id: string;
  conversation_id: string;
  action: "assigned" | "unassigned" | "transferred";
  from_agent_id: string | null;
  to_agent_id: string | null;
  performed_by: string | null;
  reason: string | null;
  created_at: string;
  from_agent?: WhatsAppAgent;
  to_agent?: WhatsAppAgent;
}

export function useWhatsAppAgents() {
  const { session } = useAuth();
  const qc = useQueryClient();
  const userId = session?.user?.id;

  // Fetch all agents
  const { data: agents = [], isLoading: agentsLoading } = useQuery({
    queryKey: ["whatsapp-agents"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("whatsapp_agents")
        .select("*")
        .order("display_name");
      if (error) throw error;
      return data as WhatsAppAgent[];
    },
    enabled: !!userId,
  });

  // Current user's agent profile
  const myAgent = agents.find((a) => a.user_id === userId);

  // Register as agent
  const registerAgent = useMutation({
    mutationFn: async (params: { display_name: string }) => {
      const { data, error } = await supabase
        .from("whatsapp_agents")
        .upsert({
          user_id: userId!,
          display_name: params.display_name,
          avatar_url: session?.user?.user_metadata?.avatar_url || null,
          status: "online",
          last_seen_at: new Date().toISOString(),
        }, { onConflict: "user_id" })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["whatsapp-agents"] }),
  });

  // Update status
  const updateStatus = useMutation({
    mutationFn: async (status: "online" | "away" | "offline") => {
      if (!myAgent) throw new Error("Not registered as agent");
      const { error } = await supabase
        .from("whatsapp_agents")
        .update({ status, last_seen_at: new Date().toISOString() })
        .eq("id", myAgent.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["whatsapp-agents"] }),
  });

  // Update max concurrent conversations
  const updateMaxConversations = useMutation({
    mutationFn: async (maxConversations: number) => {
      if (!myAgent) throw new Error("Not registered as agent");
      const { error } = await supabase
        .from("whatsapp_agents")
        .update({ max_conversations: maxConversations })
        .eq("id", myAgent.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["whatsapp-agents"] }),
  });

  // Heartbeat - update last_seen every 60s when online
  useEffect(() => {
    if (!myAgent || myAgent.status === "offline") return;
    const interval = setInterval(async () => {
      await supabase
        .from("whatsapp_agents")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("id", myAgent.id);
    }, 60000);
    return () => clearInterval(interval);
  }, [myAgent?.id, myAgent?.status]);

  return { agents, agentsLoading, myAgent, registerAgent, updateStatus, updateMaxConversations };
}

export function useConversationAssignments() {
  const { session } = useAuth();
  const qc = useQueryClient();

  const { data: assignments = [], isLoading } = useQuery({
    queryKey: ["whatsapp-assignments"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("whatsapp_conversation_assignments")
        .select("*")
        .is("unassigned_at", null)
        .order("assigned_at", { ascending: false });
      if (error) throw error;
      return data as ConversationAssignment[];
    },
    enabled: !!session?.user?.id,
    refetchInterval: 30000,
  });

  const assignConversation = useMutation({
    mutationFn: async (params: { conversationId: string; agentId: string; notes?: string }) => {
      // Unassign existing
      const { data: existing } = await supabase
        .from("whatsapp_conversation_assignments")
        .select("id, agent_id")
        .eq("conversation_id", params.conversationId)
        .is("unassigned_at", null)
        .maybeSingle();

      if (existing) {
        await supabase
          .from("whatsapp_conversation_assignments")
          .update({ unassigned_at: new Date().toISOString() })
          .eq("id", existing.id);

        // Log transfer
        await supabase.from("whatsapp_assignment_history").insert({
          conversation_id: params.conversationId,
          action: "transferred",
          from_agent_id: existing.agent_id,
          to_agent_id: params.agentId,
          performed_by: session!.user.id,
        });
      } else {
        // Log new assignment
        await supabase.from("whatsapp_assignment_history").insert({
          conversation_id: params.conversationId,
          action: "assigned",
          to_agent_id: params.agentId,
          performed_by: session!.user.id,
        });
      }

      // Create new assignment
      const { data, error } = await supabase
        .from("whatsapp_conversation_assignments")
        .insert({
          conversation_id: params.conversationId,
          agent_id: params.agentId,
          assigned_by: session!.user.id,
          notes: params.notes || null,
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["whatsapp-assignments"] });
      qc.invalidateQueries({ queryKey: ["whatsapp-assignment-history"] });
    },
  });

  const unassignConversation = useMutation({
    mutationFn: async (params: { conversationId: string; reason?: string }) => {
      const { data: existing } = await supabase
        .from("whatsapp_conversation_assignments")
        .select("id, agent_id")
        .eq("conversation_id", params.conversationId)
        .is("unassigned_at", null)
        .maybeSingle();

      if (existing) {
        await supabase
          .from("whatsapp_conversation_assignments")
          .update({ unassigned_at: new Date().toISOString() })
          .eq("id", existing.id);

        await supabase.from("whatsapp_assignment_history").insert({
          conversation_id: params.conversationId,
          action: "unassigned",
          from_agent_id: existing.agent_id,
          performed_by: session!.user.id,
          reason: params.reason || null,
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["whatsapp-assignments"] });
      qc.invalidateQueries({ queryKey: ["whatsapp-assignment-history"] });
    },
  });

  return { assignments, isLoading, assignConversation, unassignConversation };
}

export function useAssignmentHistory(conversationId?: string) {
  return useQuery({
    queryKey: ["whatsapp-assignment-history", conversationId],
    queryFn: async () => {
      let query = supabase
        .from("whatsapp_assignment_history")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);

      if (conversationId) {
        query = query.eq("conversation_id", conversationId);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as AssignmentHistoryEntry[];
    },
    enabled: true,
  });
}
