import { useTranslation } from "react-i18next";
import "@/i18n";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, MessageSquare, MoreVertical, Pencil, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { WhatsAppDeal, WhatsAppPipelineStage } from "@/hooks/useWhatsAppPipelines";

export interface DealCardProps {
  deal: WhatsAppDeal;
  stages: WhatsAppPipelineStage[];
  currentStageId: string;
  canWrite: boolean;
  onMoveToStage: (deal: WhatsAppDeal, stage: WhatsAppPipelineStage) => void;
  onEdit?: (deal: WhatsAppDeal) => void;
  onDelete?: (deal: WhatsAppDeal) => void;
  onOpenConversation?: (deal: WhatsAppDeal) => void;
  sortable?: boolean;
}

function formatAmount(amount: number | string | null, currency: string | null) {
  const numericAmount = typeof amount === "string" ? Number(amount) : amount ?? 0;
  if (!Number.isFinite(numericAmount)) return null;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: (currency || "USD").toUpperCase(),
      maximumFractionDigits: 2,
    }).format(numericAmount);
  } catch {
    // An unknown currency code must not blank out the card.
    return `${numericAmount} ${currency ?? ""}`.trim();
  }
}

function formatActivity(lastMessageAt: string | null | undefined) {
  if (!lastMessageAt) return null;
  const activityDate = new Date(lastMessageAt);
  if (Number.isNaN(activityDate.getTime())) return null;
  return activityDate.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function DealCard({
  deal,
  stages,
  currentStageId,
  canWrite,
  onMoveToStage,
  onEdit,
  onDelete,
  onOpenConversation,
  sortable = true,
}: DealCardProps) {
  const { t } = useTranslation("whatsapp");
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: deal.id,
    disabled: !sortable || !canWrite,
  });

  const contactName = deal.contact?.display_name || deal.contact?.phone_number || t("deal.unknownContact", "Unknown contact");
  const amountLabel = formatAmount(deal.amount, deal.currency);
  const activityLabel = formatActivity(deal.conversation?.last_message_at);
  const otherStages = stages.filter((stage) => stage.id !== currentStageId);

  return (
    <Card
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={isDragging ? "opacity-50" : undefined}
      data-testid={`deal-card-${deal.id}`}
    >
      <CardContent className="space-y-2 p-3">
        <div className="flex items-start gap-2">
          {canWrite && sortable ? (
            <button
              type="button"
              className="mt-0.5 cursor-grab text-muted-foreground"
              aria-label={t("deal.drag", "Drag {{title}}", { title: deal.title })}
              {...attributes}
              {...listeners}
            >
              <GripVertical className="h-4 w-4" />
            </button>
          ) : null}

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{deal.title}</p>
            <p className="truncate text-xs text-muted-foreground">{contactName}</p>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t("deal.menuAria", "Deal actions for {{title}}", { title: deal.title })}>
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {onOpenConversation && deal.conversation_cache_id ? (
                <DropdownMenuItem onSelect={() => onOpenConversation(deal)}>
                  <MessageSquare className="mr-2 h-4 w-4" />
                  {t("deal.openConversation", "Open conversation")}
                </DropdownMenuItem>
              ) : null}
              {onEdit ? (
                <DropdownMenuItem disabled={!canWrite} onSelect={() => onEdit(deal)}>
                  <Pencil className="mr-2 h-4 w-4" />
                  {t("deal.edit", "Edit deal")}
                </DropdownMenuItem>
              ) : null}
              {onDelete ? (
                <DropdownMenuItem
                  disabled={!canWrite}
                  className="text-destructive"
                  onSelect={() => onDelete(deal)}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t("deal.delete", "Delete deal")}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Pointer-independent movement. Drag-and-drop is the enhancement; this
            native select is the baseline that works on touch, with a keyboard and
            with a screen reader. It is deliberately not a custom popup. */}
        <label className="sr-only" htmlFor={`move-${deal.id}`}>
          {t("deal.moveLabel", "Move {{title}} to stage", { title: deal.title })}
        </label>
        <select
          id={`move-${deal.id}`}
          className="h-8 w-full rounded-md border bg-background px-2 text-xs"
          value=""
          disabled={!canWrite || otherStages.length === 0}
          onChange={(event) => {
            const target = otherStages.find((stage) => stage.id === event.target.value);
            if (target) onMoveToStage(deal, target);
          }}
        >
          <option value="">{t("deal.moveToStage", "Move to stage…")}</option>
          {otherStages.map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.name}
            </option>
          ))}
        </select>

        <div className="flex flex-wrap items-center gap-2">
          {amountLabel ? <Badge variant="secondary">{amountLabel}</Badge> : null}
          {deal.assigned_to ? <Badge variant="outline">{t("deal.assigned", "Assigned")}</Badge> : null}
          {activityLabel ? (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <MessageSquare className="h-3 w-3" />
              {activityLabel}
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
