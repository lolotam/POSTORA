import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Scissors, Maximize2, ZoomIn, Palette, Sparkles } from "lucide-react";

interface FeatureTogglesProps {
  enableBgRemoval: boolean;
  enableResize: boolean;
  enableUpscale: boolean;
  enableFilters: boolean;
  enableQuality: boolean;
  /** Resize, filters and quality are Cloudinary delivery transforms; off when Cloudinary is not serving them. */
  transformsDisabled?: boolean;
  onToggleBgRemoval: (enabled: boolean) => void;
  onToggleResize: (enabled: boolean) => void;
  onToggleUpscale: (enabled: boolean) => void;
  onToggleFilters: (enabled: boolean) => void;
  onToggleQuality: (enabled: boolean) => void;
}

export function FeatureToggles({
  enableBgRemoval,
  enableResize,
  enableUpscale,
  enableFilters,
  enableQuality,
  transformsDisabled = false,
  onToggleBgRemoval,
  onToggleResize,
  onToggleUpscale,
  onToggleFilters,
  onToggleQuality,
}: FeatureTogglesProps) {
  const { t } = useTranslation("assets");
  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 p-3 bg-muted/50 rounded-lg">
      <div className="flex items-center justify-between p-2 border rounded-md bg-background">
        <div className="flex items-center gap-1.5">
          <Scissors className="w-3.5 h-3.5 text-primary" />
          <Label className="text-[11px] font-medium">{t("imageTools.bgRemove", "BG Remove")}</Label>
        </div>
        <Switch
          checked={enableBgRemoval}
          onCheckedChange={onToggleBgRemoval}
          className="scale-75"
        />
      </div>

      <div className="flex items-center justify-between p-2 border rounded-md bg-background">
        <div className="flex items-center gap-1.5">
          <Maximize2 className="w-3.5 h-3.5 text-primary" />
          <Label className="text-[11px] font-medium">{t("imageTools.resize.label", "Resize")}</Label>
        </div>
        <Switch
          checked={enableResize}
          onCheckedChange={onToggleResize}
          disabled={transformsDisabled}
          className="scale-75"
        />
      </div>
      
      <div className="flex items-center justify-between p-2 border rounded-md bg-background">
        <div className="flex items-center gap-1.5">
          <ZoomIn className="w-3.5 h-3.5 text-primary" />
          <Label className="text-[11px] font-medium">{t("imageTools.upscale", "Upscale")}</Label>
        </div>
        <Switch
          checked={enableUpscale}
          onCheckedChange={onToggleUpscale}
          className="scale-75"
        />
      </div>
      
      <div className="flex items-center justify-between p-2 border rounded-md bg-background">
        <div className="flex items-center gap-1.5">
          <Palette className="w-3.5 h-3.5 text-primary" />
          <Label className="text-[11px] font-medium">{t("imageTools.filters", "Filters")}</Label>
        </div>
        <Switch
          checked={enableFilters}
          onCheckedChange={onToggleFilters}
          disabled={transformsDisabled}
          className="scale-75"
        />
      </div>
      
      <div className="flex items-center justify-between p-2 border rounded-md bg-background">
        <div className="flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-primary" />
          <Label className="text-[11px] font-medium">{t("imageTools.quality", "Quality")}</Label>
        </div>
        <Switch
          checked={enableQuality}
          onCheckedChange={onToggleQuality}
          disabled={transformsDisabled}
          className="scale-75"
        />
      </div>
    </div>
  );
}
