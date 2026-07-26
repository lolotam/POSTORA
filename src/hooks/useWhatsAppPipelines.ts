import { useEffect, useId } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { QueryData } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "@/hooks/use-toast";
import {
  applyOptimisticDealMove,
  dealStatusForStage,
  validateDeal,
  validateDealChanges,
  WhatsAppDealValidationError,
  type DealStatus,
  type DealValidationInput,
  type OptimisticDealMove,
  type StageSemantics,
} from "@/lib/whatsappPipeline";
import { useAuth } from "./useAuth";

type Tables = Database["public"]["Tables"];
type PipelineRow = Tables["whatsapp_pipelines"]["Row"];
type PipelineStageRow = Tables["whatsapp_pipeline_stages"]["Row"];
type DealRow = Tables["whatsapp_deals"]["Row"];
type DealInsert = Tables["whatsapp_deals"]["Insert"];
type DealUpdate = Tables["whatsapp_deals"]["Update"];
type ContactRow = Tables["whatsapp_contacts"]["Row"];

export type WhatsAppPipeline = PipelineRow;
export type WhatsAppPipelineStage = Omit<PipelineStageRow, "stage_type"> & {
  stage_type: DealStatus;
};
export type WorkspaceContact = Pick<
  ContactRow,
  "id" | "display_name" | "phone_number" | "avatar_url"
>;

const DEAL_CARD_SELECT = `
  *,
  contact:whatsapp_contacts!whatsapp_deals_contact_workspace_fkey(
    id,
    display_name,
    phone_number
  ),
  conversation:messaging_cache!whatsapp_deals_conversation_workspace_fkey(
    id,
    last_message_at
  )
` as const;

function dealCardQuery() {
  return supabase.from("whatsapp_deals").select(DEAL_CARD_SELECT);
}

type DealCardQueryRow = QueryData<ReturnType<typeof dealCardQuery>>[number];

export type WhatsAppDeal = Omit<DealCardQueryRow, "status"> & {
  status: DealStatus;
};

export interface CreateDealInput extends DealValidationInput {
  workspaceId: string;
  pipelineId: string;
  stage: StageSemantics;
  conversationCacheId?: string | null;
  assignedTo?: string | null;
  position?: number;
}

export interface UpdateDealChanges extends Partial<DealValidationInput> {
  conversationCacheId?: string | null;
  assignedTo?: string | null;
}

export interface UpdateDealInput {
  dealId: string;
  pipelineId: string;
  changes: UpdateDealChanges;
}

export interface DeleteDealInput {
  dealId: string;
  pipelineId: string;
}

export interface MoveDealInput extends OptimisticDealMove {
  pipelineId: string;
}

const defaultPipelineRequests = new Map<string, Promise<void>>();

function pipelineQueryKey(userId: string | undefined, workspaceId: string) {
  return ["whatsapp_pipelines", userId, workspaceId] as const;
}

function stageQueryKey(userId: string | undefined, pipelineId: string) {
  return ["whatsapp_pipeline_stages", userId, pipelineId] as const;
}

function dealQueryKey(userId: string | undefined, pipelineId: string) {
  return ["whatsapp_deals", userId, pipelineId] as const;
}

function contactQueryKey(userId: string | undefined, workspaceId: string) {
  return ["whatsapp_contacts", userId, workspaceId] as const;
}

function isDealStatus(status: string): status is DealStatus {
  return status === "open" || status === "won" || status === "lost";
}

function semanticStage(stage: PipelineStageRow): WhatsAppPipelineStage {
  if (!isDealStatus(stage.stage_type)) {
    throw new Error(`Unsupported WhatsApp pipeline stage type: ${stage.stage_type}`);
  }
  return { ...stage, stage_type: stage.stage_type };
}

function dealCard(row: DealCardQueryRow): WhatsAppDeal {
  if (!isDealStatus(row.status)) {
    throw new Error(`Unsupported WhatsApp deal status: ${row.status}`);
  }
  return { ...row, status: row.status };
}

