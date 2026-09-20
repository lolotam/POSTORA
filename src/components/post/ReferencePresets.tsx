import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { Save, FolderOpen, ChevronDown, Trash2, Loader2, ImageIcon } from "lucide-react";
import { ReferenceImage, ReferenceType } from "./DraggableReferenceImage";

interface ReferencePreset {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  reference_images: ReferenceImage[];
  created_at: string;
  updated_at: string;
}

interface ReferencePresetsProps {
  currentImages: ReferenceImage[];
  onLoadPreset: (images: ReferenceImage[]) => void;
}

export function ReferencePresets({ currentImages, onLoadPreset }: ReferencePresetsProps) {
  const { t } = useTranslation("postmedia");
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [deletePresetId, setDeletePresetId] = useState<string | null>(null);

  // Fetch presets
  const { data: presets = [], isLoading } = useQuery({
    queryKey: ["reference-presets", user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await supabase
        .from("image_reference_presets")
        .select("*")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false });
      
      if (error) throw error;
      return (data || []).map(p => ({
        ...p,
        reference_images: (p.reference_images as unknown as ReferenceImage[]) || [],
      })) as ReferencePreset[];
    },
    enabled: !!user,
  });

  // Save preset mutation
  const savePresetMutation = useMutation({
    mutationFn: async (name: string) => {
      if (!user) throw new Error("Not authenticated");
      
      // Convert to JSON-compatible format
      const referenceImagesJson = JSON.parse(JSON.stringify(currentImages));
      
      const { error } = await supabase
        .from("image_reference_presets")
        .insert([{
          user_id: user.id,
          name,
          reference_images: referenceImagesJson,
        }]);
      
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reference-presets"] });
      toast({ title: t("referencePresets.toastSaved", "Preset saved!"), description: t("referencePresets.toastSavedDesc", "\"{{name}}\" has been saved.", { name: presetName }) });
      setIsSaveDialogOpen(false);
      setPresetName("");
    },
    onError: (error) => {
      toast({
        title: t("referencePresets.toastSaveFailed", "Failed to save preset"),
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  // Delete preset mutation
  const deletePresetMutation = useMutation({
    mutationFn: async (presetId: string) => {
      const { error } = await supabase
        .from("image_reference_presets")
        .delete()
        .eq("id", presetId);
      
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reference-presets"] });
      toast({ title: t("referencePresets.toastDeleted", "Preset deleted") });
      setDeletePresetId(null);
    },
    onError: (error) => {
      toast({
        title: t("referencePresets.toastDeleteFailed", "Failed to delete preset"),
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  const handleSave = () => {
    if (!presetName.trim()) {
      toast({ title: t("referencePresets.toastEnterName", "Enter a name"), variant: "destructive" });
      return;
    }
    savePresetMutation.mutate(presetName.trim());
  };

  const handleLoadPreset = (preset: ReferencePreset) => {
    // Generate new IDs for loaded images to avoid conflicts
    const imagesWithNewIds = preset.reference_images.map(img => ({
      ...img,
      id: `ref-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    }));
    onLoadPreset(imagesWithNewIds);
    toast({ title: t("referencePresets.toastLoaded", "Loaded \"{{name}}\"", { name: preset.name }), description: t("referencePresets.toastLoadedDesc", "{{count}} reference image(s)", { count: preset.reference_images.length }) });
  };

  const canSave = currentImages.length > 0;

  return (
    <div className="flex items-center gap-1">
      {/* Load Preset Dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 h-8"
            disabled={isLoading}
          >
            <FolderOpen className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">{t("referencePresets.trigger", "Presets")}</span>
            <ChevronDown className="w-3 h-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56 bg-background border border-border">
          {presets.length === 0 ? (
            <div className="px-3 py-4 text-center text-sm text-muted-foreground">
              <ImageIcon className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p>{t("referencePresets.emptyTitle", "No saved presets yet")}</p>
              <p className="text-xs mt-1">{t("referencePresets.emptyDesc", "Add reference images and save them for reuse")}</p>
            </div>
          ) : (
            presets.map((preset) => (
              <div key={preset.id} className="flex items-center group">
                <DropdownMenuItem
                  className="flex-1 cursor-pointer"
                  onClick={() => handleLoadPreset(preset)}
                >
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{preset.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("referencePresets.imagesCount", "{{count}} images", { count: preset.reference_images.length })}
                    </p>
                  </div>
                  {/* Preview thumbnails */}
                  <div className="flex -space-x-1 ml-2">
                    {preset.reference_images.slice(0, 3).map((img, i) => (
                      <div
                        key={i}
                        className="w-5 h-5 rounded border border-background overflow-hidden"
                      >
                        <img
                          src={img.url}
                          alt=""
                          className="w-full h-full object-cover"
                        />
                      </div>
                    ))}
                    {preset.reference_images.length > 3 && (
                      <div className="w-5 h-5 rounded border border-background bg-muted flex items-center justify-center text-[8px] font-medium">
                        +{preset.reference_images.length - 3}
                      </div>
                    )}
                  </div>
                </DropdownMenuItem>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 opacity-0 group-hover:opacity-100 transition-opacity mr-1"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDeletePresetId(preset.id);
                  }}
                >
                  <Trash2 className="w-3.5 h-3.5 text-destructive" />
                </Button>
              </div>
            ))
          )}
          {presets.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuItem
            disabled={!canSave}
            onClick={() => setIsSaveDialogOpen(true)}
            className="cursor-pointer"
          >
            <Save className="w-4 h-4 mr-2" />
            {t("referencePresets.saveCurrent", "Save Current as Preset")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Save Dialog */}
      <Dialog open={isSaveDialogOpen} onOpenChange={setIsSaveDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("referencePresets.dialogTitle", "Save Reference Preset")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Input
                placeholder={t("referencePresets.namePlaceholder", "Enter preset name...")}
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSave()}
              />
            </div>
            <div className="flex gap-2 flex-wrap">
              <p className="text-sm text-muted-foreground w-full">
                {t("referencePresets.savingCount", "Saving {{count}} reference image(s):", { count: currentImages.length })}
              </p>
              {currentImages.map((img, i) => (
                <div
                  key={i}
                  className="w-12 h-12 rounded border border-border overflow-hidden"
                >
                  <img src={img.url} alt="" className="w-full h-full object-cover" />
                </div>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsSaveDialogOpen(false)}>
              {t("common:cancel", "Cancel")}
            </Button>
            <Button onClick={handleSave} disabled={savePresetMutation.isPending}>
              {savePresetMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {t("referencePresets.saveBtn", "Save Preset")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deletePresetId} onOpenChange={(open) => !open && setDeletePresetId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("referencePresets.deleteTitle", "Delete Preset?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("referencePresets.deleteDesc", "This will permanently delete this reference preset. This action cannot be undone.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel", "Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletePresetId && deletePresetMutation.mutate(deletePresetId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletePresetMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {t("common:delete", "Delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
