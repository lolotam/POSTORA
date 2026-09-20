/**
 * Preset selector for quick one-click crop/compress settings per platform
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { 
  Bookmark, 
  Plus, 
  Trash2, 
  Star, 
  Crop, 
  FileDown,
  ChevronDown 
} from "lucide-react";
import { useVideoProcessingPresets, VideoProcessingPreset, PLATFORM_DEFAULTS } from "@/hooks/useVideoProcessingPresets";

interface VideoProcessingPresetSelectorProps {
  platform?: string;
  onApplyPreset: (preset: {
    cropAspectRatio?: string;
    compressQuality?: number;
    compressMaxSizeMB?: number;
  }) => void;
  currentSettings?: {
    cropAspectRatio?: string;
    compressQuality?: number;
    compressMaxSizeMB?: number;
  };
}

const PLATFORMS = [
  { value: "tiktok", label: "TikTok" },
  { value: "instagram", label: "Instagram" },
  { value: "youtube", label: "YouTube" },
  { value: "general", label: "General" },
] as const;

const ASPECT_RATIOS = [
  { value: "1:1", label: "Square (1:1)" },
  { value: "4:5", label: "Portrait (4:5)" },
  { value: "9:16", label: "Vertical (9:16)" },
  { value: "16:9", label: "Landscape (16:9)" },
  { value: "2:3", label: "Pinterest (2:3)" },
];

export function VideoProcessingPresetSelector({
  platform = "general",
  onApplyPreset,
  currentSettings,
}: VideoProcessingPresetSelectorProps) {
  const { t } = useTranslation("postmedia");
  const {
    presets,
    isLoading,
    createPreset,
    deletePreset,
    getPresetsForPlatform,
  } = useVideoProcessingPresets();

  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newPreset, setNewPreset] = useState({
    name: "",
    platform: platform as "tiktok" | "instagram" | "youtube" | "general",
    preset_type: "both" as "crop" | "compress" | "both",
    crop_aspect_ratio: PLATFORM_DEFAULTS[platform]?.crop_aspect_ratio || "9:16",
    compress_quality: PLATFORM_DEFAULTS[platform]?.compress_quality || 80,
    compress_max_size_mb: PLATFORM_DEFAULTS[platform]?.compress_max_size_mb,
    is_default: false,
  });

  const availablePresets = getPresetsForPlatform(platform);

  const handleApply = (preset: VideoProcessingPreset) => {
    onApplyPreset({
      cropAspectRatio: preset.crop_aspect_ratio || undefined,
      compressQuality: preset.compress_quality || undefined,
      compressMaxSizeMB: preset.compress_max_size_mb || undefined,
    });
  };

  const handleSaveCurrentAsPreset = () => {
    setNewPreset(prev => ({
      ...prev,
      crop_aspect_ratio: currentSettings?.cropAspectRatio || prev.crop_aspect_ratio,
      compress_quality: currentSettings?.compressQuality || prev.compress_quality,
      compress_max_size_mb: currentSettings?.compressMaxSizeMB || prev.compress_max_size_mb,
    }));
    setShowCreateDialog(true);
  };

  const handleCreatePreset = async () => {
    await createPreset({
      name: newPreset.name,
      platform: newPreset.platform,
      preset_type: newPreset.preset_type,
      crop_aspect_ratio: newPreset.crop_aspect_ratio,
      compress_quality: newPreset.compress_quality,
      compress_max_size_mb: newPreset.compress_max_size_mb,
      is_default: newPreset.is_default,
    });
    setShowCreateDialog(false);
    setNewPreset({
      name: "",
      platform: platform as "tiktok" | "instagram" | "youtube" | "general",
      preset_type: "both",
      crop_aspect_ratio: "9:16",
      compress_quality: 80,
      compress_max_size_mb: undefined,
      is_default: false,
    });
  };

  const getPresetIcon = (preset: VideoProcessingPreset) => {
    if (preset.preset_type === "crop") return <Crop className="w-3.5 h-3.5" />;
    if (preset.preset_type === "compress") return <FileDown className="w-3.5 h-3.5" />;
    return <Bookmark className="w-3.5 h-3.5" />;
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5" disabled={isLoading}>
            <Bookmark className="w-4 h-4" />
            {t("presets.button", "Presets")}
            <ChevronDown className="w-3 h-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            {t("presets.dropdownLabel", "Quick apply saved settings")}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />

          {availablePresets.length === 0 ? (
            <div className="px-2 py-3 text-center text-sm text-muted-foreground">
              {t("presets.noPresets", "No presets saved yet")}
            </div>
          ) : (
            availablePresets.map((preset) => (
              <DropdownMenuItem
                key={preset.id}
                className="flex items-center justify-between cursor-pointer"
                onSelect={(e) => {
                  e.preventDefault();
                  handleApply(preset);
                }}
              >
                <div className="flex items-center gap-2">
                  {getPresetIcon(preset)}
                  <span className="truncate max-w-[120px]">{preset.name}</span>
                  {preset.is_default && (
                    <Star className="w-3 h-3 text-yellow-500 fill-yellow-500" />
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <Badge variant="outline" className="text-[10px] h-4 px-1">
                    {preset.platform}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 hover:bg-destructive/10"
                    onClick={(e) => {
                      e.stopPropagation();
                      deletePreset(preset.id);
                    }}
                  >
                    <Trash2 className="w-3 h-3 text-destructive" />
                  </Button>
                </div>
              </DropdownMenuItem>
            ))
          )}

          <DropdownMenuSeparator />
          
          <DropdownMenuItem onSelect={handleSaveCurrentAsPreset} className="gap-2">
            <Plus className="w-4 h-4" />
            {t("presets.saveCurrent", "Save current as preset")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Create Preset Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Bookmark className="w-5 h-5" />
              {t("presets.dialogTitle", "Save Processing Preset")}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>{t("presets.nameLabel", "Preset Name")}</Label>
              <Input
                placeholder={t("presets.namePlaceholder", "e.g., TikTok Vertical")}
                value={newPreset.name}
                onChange={(e) => setNewPreset(prev => ({ ...prev, name: e.target.value }))}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t("presets.platformLabel", "Platform")}</Label>
                <Select
                  value={newPreset.platform}
                  onValueChange={(v) => setNewPreset(prev => ({ 
                    ...prev, 
                    platform: v as typeof prev.platform 
                  }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PLATFORMS.map((p) => (
                      <SelectItem key={p.value} value={p.value}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>{t("presets.typeLabel", "Type")}</Label>
                <Select
                  value={newPreset.preset_type}
                  onValueChange={(v) => setNewPreset(prev => ({ 
                    ...prev, 
                    preset_type: v as typeof prev.preset_type 
                  }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="crop">{t("presets.cropOnly", "Crop only")}</SelectItem>
                    <SelectItem value="compress">{t("presets.compressOnly", "Compress only")}</SelectItem>
                    <SelectItem value="both">{t("presets.both", "Both")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {(newPreset.preset_type === "crop" || newPreset.preset_type === "both") && (
              <div className="space-y-2">
                <Label>{t("presets.aspectRatioLabel", "Aspect Ratio")}</Label>
                <Select
                  value={newPreset.crop_aspect_ratio}
                  onValueChange={(v) => setNewPreset(prev => ({ ...prev, crop_aspect_ratio: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ASPECT_RATIOS.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {(newPreset.preset_type === "compress" || newPreset.preset_type === "both") && (
              <>
                <div className="space-y-2">
                  <Label>{t("presets.qualityLabel", "Quality: {{quality}}%", { quality: newPreset.compress_quality })}</Label>
                  <Slider
                    value={[newPreset.compress_quality]}
                    onValueChange={([v]) => setNewPreset(prev => ({ ...prev, compress_quality: v }))}
                    min={10}
                    max={100}
                    step={5}
                  />
                </div>

                <div className="space-y-2">
                  <Label>{t("presets.maxSizeLabel", "Max Size (MB, optional)")}</Label>
                  <Input
                    type="number"
                    placeholder={t("presets.maxSizePlaceholder", "e.g., 50")}
                    value={newPreset.compress_max_size_mb || ""}
                    onChange={(e) => setNewPreset(prev => ({ 
                      ...prev, 
                      compress_max_size_mb: e.target.value ? parseInt(e.target.value) : undefined 
                    }))}
                  />
                </div>
              </>
            )}

            <div className="flex items-center justify-between">
              <Label htmlFor="is-default">{t("presets.setDefault", "Set as default for {{platform}}", { platform: newPreset.platform })}</Label>
              <Switch
                id="is-default"
                checked={newPreset.is_default}
                onCheckedChange={(checked) => setNewPreset(prev => ({ ...prev, is_default: checked }))}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              {t("common:cancel", "Cancel")}
            </Button>
            <Button onClick={handleCreatePreset} disabled={!newPreset.name.trim()}>
              {t("presets.saveBtn", "Save Preset")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
