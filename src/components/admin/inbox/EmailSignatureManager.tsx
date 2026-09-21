import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Loader2, Plus, Trash2, Edit2, Settings } from "lucide-react";
import { toast } from "sonner";

interface EmailSignature {
  id: string;
  name: string;
  content: string;
  is_default: boolean;
  created_at: string;
}

interface EmailSignatureManagerProps {
  selectedSignatureId?: string | null;
  onSelectSignature: (signature: EmailSignature | null) => void;
}

export function EmailSignatureManager({
  selectedSignatureId,
  onSelectSignature,
}: EmailSignatureManagerProps) {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSignature, setEditingSignature] = useState<EmailSignature | null>(null);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [isDefault, setIsDefault] = useState(false);

  // Fetch signatures
  const { data: signatures = [], isLoading } = useQuery({
    queryKey: ["email-signatures"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("email_signatures")
        .select("*")
        .order("is_default", { ascending: false })
        .order("name");

      if (error) throw error;
      return data as EmailSignature[];
    },
  });

  // Create mutation
  const createMutation = useMutation({
    mutationFn: async () => {
      const { data: session } = await supabase.auth.getSession();
      if (!session.session) throw new Error("Not authenticated");

      // If setting as default, unset other defaults first
      if (isDefault) {
        await supabase
          .from("email_signatures")
          .update({ is_default: false })
          .eq("admin_id", session.session.user.id);
      }

      const { data, error } = await supabase
        .from("email_signatures")
        .insert({
          admin_id: session.session.user.id,
          name,
          content,
          is_default: isDefault,
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Signature created");
      queryClient.invalidateQueries({ queryKey: ["email-signatures"] });
      resetForm();
    },
    onError: (error) => {
      toast.error(`Failed to create signature: ${error.message}`);
    },
  });

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!editingSignature) return;

      const { data: session } = await supabase.auth.getSession();
      if (!session.session) throw new Error("Not authenticated");

      // If setting as default, unset other defaults first
      if (isDefault && !editingSignature.is_default) {
        await supabase
          .from("email_signatures")
          .update({ is_default: false })
          .eq("admin_id", session.session.user.id);
      }

      const { error } = await supabase
        .from("email_signatures")
        .update({
          name,
          content,
          is_default: isDefault,
        })
        .eq("id", editingSignature.id);

      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Signature updated");
      queryClient.invalidateQueries({ queryKey: ["email-signatures"] });
      resetForm();
    },
    onError: (error) => {
      toast.error(`Failed to update signature: ${error.message}`);
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("email_signatures").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Signature deleted");
      queryClient.invalidateQueries({ queryKey: ["email-signatures"] });
      if (editingSignature && selectedSignatureId === editingSignature.id) {
        onSelectSignature(null);
      }
    },
    onError: (error) => {
      toast.error(`Failed to delete signature: ${error.message}`);
    },
  });

  const resetForm = () => {
    setName("");
    setContent("");
    setIsDefault(false);
    setEditingSignature(null);
    setDialogOpen(false);
  };

  const handleEdit = (signature: EmailSignature) => {
    setEditingSignature(signature);
    setName(signature.name);
    setContent(signature.content);
    setIsDefault(signature.is_default);
    setDialogOpen(true);
  };

  const handleSubmit = () => {
    if (!name.trim() || !content.trim()) {
      toast.error("Name and content are required");
      return;
    }
    if (editingSignature) {
      updateMutation.mutate();
    } else {
      createMutation.mutate();
    }
  };

  // Auto-select default signature
  const defaultSignature = signatures.find((s) => s.is_default);
  const selectedSignature = signatures.find((s) => s.id === selectedSignatureId);

  return (
    <div className="flex items-center gap-2">
      <Select
        value={selectedSignatureId || "none"}
        onValueChange={(value) => {
          if (value === "none") {
            onSelectSignature(null);
          } else {
            const sig = signatures.find((s) => s.id === value);
            onSelectSignature(sig || null);
          }
        }}
      >
        <SelectTrigger className="w-[180px] h-8 text-xs">
          <SelectValue placeholder="No signature" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">No signature</SelectItem>
          {signatures.map((sig) => (
            <SelectItem key={sig.id} value={sig.id}>
              {sig.name} {sig.is_default && "(Default)"}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Dialog open={dialogOpen} onOpenChange={(open) => {
        if (!open) resetForm();
        setDialogOpen(open);
      }}>
        <DialogTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8" title="Manage Signatures">
            <Settings className="h-4 w-4" />
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>
              {editingSignature ? "Edit Signature" : "Manage Signatures"}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {/* Existing signatures list */}
            {!editingSignature && signatures.length > 0 && (
              <div className="space-y-2">
                <Label>Your Signatures</Label>
                <div className="border rounded-md divide-y max-h-[200px] overflow-auto">
                  {signatures.map((sig) => (
                    <div
                      key={sig.id}
                      className="flex items-center justify-between p-3 hover:bg-muted/50"
                    >
                      <div>
                        <p className="font-medium text-sm">{sig.name}</p>
                        {sig.is_default && (
                          <span className="text-xs text-muted-foreground">Default</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => handleEdit(sig)}
                        >
                          <Edit2 className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive"
                          onClick={() => deleteMutation.mutate(sig.id)}
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
                {editingSignature ? "Edit Signature" : "Create New Signature"}
              </h4>
              
              <div className="space-y-2">
                <Label htmlFor="sig-name">Name</Label>
                <Input
                  id="sig-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., Work Signature"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="sig-content">Signature Content (HTML supported)</Label>
                <Textarea
                  id="sig-content"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="Best regards,&#10;John Doe&#10;Postora Team"
                  rows={5}
                />
              </div>

              <div className="flex items-center gap-2">
                <Switch
                  id="sig-default"
                  checked={isDefault}
                  onCheckedChange={setIsDefault}
                />
                <Label htmlFor="sig-default">Set as default signature</Label>
              </div>

              <div className="flex justify-end gap-2">
                {editingSignature && (
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
                  {editingSignature ? "Update" : "Create"}
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Hook to get the default signature
export function useDefaultSignature() {
  return useQuery({
    queryKey: ["email-signatures", "default"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("email_signatures")
        .select("*")
        .eq("is_default", true)
        .single();

      if (error && error.code !== "PGRST116") throw error;
      return data as EmailSignature | null;
    },
  });
}
