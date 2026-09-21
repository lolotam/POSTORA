import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Loader2, FileText, Trash2, Edit2, Plus, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { RichTextEditor } from "./RichTextEditor";

interface EmailTemplate {
  id: string;
  name: string;
  slug: string;
  subject: string;
  body_html: string | null;
  body_text: string | null;
  is_active: boolean | null;
  created_at: string;
  created_by: string | null;
}

interface EmailTemplateManagerProps {
  onSelectTemplate: (template: { subject: string; body: string }) => void;
  currentSubject?: string;
  currentBody?: string;
}

export function EmailTemplateManager({
  onSelectTemplate,
  currentSubject = "",
  currentBody = "",
}: EmailTemplateManagerProps) {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<EmailTemplate | null>(null);
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  // Fetch templates
  const { data: templates = [], isLoading } = useQuery({
    queryKey: ["email-templates"],
    queryFn: async () => {
      const { data: session } = await supabase.auth.getSession();
      if (!session.session) return [];

      const { data, error } = await supabase
        .from("email_templates")
        .select("id, name, slug, subject, body_html, body_text, is_active, created_at, created_by")
        .eq("created_by", session.session.user.id)
        .order("name");

      if (error) throw error;
      return (data || []) as EmailTemplate[];
    },
  });

  // Create mutation
  const createMutation = useMutation({
    mutationFn: async () => {
      const { data: session } = await supabase.auth.getSession();
      if (!session.session) throw new Error("Not authenticated");

      const slugVal = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || `template-${Date.now()}`;
      const { data, error } = await supabase
        .from("email_templates")
        .insert({
          created_by: session.session.user.id,
          name,
          slug: slugVal,
          subject,
          body_html: body,
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Template created");
      queryClient.invalidateQueries({ queryKey: ["email-templates"] });
      resetForm();
    },
    onError: (error) => {
      toast.error(`Failed to create template: ${error.message}`);
    },
  });

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!editingTemplate) return;

      const slugVal = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || `template-${Date.now()}`;
      const { error } = await supabase
        .from("email_templates")
        .update({
          name,
          slug: slugVal,
          subject,
          body_html: body,
        })
        .eq("id", editingTemplate.id);

      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Template updated");
      queryClient.invalidateQueries({ queryKey: ["email-templates"] });
      resetForm();
    },
    onError: (error) => {
      toast.error(`Failed to update template: ${error.message}`);
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("email_templates").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Template deleted");
      queryClient.invalidateQueries({ queryKey: ["email-templates"] });
    },
    onError: (error) => {
      toast.error(`Failed to delete template: ${error.message}`);
    },
  });

  const resetForm = () => {
    setName("");
    setSubject("");
    setBody("");
    setEditingTemplate(null);
    setDialogOpen(false);
  };

  const handleEdit = (template: EmailTemplate) => {
    setEditingTemplate(template);
    setName(template.name);
    setSubject(template.subject);
    setBody(template.body_html || template.body_text || "");
    setDialogOpen(true);
  };

  const handleSaveCurrentAsTemplate = () => {
    setName("");
    setSubject(currentSubject);
    setBody(currentBody);
    setEditingTemplate(null);
    setDialogOpen(true);
  };

  const handleSubmit = () => {
    if (!name.trim()) {
      toast.error("Template name is required");
      return;
    }
    if (editingTemplate) {
      updateMutation.mutate();
    } else {
      createMutation.mutate();
    }
  };

  return (
    <div className="flex items-center gap-2">
      {/* Template selector dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="text-xs">
            <FileText className="h-3 w-3 me-1" />
            Templates
            <ChevronDown className="h-3 w-3 ms-1" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[250px]">
          {templates.length === 0 ? (
            <div className="p-2 text-sm text-muted-foreground text-center">
              No templates yet
            </div>
          ) : (
            templates.map((template) => (
              <DropdownMenuItem
                key={template.id}
                onClick={() => onSelectTemplate({ subject: template.subject, body: template.body_html || template.body_text || "" })}
                className="flex flex-col items-start gap-1"
              >
                <span className="font-medium">{template.name}</span>
                <span className="text-xs text-muted-foreground truncate max-w-[220px]">
                  {template.subject || "(No subject)"}
                </span>
              </DropdownMenuItem>
            ))
          )}
          <div className="border-t mt-1 pt-1">
            {(currentSubject || currentBody) && (
              <DropdownMenuItem onClick={handleSaveCurrentAsTemplate}>
                <Plus className="h-3 w-3 me-2" />
                Save current as template
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => setDialogOpen(true)}>
              <Edit2 className="h-3 w-3 me-2" />
              Manage templates
            </DropdownMenuItem>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Template management dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => {
        if (!open) resetForm();
        setDialogOpen(open);
      }}>
        <DialogContent className="sm:max-w-[700px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingTemplate ? "Edit Template" : "Manage Email Templates"}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {/* Existing templates list */}
            {!editingTemplate && templates.length > 0 && (
              <div className="space-y-2">
                <Label>Your Templates</Label>
                <div className="border rounded-md divide-y max-h-[200px] overflow-auto">
                  {templates.map((template) => (
                    <div
                      key={template.id}
                      className="flex items-center justify-between p-3 hover:bg-muted/50"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-sm truncate">{template.name}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {template.subject || "(No subject)"}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 ms-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onSelectTemplate({ subject: template.subject, body: template.body_html || template.body_text || "" })}
                        >
                          Use
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => handleEdit(template)}
                        >
                          <Edit2 className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive"
                          onClick={() => deleteMutation.mutate(template.id)}
                          disabled={deleteMutation.isPending}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Create/Edit form */}
            <div className="space-y-4 pt-4 border-t">
              <h4 className="font-medium text-sm">
                {editingTemplate ? "Edit Template" : "Create New Template"}
              </h4>

              <div className="space-y-2">
                <Label htmlFor="template-name">Template Name</Label>
                <Input
                  id="template-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., Welcome Email, Follow-up"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="template-subject">Subject Line</Label>
                <Input
                  id="template-subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Email subject..."
                />
              </div>

              <div className="space-y-2">
                <Label>Email Body</Label>
                <RichTextEditor
                  value={body}
                  onChange={setBody}
                  placeholder="Write your template content..."
                  minHeight="150px"
                />
              </div>

              <div className="flex justify-end gap-2">
                {editingTemplate && (
                  <Button variant="outline" onClick={resetForm}>
                    Cancel
                  </Button>
                )}
                <Button
                  onClick={handleSubmit}
                  disabled={createMutation.isPending || updateMutation.isPending}
                >
                  {(createMutation.isPending || updateMutation.isPending) && (
                    <Loader2 className="h-4 w-4 me-2 animate-spin" />
                  )}
                  {editingTemplate ? "Update" : "Create"}
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
