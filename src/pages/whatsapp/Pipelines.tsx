import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Kanban, Plus, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WhatsAppPageHeader } from "@/components/whatsapp/WhatsAppPageHeader";
import { useWhatsAppWorkspaceContext } from "@/components/whatsapp/WhatsAppWorkspaceProvider";
import { PipelineBoard } from "@/components/whatsapp/pipelines/PipelineBoard";
import { DealDialog, type DealFormValues } from "@/components/whatsapp/pipelines/DealDialog";
import { PipelineSettingsDialog } from "@/components/whatsapp/pipelines/PipelineSettingsDialog";
import { roleAtLeast } from "@/hooks/useWhatsAppWorkspace";
import { buildInboxRoute } from "@/lib/whatsappInboxRoute";
import {
  useCreateDeal,
  useDeals,
  useDeleteDeal,
  useMoveDeal,
  usePipelineStages,
  usePipelines,
  useUpdateDeal,
  useWhatsAppPipelineRealtime,
  useWorkspaceContacts,
  type WhatsAppDeal,
} from "@/hooks/useWhatsAppPipelines";

export default function Pipelines() {
  const { activeWorkspaceId, activeRole } = useWhatsAppWorkspaceContext();
  const workspaceId = activeWorkspaceId ?? "";
  const navigate = useNavigate();

  const [selectedPipelineId, setSelectedPipelineId] = useState<string>();
  const [dealDialogOpen, setDealDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editingDeal, setEditingDeal] = useState<WhatsAppDeal | null>(null);

  const { data: pipelines = [], isLoading: pipelinesLoading } = usePipelines(workspaceId);
  const pipelineId = selectedPipelineId ?? pipelines[0]?.id ?? "";
  const { data: stages = [], isLoading: stagesLoading } = usePipelineStages(pipelineId);
  const { data: deals = [], isLoading: dealsLoading } = useDeals(pipelineId);
  const { data: contacts = [] } = useWorkspaceContacts(workspaceId);
  useWhatsAppPipelineRealtime(activeWorkspaceId);

  const createDeal = useCreateDeal();
  const updateDeal = useUpdateDeal();
  const deleteDeal = useDeleteDeal();
  const moveDeal = useMoveDeal();

  // Agents may work deals; viewers are read-only. Stage configuration is stricter.
  const canWrite = roleAtLeast(activeRole, "agent");
  const canConfigure = roleAtLeast(activeRole, "admin");
  const stageById = useMemo(() => new Map(stages.map((stage) => [stage.id, stage])), [stages]);

  const isLoading = pipelinesLoading || stagesLoading || dealsLoading;

  const handleSubmitDeal = (values: DealFormValues) => {
    const stage = stageById.get(values.stageId);
    if (!stage) return;

    if (editingDeal) {
      updateDeal.mutate({
        dealId: editingDeal.id,
        pipelineId,
        changes: {
          contactId: values.contactId,
          title: values.title,
          amount: values.amount,
          currency: values.currency,
        },
      });
    } else {
      createDeal.mutate({
        workspaceId,
        pipelineId,
        stage: { id: stage.id, stage_type: stage.stage_type },
        contactId: values.contactId,
        title: values.title,
        amount: values.amount,
        currency: values.currency,
        conversationCacheId: values.conversationCacheId,
        position: deals.filter((deal) => deal.stage_id === stage.id).length,
      });
    }
    setDealDialogOpen(false);
    setEditingDeal(null);
  };

  return (
    <div className="space-y-6">
      <WhatsAppPageHeader
        icon={Kanban}
        title="Pipelines"
        description="Track WhatsApp deals from first contact through to won or lost."
      />

      <div className="flex flex-wrap items-center gap-2">
        {pipelines.length > 1 ? (
          <Select value={pipelineId} onValueChange={setSelectedPipelineId}>
            <SelectTrigger className="w-56" aria-label="Select pipeline">
              <SelectValue placeholder="Select a pipeline" />
            </SelectTrigger>
            <SelectContent>
              {pipelines.map((pipeline) => (
                <SelectItem key={pipeline.id} value={pipeline.id}>
                  {pipeline.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        <div className="ms-auto flex items-center gap-2">
          {canConfigure ? (
            <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
              <Settings2 className="me-2 h-4 w-4" />
              Stages
            </Button>
          ) : null}
          {canWrite ? (
            <Button
              size="sm"
              onClick={() => {
                setEditingDeal(null);
                setDealDialogOpen(true);
              }}
            >
              <Plus className="me-2 h-4 w-4" />
              New deal
            </Button>
          ) : null}
        </div>
      </div>

      {isLoading ? (
        <div className="flex gap-4">
          {[0, 1, 2].map((column) => (
            <Skeleton key={column} className="h-64 w-72" />
          ))}
        </div>
      ) : stages.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          This pipeline has no stages yet.
        </p>
      ) : (
        <PipelineBoard
          stages={stages}
          deals={deals}
          canWrite={canWrite}
          onMove={(move) => moveDeal.mutate({ ...move, pipelineId })}
          onEditDeal={(deal) => {
            setEditingDeal(deal);
            setDealDialogOpen(true);
          }}
          onDeleteDeal={(deal) => deleteDeal.mutate({ dealId: deal.id, pipelineId })}
          onOpenConversation={(deal) => {
            // The deal stores messaging_cache.id, so this link survives a refresh
            // and resolves to exactly one chat.
            if (!deal.conversation_cache_id) return;
            navigate(
              buildInboxRoute({
                workspaceId: activeWorkspaceId,
                conversationCacheId: deal.conversation_cache_id,
              }),
            );
          }}
        />
      )}

      <DealDialog
        open={dealDialogOpen}
        onOpenChange={(open) => {
          setDealDialogOpen(open);
          if (!open) setEditingDeal(null);
        }}
        stages={stages}
        contacts={contacts}
        deal={editingDeal}
        isSubmitting={createDeal.isPending || updateDeal.isPending}
        onSubmit={handleSubmitDeal}
      />

      <PipelineSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        stages={stages}
      />
    </div>
  );
}