async function fetchPipelines(workspaceId: string): Promise<WhatsAppPipeline[]> {
  const { data, error } = await supabase
    .from("whatsapp_pipelines")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

async function ensureDefaultPipeline(workspaceId: string): Promise<void> {
  const inFlightRequest = defaultPipelineRequests.get(workspaceId);
  if (inFlightRequest) return inFlightRequest;

  const request = Promise.resolve(
    supabase.rpc("create_default_whatsapp_pipeline", { p_workspace_id: workspaceId }),
  ).then(({ error }) => {
    if (error) throw error;
  });
  defaultPipelineRequests.set(workspaceId, request);

  try {
    await request;
  } catch (error) {
    defaultPipelineRequests.delete(workspaceId);
    throw error;
  }
}

export function usePipelines(workspaceId: string) {
  const { user } = useAuth();

  return useQuery({
    queryKey: pipelineQueryKey(user?.id, workspaceId),
    queryFn: async () => {
      if (!user) return [];
      const pipelines = await fetchPipelines(workspaceId);
      if (pipelines.length > 0) return pipelines;

      await ensureDefaultPipeline(workspaceId);
      return fetchPipelines(workspaceId);
    },
    enabled: !!user && !!workspaceId,
    retry: false,
  });
}

export function usePipelineStages(pipelineId: string) {
  const { user } = useAuth();

  return useQuery({
    queryKey: stageQueryKey(user?.id, pipelineId),
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await supabase
        .from("whatsapp_pipeline_stages")
        .select("*")
        .eq("pipeline_id", pipelineId)
        .order("position", { ascending: true });

      if (error) throw error;
      return (data ?? []).map(semanticStage);
    },
    enabled: !!user && !!pipelineId,
    retry: false,
  });
}

export function useDeals(pipelineId: string) {
  const { user } = useAuth();

  return useQuery({
    queryKey: dealQueryKey(user?.id, pipelineId),
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await dealCardQuery()
        .eq("pipeline_id", pipelineId)
        .order("position", { ascending: true });

      if (error) throw error;
      return (data ?? []).map(dealCard);
    },
    enabled: !!user && !!pipelineId,
    retry: false,
  });
}

export function useWorkspaceContacts(workspaceId: string) {
  const { user } = useAuth();

  return useQuery({
    queryKey: contactQueryKey(user?.id, workspaceId),
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await supabase
        .from("whatsapp_contacts")
        .select("id, display_name, phone_number, avatar_url")
        .eq("workspace_id", workspaceId)
        .order("display_name", { ascending: true, nullsFirst: false });

      if (error) throw error;
      return data ?? [];
    },
    enabled: !!user && !!workspaceId,
    retry: false,
  });
}

function validatedDeal(input: DealValidationInput): DealValidationInput {
  const validation = validateDeal(input);
  if ("errors" in validation) throw new WhatsAppDealValidationError(validation.errors);
  return validation.value;
}

function errorDescription(error: Error): string {
  return error.message || "An unexpected error occurred";
}

export function useCreateDeal() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateDealInput) => {
      if (!user) throw new Error("User not authenticated");
      const validDeal = validatedDeal(input);
      const newDeal: DealInsert = {
        workspace_id: input.workspaceId,
        pipeline_id: input.pipelineId,
        stage_id: input.stage.id,
        contact_id: validDeal.contactId,
        conversation_cache_id: input.conversationCacheId ?? null,
        title: validDeal.title,
        amount: validDeal.amount,
        currency: validDeal.currency,
        status: dealStatusForStage(input.stage),
        position: input.position ?? 0,
        assigned_to: input.assignedTo ?? null,
        created_by: user.id,
      };
      const { data, error } = await supabase
        .from("whatsapp_deals")
        .insert(newDeal)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: (_, input) => {
      queryClient.invalidateQueries({ queryKey: dealQueryKey(user?.id, input.pipelineId) });
      toast({ title: "Deal created" });
    },
    onError: (error) => {
      toast({
        title: "Failed to create deal",
        description: errorDescription(error),
        variant: "destructive",
      });
    },
  });
}

