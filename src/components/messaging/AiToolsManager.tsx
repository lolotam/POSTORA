import { useState } from "react";
import { Globe, Loader2, Pencil, Plus, ShieldCheck, Trash2, Wrench } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useAiAgentTools, type AiAgentTool, type AiAgentToolInput } from "@/hooks/useAiAgentTools";
import { validateAiToolName, validateAiToolUrl } from "@/lib/aiTools";

const emptyForm: AiAgentToolInput = {
  name: "",
  description: "",
  url: "",
  secret: "",
  is_enabled: true,
  admin_only: false,
};

// Connector tools: each maps to an external webhook (typically an n8n
// workflow) the AI agent can call. n8n holds the real credentials (Gmail,
// Calendar, CRM, ...) so Postora never stores them.
export function AiToolsManager() {
  const { tools, isLoading, upsertTool, deleteTool } = useAiAgentTools();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [form, setForm] = useState<AiAgentToolInput>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);

  const openCreate = () => {
    setForm(emptyForm);
    setEditingName(null);
    setFormError(null);
    setDialogOpen(true);
  };

  const openEdit = (tool: AiAgentTool) => {
    setForm({
      name: tool.name,
      description: tool.description,
      url: tool.url || "",
      secret: tool.secret || "",
      is_enabled: tool.is_enabled,
      admin_only: tool.admin_only,
    });
    setEditingName(tool.name);
    setFormError(null);
    setDialogOpen(true);
  };

  const save = () => {
    const error =
      validateAiToolName(form.name) ||
      validateAiToolUrl(form.url) ||
      (form.description.trim() ? null : "Description is required — the AI uses it to decide when to call the tool.");
    if (error) {
      setFormError(error);
      return;
    }
    upsertTool.mutate(
      { ...form, secret: form.secret || null },
      {
        onSuccess: () => {
          toast.success(editingName ? "Connector updated" : "Connector added");
          setDialogOpen(false);
        },
        onError: (mutationError) => setFormError(mutationError.message),
      },
    );
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Connector tools</h3>
          <p className="text-sm text-muted-foreground">
            Webhooks (e.g. n8n workflows) the AI can call — send emails, book
            appointments, query your systems. Credentials stay in n8n.
          </p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-1.5" onClick={openCreate}>
              <Plus className="h-4 w-4" /> Add connector
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingName ? "Edit connector" : "Add connector"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="tool-name">Name (snake_case)</Label>
                <Input
                  id="tool-name"
                  placeholder="book_appointment"
                  value={form.name}
                  disabled={!!editingName}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tool-description">Description (shown to the AI)</Label>
                <Textarea
                  id="tool-description"
                  placeholder="Book an appointment in the salon calendar. Needs the customer's name, phone, service, and preferred time."
                  rows={3}
                  value={form.description}
                  onChange={(event) => setForm({ ...form, description: event.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tool-url">Webhook URL</Label>
                <Input
                  id="tool-url"
                  placeholder="https://n8n.example.com/webhook/book-appointment"
                  value={form.url}
                  onChange={(event) => setForm({ ...form, url: event.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tool-secret">
                  Secret <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="tool-secret"
                  placeholder="Sent as X-Webhook-Secret header"
                  value={form.secret || ""}
                  onChange={(event) => setForm({ ...form, secret: event.target.value })}
                />
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Switch
                    id="tool-admin-only"
                    checked={!!form.admin_only}
                    onCheckedChange={(checked) => setForm({ ...form, admin_only: checked })}
                  />
                  <Label htmlFor="tool-admin-only">Admin only</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    id="tool-enabled"
                    checked={form.is_enabled !== false}
                    onCheckedChange={(checked) => setForm({ ...form, is_enabled: checked })}
                  />
                  <Label htmlFor="tool-enabled">Enabled</Label>
                </div>
              </div>
              {formError && <p className="text-sm text-destructive">{formError}</p>}
              <Button onClick={save} disabled={upsertTool.isPending} className="w-full">
                {upsertTool.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {editingName ? "Save changes" : "Add connector"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {tools.length === 0 ? (
        <Card>
          <CardContent className="flex min-h-48 flex-col items-center justify-center text-center">
            <Wrench className="mb-3 h-9 w-9 text-muted-foreground/50" />
            <p className="font-medium">No connectors yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Add an n8n webhook so the AI can act — email, calendar, CRM, and more.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {tools.map((tool) => (
            <Card key={tool.id}>
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="flex items-center gap-2 text-base">
                      {tool.name}
                      {!tool.is_enabled && <Badge variant="secondary">disabled</Badge>}
                      {tool.admin_only && (
                        <Badge variant="outline" className="gap-1">
                          <ShieldCheck className="h-3 w-3" /> admin only
                        </Badge>
                      )}
                    </CardTitle>
                    <CardDescription className="mt-1 line-clamp-2">{tool.description}</CardDescription>
                    <p className="mt-1 flex items-center gap-1 truncate text-xs text-muted-foreground">
                      <Globe className="h-3 w-3 shrink-0" /> {tool.url}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button size="icon" variant="ghost" aria-label={`Edit ${tool.name}`} onClick={() => openEdit(tool)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Delete ${tool.name}`}
                      disabled={deleteTool.isPending}
                      onClick={() =>
                        deleteTool.mutate(tool.id, {
                          onSuccess: () => toast.success("Connector deleted"),
                          onError: (error) => toast.error(error.message),
                        })
                      }
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
