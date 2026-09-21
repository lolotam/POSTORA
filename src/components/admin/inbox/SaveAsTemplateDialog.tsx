import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { Save, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface SaveAsTemplateDialogProps {
  subject: string;
  body: string;
  disabled?: boolean;
}

export function SaveAsTemplateDialog({
  subject,
  body,
  disabled,
}: SaveAsTemplateDialogProps) {
  const [open, setOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const queryClient = useQueryClient();

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!templateName.trim()) {
        throw new Error("Template name is required");
      }

      const { data: session } = await supabase.auth.getSession();
      if (!session.session) {
        throw new Error("Not authenticated");
      }

      const slug = templateName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      const { error } = await supabase.from("email_templates").insert({
        created_by: session.session.user.id,
        name: templateName.trim(),
        slug: slug || `template-${Date.now()}`,
        subject: subject || "",
        body_html: body || "",
      });

      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`Template "${templateName}" saved successfully!`);
      queryClient.invalidateQueries({ queryKey: ["email-templates"] });
      setOpen(false);
      setTemplateName("");
    },
    onError: (error) => {
      toast.error(`Failed to save template: ${error.message}`);
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button 
          variant="outline" 
          size="sm" 
          disabled={disabled || (!subject && !body)}
          title="Save current email as a reusable template"
        >
          <Save className="h-4 w-4 me-2" />
          Save as Template
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Save className="h-5 w-5" />
            Save as Template
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="template-name">Template Name</Label>
            <Input
              id="template-name"
              placeholder="e.g., Welcome Email, Follow-up, Newsletter..."
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && templateName.trim()) {
                  saveMutation.mutate();
                }
              }}
            />
          </div>

          <div className="bg-muted/50 p-3 rounded-lg space-y-2 text-sm">
            <div>
              <span className="text-muted-foreground">Subject: </span>
              <span className="font-medium">{subject || "(No subject)"}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Content: </span>
              <span className="text-muted-foreground line-clamp-2">
                {body ? body.replace(/<[^>]*>/g, "").slice(0, 100) + "..." : "(No content)"}
              </span>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={!templateName.trim() || saveMutation.isPending}
          >
            {saveMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 me-2 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="h-4 w-4 me-2" />
                Save Template
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
