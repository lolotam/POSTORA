import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  groupDealsByStage,
  isLostStage,
  isWonStage,
  type StageSemantics,
} from "@/lib/whatsappPipeline";
import type { WhatsAppDeal, WhatsAppPipelineStage } from "@/hooks/useWhatsAppPipelines";
import { DealCard } from "./DealCard";

export interface PipelineBoardProps {
  stages: WhatsAppPipelineStage[];
  deals: WhatsAppDeal[];
  canWrite: boolean;
  onMove: (move: {
    dealId: string;
    sourceStageId: string;
    destinationStage: StageSemantics;
    destinationIndex: number;
  }) => void;
  onEditDeal?: (deal: WhatsAppDeal) => void;
  onDeleteDeal?: (deal: WhatsAppDeal) => void;
  onOpenConversation?: (deal: WhatsAppDeal) => void;
}

function stageTone(stage: WhatsAppPipelineStage) {
  // Won/lost is decided by stage_type, never by the stage's display name — a stage
  // called "Won" that is semantically open must not be styled or counted as won.
  if (isWonStage(stage)) return "border-emerald-500/40";
  if (isLostStage(stage)) return "border-destructive/40";
  return "border-border";
}

function stageTotal(deals: WhatsAppDeal[]) {
  return deals.reduce((runningTotal, deal) => {
    const amount = typeof deal.amount === "string" ? Number(deal.amount) : deal.amount ?? 0;
    return runningTotal + (Number.isFinite(amount) ? amount : 0);
  }, 0);
}

function StageColumn({
  stage,
  deals,
  stages,
  canWrite,
  onMoveToStage,
  onEditDeal,
  onDeleteDeal,
  onOpenConversation,
}: {
  stage: WhatsAppPipelineStage;
  deals: WhatsAppDeal[];
  stages: WhatsAppPipelineStage[];
  canWrite: boolean;
  onMoveToStage: (deal: WhatsAppDeal, target: WhatsAppPipelineStage) => void;
  onEditDeal?: (deal: WhatsAppDeal) => void;
  onDeleteDeal?: (deal: WhatsAppDeal) => void;
  onOpenConversation?: (deal: WhatsAppDeal) => void;
}) {
  const { setNodeRef } = useDroppable({ id: stage.id });

  return (
    <section
      className={`flex w-72 shrink-0 flex-col rounded-lg border ${stageTone(stage)} bg-muted/30`}
      aria-label={`${stage.name} stage`}
      data-testid={`stage-column-${stage.id}`}
    >
      <header className="flex items-center justify-between gap-2 border-b p-3">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: stage.color ?? "#3b82f6" }} />
          <h3 className="text-sm font-semibold">{stage.name}</h3>
        </div>
        <Badge variant="secondary">{deals.length}</Badge>
      </header>

      <p className="px-3 pt-2 text-xs text-muted-foreground">
        Total {stageTotal(deals).toLocaleString()}
      </p>

      <ScrollArea className="max-h-[60vh]">
        <div ref={setNodeRef} className="space-y-2 p-3">
          <SortableContext items={deals.map((deal) => deal.id)} strategy={verticalListSortingStrategy}>
            {deals.map((deal) => (
              <DealCard
                key={deal.id}
                deal={deal}
                stages={stages}
                currentStageId={stage.id}
                canWrite={canWrite}
                onMoveToStage={onMoveToStage}
                onEdit={onEditDeal}
                onDelete={onDeleteDeal}
                onOpenConversation={onOpenConversation}
              />
            ))}
          </SortableContext>
          {deals.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">No deals</p>
          ) : null}
        </div>
      </ScrollArea>
    </section>
  );
}

export function PipelineBoard({
  stages,
  deals,
  canWrite,
  onMove,
  onEditDeal,
  onDeleteDeal,
  onOpenConversation,
}: PipelineBoardProps) {
  const [draggingDealId, setDraggingDealId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const dealsByStage = useMemo(() => groupDealsByStage(deals), [deals]);
  const draggingDeal = deals.find((deal) => deal.id === draggingDealId) ?? null;

  const moveToStage = (deal: WhatsAppDeal, target: WhatsAppPipelineStage) => {
    onMove({
      dealId: deal.id,
      sourceStageId: deal.stage_id,
      destinationStage: { id: target.id, stage_type: target.stage_type },
      destinationIndex: (dealsByStage[target.id] ?? []).length,
    });
  };

  const handleDragStart = (event: DragStartEvent) => {
    setDraggingDealId(String(event.active.id));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setDraggingDealId(null);
    const { active, over } = event;
    if (!over) return;

    const activeDeal = deals.find((deal) => deal.id === String(active.id));
    if (!activeDeal) return;

    const overId = String(over.id);
    const targetStage =
      stages.find((stage) => stage.id === overId) ??
      stages.find((stage) => stage.id === deals.find((deal) => deal.id === overId)?.stage_id);
    if (!targetStage) return;

    const targetDeals = dealsByStage[targetStage.id] ?? [];
    const overIndex = targetDeals.findIndex((deal) => deal.id === overId);
    const destinationIndex = overIndex >= 0 ? overIndex : targetDeals.length;
    if (targetStage.id === activeDeal.stage_id && destinationIndex === activeDeal.position) return;

    onMove({
      dealId: activeDeal.id,
      sourceStageId: activeDeal.stage_id,
      destinationStage: { id: targetStage.id, stage_type: targetStage.stage_type },
      destinationIndex,
    });
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setDraggingDealId(null)}
    >
      <div className="flex gap-4 overflow-x-auto pb-4">
        {stages.map((stage) => (
          <StageColumn
            key={stage.id}
            stage={stage}
            stages={stages}
            deals={dealsByStage[stage.id] ?? []}
            canWrite={canWrite}
            onMoveToStage={moveToStage}
            onEditDeal={onEditDeal}
            onDeleteDeal={onDeleteDeal}
            onOpenConversation={onOpenConversation}
          />
        ))}
      </div>

      <DragOverlay>
        {draggingDeal ? (
          <DealCard
            deal={draggingDeal}
            stages={stages}
            currentStageId={draggingDeal.stage_id}
            canWrite={canWrite}
            onMoveToStage={moveToStage}
            sortable={false}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
