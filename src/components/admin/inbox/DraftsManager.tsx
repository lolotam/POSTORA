import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { sanitizeEmailHtml } from "@/lib/sanitizeHtml";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { format } from "date-fns";
import { ArrowLeft, FileEdit, Trash2, Loader2, Mail, PenLine } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export interface EmailDraft {
  id: string;
  admin_id: string;
  from_email: string;
  to_emails: string[];
  cc_emails: string[];
  bcc_emails: string[];
  subject: string | null;
  body: string | null;
  html_body: string | null;
  attachments: Array<{ id: string; name: string; url: string; path: string; type: string; size: number }> | null;
  reply_to_message_id: string | null;
  signature_id: string | null;
  created_at: string;
  updated_at: string;
}

interface DraftsManagerProps {
  onEditDraft: (draft: EmailDraft) => void;
}

export function DraftsManager({ onEditDraft }: DraftsManagerProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);

  const { data: drafts = [], isLoading } = useQuery({
    queryKey: ["email-drafts"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("email_drafts")
        .select("*")
        .order("updated_at", { ascending: false });

      if (error) throw error;
      return data as EmailDraft[];
    },
    enabled: !!user,
  });

  const deleteDraftMutation = useMutation({
    mutationFn: async (draftId: string) => {
      const { error } = await supabase
        .from("email_drafts")
        .delete()
        .eq("id", draftId);

      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Draft deleted");
      queryClient.invalidateQueries({ queryKey: ["email-drafts"] });
      setSelectedDraftId(null);
    },
    onError: (error) => {
      toast.error(`Failed to delete draft: ${error.message}`);
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (drafts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-[400px] text-muted-foreground">
        <PenLine className="w-12 h-12 mb-4 opacity-20" />
        <p className="text-lg font-medium">No drafts</p>
        <p className="text-sm mt-1">Drafts you save will appear here</p>
      </div>
    );
  }

  const selectedDraft = drafts.find(d => d.id === selectedDraftId);

  return (
    // Below md only one pane fits: the list, or the selected draft with Back.
    <div className="flex gap-4 h-[calc(100vh-340px)] min-h-[500px]">
      {/* Drafts List */}
      <div
        className={cn(
          "w-full md:w-1/3 md:min-w-[300px] border rounded-lg overflow-hidden bg-card",
          selectedDraft && "max-md:hidden"
        )}
      >
        <ScrollArea className="h-full max-lg:[&>[data-radix-scroll-area-viewport]>div]:!block">
          <div className="divide-y">
            {drafts.map((draft) => (
              <button
                key={draft.id}
                onClick={() => setSelectedDraftId(draft.id)}
                className={cn(
                  "w-full text-start p-4 hover:bg-muted/50 transition-colors",
                  selectedDraftId === draft.id && "bg-muted"
                )}
              >
                <div className="flex items-start gap-3">
                  <div className="mt-1 p-1 rounded-full bg-amber-500/10 text-amber-500">
                    <FileEdit className="w-3 h-3" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {draft.to_emails.length > 0 
                        ? `To: ${draft.to_emails.join(", ")}` 
                        : "No recipient"}
                    </p>
                    <p className="text-sm text-muted-foreground truncate mt-0.5">
                      {draft.subject || "(No subject)"}
                    </p>
                    <div className="flex items-center justify-between mt-1 gap-2">
                      <p className="text-xs text-muted-foreground truncate flex-1">
                        {draft.body?.replace(/<[^>]*>/g, "").substring(0, 50) || "No content"}
                        {(draft.body?.length || 0) > 50 && "..."}
                      </p>
                      <span className="text-xs text-muted-foreground flex-shrink-0">
                        {format(new Date(draft.updated_at), "MMM d")}
                      </span>
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </ScrollArea>
      </div>

      {/* Draft Detail */}
      <div className={cn("flex-1 min-w-0 border rounded-lg overflow-hidden bg-card", !selectedDraft && "max-md:hidden")}>
        {selectedDraft ? (
          <div className="flex flex-col h-full">
            {/* Header */}
            <div className="p-4 border-b space-y-3">
              <Button variant="ghost" size="sm" className="md:hidden -ms-2" onClick={() => setSelectedDraftId(null)}>
                <ArrowLeft className="w-4 h-4 me-2 rtl-flip" />
                Back
              </Button>
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <h2 className="text-lg font-semibold truncate">
                    {selectedDraft.subject || "(No subject)"}
                  </h2>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1 text-sm text-muted-foreground">
                    <span className="p-1 rounded-full bg-amber-500/10 text-amber-500">
                      <FileEdit className="w-3 h-3" />
                    </span>
                    <span>Draft</span>
                    <span>•</span>
                    <span>Last edited {format(new Date(selectedDraft.updated_at), "MMM d, yyyy 'at' h:mm a")}</span>
                  </div>
                </div>

                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive">
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete this draft?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This action cannot be undone. The draft will be permanently deleted.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => deleteDraftMutation.mutate(selectedDraft.id)}
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      >
                        Delete
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>

              {/* To/From details */}
              <div className="text-sm text-muted-foreground space-y-1 break-words">
                <p>From: {selectedDraft.from_email}</p>
                <p>To: {selectedDraft.to_emails.length > 0 ? selectedDraft.to_emails.join(", ") : "(no recipient)"}</p>
                {selectedDraft.cc_emails.length > 0 && (
                  <p>CC: {selectedDraft.cc_emails.join(", ")}</p>
                )}
                {selectedDraft.bcc_emails.length > 0 && (
                  <p>BCC: {selectedDraft.bcc_emails.join(", ")}</p>
                )}
              </div>
            </div>

            {/* Body Preview */}
            <ScrollArea className="flex-1 p-4 max-lg:[&>[data-radix-scroll-area-viewport]>div]:!block">
              {selectedDraft.html_body ? (
                <div
                  className="prose prose-sm dark:prose-invert max-w-none"
                  dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(selectedDraft.html_body) }}
                />
              ) : selectedDraft.body ? (
                <pre className="text-sm whitespace-pre-wrap font-sans">
                  {selectedDraft.body}
                </pre>
              ) : (
                <p className="text-muted-foreground text-sm">No content</p>
              )}
            </ScrollArea>

            {/* Action buttons */}
            <div className="p-4 border-t">
              <Button 
                onClick={() => onEditDraft(selectedDraft)}
                className="w-full"
              >
                <PenLine className="w-4 h-4 me-2" />
                Continue Editing
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Mail className="w-12 h-12 mb-4 opacity-20" />
            <p className="text-sm">Select a draft to view details</p>
          </div>
        )}
      </div>
    </div>
  );
}
