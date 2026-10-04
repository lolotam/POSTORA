import { useState, useEffect } from "react";
import { format } from "date-fns";
import { Loader2, Trash2, FileText, Plus, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Icon3D } from "@/components/fx/Icon3D";
import { Reveal } from "@/components/fx/Reveal";
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

interface WorkflowListItem {
  id: string;
  name: string;
  description: string | null;
  updated_at: string;
  created_at: string;
}

interface WorkflowListDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLoad: (workflowId: string) => void;
  onNew: () => void;
  currentWorkflowId: string | null;
}

export function WorkflowListDrawer({ open, onOpenChange, onLoad, onNew, currentWorkflowId }: WorkflowListDrawerProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [workflows, setWorkflows] = useState<WorkflowListItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  useEffect(() => {
    if (open && user) {
      setIsLoading(true);
      supabase
        .from("workflows")
        .select("id, name, description, updated_at, created_at")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false })
        .then(({ data, error }) => {
          if (!error && data) setWorkflows(data);
          setIsLoading(false);
        });
    }
  }, [open, user]);

  const handleDelete = async () => {
    if (!deleteId) return;
    const { error } = await supabase.from("workflows").delete().eq("id", deleteId);
    if (!error) {
      setWorkflows(w => w.filter(wf => wf.id !== deleteId));
      toast({ title: "Workflow deleted" });
    }
    setDeleteId(null);
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="left" className="w-[360px] sm:w-[400px] bg-card border-r border-white/10">
          <SheetHeader>
            <div className="flex items-center gap-3">
              <Icon3D icon={FolderOpen} variant="violet" size="sm" />
              <div>
                <SheetTitle className="text-foreground">
                  My Workflows
                </SheetTitle>
                <SheetDescription>Load or manage your saved workflows</SheetDescription>
              </div>
            </div>
          </SheetHeader>
          
          <div className="mt-4">
            <Button
              className="w-full gap-2 text-white border-0 shadow-lg hover:brightness-110 bg-violet-500"
              onClick={() => { onNew(); onOpenChange(false); }}
            >
              <Plus className="h-4 w-4" /> New Workflow
            </Button>
          </div>

          <ScrollArea className="h-[calc(100vh-200px)] mt-4">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-violet-400" />
              </div>
            ) : workflows.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <FileText className="h-10 w-10 mx-auto mb-3 opacity-50" />
                <p className="text-sm">No workflows yet</p>
              </div>
            ) : (
              <div className="space-y-2">
                {workflows.map((wf, idx) => (
                  <Reveal key={wf.id} delay={idx * 40}>
                  <div
                    className={`group p-3 rounded-xl ring-1 cursor-pointer transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg ${
                      wf.id === currentWorkflowId
                        ? "ring-violet-400/60 bg-violet-500/10"
                        : "ring-white/10 bg-white/[0.03] hover:bg-white/[0.06] hover:ring-violet-400/40"
                    }`}
                    onClick={() => { onLoad(wf.id); onOpenChange(false); }}
                  >
                    <div className="flex items-start justify-between">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-sm truncate">{wf.name}</p>
                        {wf.description && (
                          <p className="text-xs text-muted-foreground truncate mt-0.5">{wf.description}</p>
                        )}
                        <p className="text-[10px] text-muted-foreground mt-1">
                          Updated {format(new Date(wf.updated_at), "MMM d, yyyy h:mm a")}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                        onClick={(e) => { e.stopPropagation(); setDeleteId(wf.id); }}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </div>
                  </div>
                  </Reveal>
                ))}
              </div>
            )}
          </ScrollArea>
        </SheetContent>
      </Sheet>

      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete workflow?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground" onClick={handleDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
