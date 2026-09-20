import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { BookMarked, ChevronDown, Check, Pencil, Copy, Trash2, X } from "lucide-react";
import { useCaptionHistory, type CaptionHistoryItem } from "@/hooks/useCaptionHistory";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

interface CaptionHistorySectionProps {
  onUseCaption: (caption: string) => void;
}

export function CaptionHistorySection({ onUseCaption }: CaptionHistorySectionProps) {
  const { t } = useTranslation("post");
  const { history, isLoading, update, remove } = useCaptionHistory();
  const [open, setOpen] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const startEdit = (item: CaptionHistoryItem) => {
    setEditingId(item.id);
    setEditText(item.caption);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditText("");
  };

  const saveEdit = async () => {
    if (!editingId || !editText.trim()) return;
    await update(editingId, editText.trim());
    cancelEdit();
  };

  const handleCopy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    toast({
      title: t("captionHistory.copiedTitle", "Copied"),
      description: t("captionHistory.copiedDesc", "Caption copied to clipboard."),
    });
  };

  const handleDelete = async () => {
    if (!confirmDeleteId) return;
    await remove(confirmDeleteId);
    setConfirmDeleteId(null);
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };

  if (isLoading) return null;

  return (
    <>
      <Collapsible open={open} onOpenChange={setOpen} className="space-y-2 border-t pt-4">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex items-center justify-between w-full group"
          >
            <Label className="text-sm flex items-center gap-2 cursor-pointer">
              <BookMarked className="w-4 h-4 text-primary" />
              {t("captionHistory.title", "Caption History")} {history.length > 0 && `(${history.length})`}
            </Label>
            <ChevronDown
              className={cn(
                "w-4 h-4 text-muted-foreground transition-transform",
                open && "rotate-180"
              )}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-2">
          {history.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">
              {t("captionHistory.empty", "Saved captions will appear here.")}
            </p>
          ) : (
            <div className="space-y-2 max-h-[280px] overflow-y-auto pr-1">
              {history.map((item) => (
                <div
                  key={item.id}
                  className="border border-border rounded-lg p-3 bg-card space-y-2"
                >
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-1 flex-wrap">
                      {item.tone && (
                        <Badge variant="secondary" className="text-[10px] h-5">
                          {item.tone}
                        </Badge>
                      )}
                      {item.language && (
                        <Badge variant="outline" className="text-[10px] h-5">
                          {item.language}
                        </Badge>
                      )}
                      {item.platform && (
                        <Badge variant="outline" className="text-[10px] h-5">
                          {item.platform}
                        </Badge>
                      )}
                    </div>
                    <span className="text-[10px] text-muted-foreground">
                      {formatDate(item.created_at)}
                    </span>
                  </div>

                  {editingId === item.id ? (
                    <div className="space-y-2">
                      <Textarea
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        className="min-h-[80px] text-sm"
                        dir={item.language === "arabic" ? "rtl" : "ltr"}
                      />
                      <div className="flex gap-2 justify-end">
                        <Button size="sm" variant="ghost" onClick={cancelEdit}>
                          <X className="w-3 h-3 mr-1" /> {t("common:cancel", "Cancel")}
                        </Button>
                        <Button size="sm" onClick={saveEdit} disabled={!editText.trim()}>
                          <Check className="w-3 h-3 mr-1" /> {t("common:save", "Save")}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p
                        className="text-sm leading-relaxed line-clamp-3"
                        dir={item.language === "arabic" ? "rtl" : "ltr"}
                      >
                        {item.caption}
                      </p>
                      <div className="flex items-center gap-1 flex-wrap">
                        <Button
                          size="sm"
                          variant="default"
                          className="h-7 text-xs"
                          onClick={() => onUseCaption(item.caption)}
                        >
                          <Check className="w-3 h-3 mr-1" /> {t("captionHistory.use", "Use")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs"
                          onClick={() => startEdit(item)}
                        >
                          <Pencil className="w-3 h-3 mr-1" /> {t("captionHistory.edit", "Edit")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs"
                          onClick={() => handleCopy(item.caption)}
                        >
                          <Copy className="w-3 h-3 mr-1" /> {t("captionHistory.copy", "Copy")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs text-destructive hover:text-destructive"
                          onClick={() => setConfirmDeleteId(item.id)}
                        >
                          <Trash2 className="w-3 h-3 mr-1" /> {t("common:delete", "Delete")}
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>

      <AlertDialog
        open={!!confirmDeleteId}
        onOpenChange={(o) => !o && setConfirmDeleteId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("captionHistory.deleteTitle", "Delete saved caption?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("captionHistory.deleteDesc", "This will permanently remove the caption from your history. This action cannot be undone.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel", "Cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>{t("common:delete", "Delete")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