function dealUpdate(changes: UpdateDealChanges): DealUpdate {
  const validation = validateDealChanges(changes);
  if ("errors" in validation) throw new WhatsAppDealValidationError(validation.errors);

  const update: DealUpdate = {};
  if (validation.value.contactId !== undefined) {
    update.contact_id = validation.value.contactId;
  }
  if (validation.value.title !== undefined) update.title = validation.value.title;
  if (validation.value.amount !== undefined) update.amount = validation.value.amount;
  if (validation.value.currency !== undefined) update.currency = validation.value.currency;
  if (changes.conversationCacheId !== undefined) {
    update.conversation_cache_id = changes.conversationCacheId;
  }
  if (changes.assignedTo !== undefined) update.assigned_to = changes.assignedTo;
  return update;
}

export function useUpdateDeal() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ dealId, pipelineId, changes }: UpdateDealInput) => {
      if (!user) throw new Error("User not authenticated");
      const { data, error } = await supabase
        .from("whatsapp_deals")
        .update(dealUpdate(changes))
        .eq("id", dealId)
        .eq("pipeline_id", pipelineId)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: (_, input) => {
      queryClient.invalidateQueries({ queryKey: dealQueryKey(user?.id, input.pipelineId) });
      toast({ title: "Deal updated" });
    },
    onError: (error) => {
      toast({
        title: "Failed to update deal",
        description: errorDescription(error),
        variant: "destructive",
      });
    },
  });
}

export function useDeleteDeal() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ dealId, pipelineId }: DeleteDealInput) => {
      if (!user) throw new Error("User not authenticated");
      const { error } = await supabase
        .from("whatsapp_deals")
        .delete()
        .eq("id", dealId)
        .eq("pipeline_id", pipelineId);

      if (error) throw error;
    },
    onSuccess: (_, input) => {
      queryClient.invalidateQueries({ queryKey: dealQueryKey(user?.id, input.pipelineId) });
      toast({ title: "Deal deleted" });
    },
    onError: (error) => {
      toast({
        title: "Failed to delete deal",
        description: errorDescription(error),
        variant: "destructive",
      });
    },
  });
}

function validDestinationIndex(index: number): boolean {
  return Number.isInteger(index) && index >= 0;
}

export function useMoveDeal() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (move: MoveDealInput) => {
      if (!user) throw new Error("User not authenticated");
      if (!validDestinationIndex(move.destinationIndex)) {
        throw new Error("Deal position must be a non-negative integer");
      }
      const { error } = await supabase.rpc("move_whatsapp_deal", {
        p_deal_id: move.dealId,
        p_stage_id: move.destinationStage.id,
        p_position: move.destinationIndex,
      });
      if (error) throw error;
    },
    onMutate: async (move) => {
      const queryKey = dealQueryKey(user?.id, move.pipelineId);
      await queryClient.cancelQueries({ queryKey });
      const previousDeals = queryClient.getQueryData<WhatsAppDeal[]>(queryKey);
      if (previousDeals && validDestinationIndex(move.destinationIndex)) {
        queryClient.setQueryData(queryKey, applyOptimisticDealMove(previousDeals, move));
      }
      return { previousDeals, queryKey };
    },
    onError: (error, _move, context) => {
      if (context?.previousDeals) {
        queryClient.setQueryData(context.queryKey, context.previousDeals);
      }
      toast({
        title: "Failed to move deal",
        description: errorDescription(error),
        variant: "destructive",
      });
    },
    onSuccess: () => {
      toast({ title: "Deal moved" });
    },
    onSettled: (_data, _error, move) => {
      queryClient.invalidateQueries({
        queryKey: dealQueryKey(user?.id, move.pipelineId),
      });
    },
  });
}

export function useWhatsAppPipelineRealtime(workspaceId: string | undefined) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const subscriptionId = useId();

  useEffect(() => {
    if (!user || !workspaceId) return;
    const filter = `workspace_id=eq.${workspaceId}`;
    const channel = supabase
      .channel(`whatsapp-crm:${workspaceId}:${subscriptionId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "whatsapp_deals", filter },
        () => queryClient.invalidateQueries({ queryKey: ["whatsapp_deals", user.id] }),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "whatsapp_pipeline_stages", filter },
        () => queryClient.invalidateQueries({
          queryKey: ["whatsapp_pipeline_stages", user.id],
        }),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient, subscriptionId, user, workspaceId]);
}



