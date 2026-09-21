import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Plus, Pencil, Trash2, Zap, Loader2 } from "lucide-react";
import { useWhatsAppQuickReplies, useCreateQuickReply, useUpdateQuickReply, useDeleteQuickReply } from "@/hooks/useWhatsAppQuickReplies";
import { toast } from "sonner";

export function QuickReplyManager() {
  const { t } = useTranslation("inbox");
  const { data: replies = [], isLoading } = useWhatsAppQuickReplies();
  const createMutation = useCreateQuickReply();
  const updateMutation = useUpdateQuickReply();
  const deleteMutation = useDeleteQuickReply();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [shortcut, setShortcut] = useState("");

  const resetForm = () => {
    setTitle("");
    setMessage("");
    setShortcut("");
    setEditId(null);
  };

  const openCreate = () => {
    resetForm();
    setDialogOpen(true);
  };

  const openEdit = (reply: typeof replies[0]) => {
    setEditId(reply.id);
    setTitle(reply.title);
    setMessage(reply.message);
    setShortcut(reply.shortcut || "");
    setDialogOpen(true);
  };

  const handleSave = () => {
    if (!title.trim() || !message.trim()) {
      toast.error(t("quickReply.required", "Title and message are required"));
      return;
    }
    const shortcutVal = shortcut.trim() ? (shortcut.trim().startsWith("/") ? shortcut.trim() : "/" + shortcut.trim()) : undefined;

    if (editId) {
      updateMutation.mutate(
        { id: editId, title: title.trim(), message: message.trim(), shortcut: shortcutVal || null },
        {
          onSuccess: () => { toast.success(t("quickReply.updated", "Quick reply updated")); setDialogOpen(false); resetForm(); },
          onError: (e) => toast.error(e.message),
        }
      );
    } else {
      createMutation.mutate(
        { title: title.trim(), message: message.trim(), shortcut: shortcutVal },
        {
          onSuccess: () => { toast.success(t("quickReply.created", "Quick reply created")); setDialogOpen(false); resetForm(); },
          onError: (e) => toast.error(e.message),
        }
      );
    }
  };

  const handleDelete = (id: string) => {
    deleteMutation.mutate(id, {
      onSuccess: () => toast.success(t("quickReply.deleted", "Quick reply deleted")),
      onError: (e) => toast.error(e.message),
    });
  };

  const isSaving = createMutation.isPending || updateMutation.isPending;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">{t("quickReply.title", "Quick Replies")}</h3>
          <p className="text-sm text-muted-foreground">{t("quickReply.subtitle", "Save frequently used messages for one-click insertion")}</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}>
          <DialogTrigger asChild>
            <Button onClick={openCreate} className="gap-1.5">
              <Plus className="w-4 h-4" /> {t("quickReply.add", "Add Quick Reply")}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editId ? t("quickReply.edit", "Edit Quick Reply") : t("quickReply.new", "New Quick Reply")}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <div>
                <label className="text-sm font-medium mb-1 block">{t("quickReply.titleField", "Title")}</label>
                <Input placeholder={t("quickReply.titlePlaceholder", "e.g. Thank you")} value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">{t("quickReply.message", "Message")}</label>
                <Textarea placeholder={t("quickReply.messagePlaceholder", "The message to insert...")} value={message} onChange={(e) => setMessage(e.target.value)} rows={4} />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">{t("quickReply.shortcut", "Shortcut (optional)")}</label>
                <Input placeholder={t("quickReply.shortcutPlaceholder", "/thanks")} value={shortcut} onChange={(e) => setShortcut(e.target.value)} />
                <p className="text-xs text-muted-foreground mt-1">{t("quickReply.shortcutHint", "Type this in chat to quickly find this reply")}</p>
              </div>
              <Button onClick={handleSave} disabled={isSaving} className="w-full">
                {isSaving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                {editId ? t("quickReply.update", "Update") : t("common:create", "Create")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {replies.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Zap className="w-10 h-10 text-muted-foreground mb-3" />
            <p className="font-medium">{t("quickReply.empty", "No quick replies yet")}</p>
            <p className="text-sm text-muted-foreground mb-4">{t("quickReply.emptyHint", "Create shortcuts for messages you send often")}</p>
            <Button variant="outline" onClick={openCreate} className="gap-1.5">
              <Plus className="w-4 h-4" /> {t("quickReply.createFirst", "Create your first")}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {replies.map((reply) => (
            <Card key={reply.id}>
              <CardContent className="p-4 flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <p className="font-medium text-sm">{reply.title}</p>
                    {reply.shortcut && (
                      <Badge variant="secondary" className="text-xs font-mono">{reply.shortcut}</Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground line-clamp-2">{reply.message}</p>
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(reply)}>
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => handleDelete(reply.id)} disabled={deleteMutation.isPending}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
