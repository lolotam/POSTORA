import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tag, Plus, X, Check } from "lucide-react";
import { useWhatsAppLabels, type ConversationLabel } from "@/hooks/useWhatsAppLabels";
import { toast } from "sonner";

const LABEL_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#6366f1", "#a855f7", "#ec4899",
];

interface ConversationLabelsProps {
  conversationId: string;
  compact?: boolean;
}

export function ConversationLabelChips({ conversationId }: { conversationId: string }) {
  const { getLabelsForConversation } = useWhatsAppLabels();
  const labels = getLabelsForConversation(conversationId);
  if (labels.length === 0) return null;

  return (
    <div className="flex gap-1 flex-wrap">
      {labels.map((l) => (
        <span key={l.id} className="inline-block rounded-full px-1.5 py-0 text-[10px] text-white font-medium" style={{ backgroundColor: l.color }}>
          {l.name}
        </span>
      ))}
    </div>
  );
}

export function ConversationLabelPicker({ conversationId }: ConversationLabelsProps) {
  const { t } = useTranslation("inbox");
  const { labels, getLabelsForConversation, assignLabel, unassignLabel, createLabel } = useWhatsAppLabels();
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(LABEL_COLORS[0]);
  const [creating, setCreating] = useState(false);

  const assigned = getLabelsForConversation(conversationId);
  const assignedIds = new Set(assigned.map((l) => l.id));

  const toggle = (label: ConversationLabel) => {
    if (assignedIds.has(label.id)) {
      unassignLabel.mutate({ conversationId, labelId: label.id });
    } else {
      assignLabel.mutate({ conversationId, labelId: label.id });
    }
  };

  const handleCreate = () => {
    if (!newName.trim()) return;
    createLabel.mutate({ name: newName.trim(), color: newColor }, {
      onSuccess: () => { setNewName(""); setCreating(false); toast.success(t("labels.created", "Label created")); },
      onError: (e: any) => toast.error(e.message),
    });
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" title={t("labels.title", "Labels")}>
          <Tag className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-2" align="end">
        <p className="text-xs font-medium mb-2 px-1">{t("labels.title", "Labels")}</p>
        <div className="space-y-1 max-h-40 overflow-y-auto">
          {labels.map((l) => (
            <button key={l.id} onClick={() => toggle(l)} className="flex items-center gap-2 w-full rounded px-2 py-1 text-sm hover:bg-muted transition-colors">
              <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: l.color }} />
              <span className="flex-1 text-start truncate">{l.name}</span>
              {assignedIds.has(l.id) && <Check className="h-3.5 w-3.5 text-primary" />}
            </button>
          ))}
        </div>
        {creating ? (
          <div className="mt-2 space-y-2 border-t pt-2">
            <Input placeholder={t("labels.name", "Label name")} value={newName} onChange={(e) => setNewName(e.target.value)} className="h-7 text-xs" />
            <div className="flex gap-1">
              {LABEL_COLORS.map((c) => (
                <button key={c} onClick={() => setNewColor(c)} className="w-5 h-5 rounded-full border-2 transition-all" style={{ backgroundColor: c, borderColor: c === newColor ? "var(--foreground)" : "transparent" }} />
              ))}
            </div>
            <div className="flex gap-1">
              <Button size="sm" className="h-6 text-xs flex-1" onClick={handleCreate} disabled={createLabel.isPending}>{t("common:create", "Create")}</Button>
              <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setCreating(false)}><X className="h-3 w-3" /></Button>
            </div>
          </div>
        ) : (
          <Button variant="ghost" size="sm" className="w-full mt-1 h-7 text-xs gap-1" onClick={() => setCreating(true)}>
            <Plus className="h-3 w-3" /> {t("labels.new", "New Label")}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function LabelFilter({ selectedLabelId, onSelect }: { selectedLabelId: string | null; onSelect: (id: string | null) => void }) {
  const { t } = useTranslation("inbox");
  const { labels } = useWhatsAppLabels();
  if (labels.length === 0) return null;

  return (
    <div className="flex gap-1 flex-wrap px-3 pb-2">
      <Badge variant={selectedLabelId === null ? "default" : "outline"} className="cursor-pointer text-xs" onClick={() => onSelect(null)}>{t("common:all", "All")}</Badge>
      {labels.map((l) => (
        <Badge key={l.id} variant={selectedLabelId === l.id ? "default" : "outline"} className="cursor-pointer text-xs gap-1" onClick={() => onSelect(selectedLabelId === l.id ? null : l.id)}>
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: l.color }} />
          {l.name}
        </Badge>
      ))}
    </div>
  );
}
