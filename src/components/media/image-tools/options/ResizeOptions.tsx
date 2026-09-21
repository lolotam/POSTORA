import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Maximize2 } from "lucide-react";
import { ResizeMode, CropMode } from "../types";
import { RESIZE_PRESETS, CROP_MODES } from "../constants";

interface ResizeOptionsProps {
  resizeMode: ResizeMode;
  cropMode: CropMode;
  customWidth: number;
  customHeight: number;
  onResizeModeChange: (mode: ResizeMode) => void;
  onCropModeChange: (mode: CropMode) => void;
  onCustomWidthChange: (width: number) => void;
  onCustomHeightChange: (height: number) => void;
}

export function ResizeOptions({
  resizeMode,
  cropMode,
  customWidth,
  customHeight,
  onResizeModeChange,
  onCropModeChange,
  onCustomWidthChange,
  onCustomHeightChange,
}: ResizeOptionsProps) {
  const { t } = useTranslation("assets");
  const resizeLabels: Record<ResizeMode, string> = {
    original: t("imageTools.resize.original", "Original"),
    square: t("imageTools.resize.square", "Square (1:1)"),
    portrait: t("imageTools.resize.portrait", "Portrait (4:5)"),
    landscape: t("imageTools.resize.landscape", "Landscape (16:9)"),
    custom: t("imageTools.resize.custom", "Custom"),
  };
  const cropLabels: Record<CropMode, { label: string; description: string }> = {
    fill: { label: t("imageTools.crop.fill", "Fill (crop to fit)"), description: t("imageTools.crop.fillDesc", "Crops image to exact dimensions") },
    fit: { label: t("imageTools.crop.fit", "Fit (contain)"), description: t("imageTools.crop.fitDesc", "Fits within dimensions, may add padding") },
    scale: { label: t("imageTools.crop.scale", "Scale"), description: t("imageTools.crop.scaleDesc", "Scales to dimensions, may distort") },
    crop: { label: t("imageTools.crop.crop", "Crop (center)"), description: t("imageTools.crop.cropDesc", "Crops from center") },
    pad: { label: t("imageTools.crop.pad", "Pad"), description: t("imageTools.crop.padDesc", "Adds padding to fit dimensions") },
  };
  return (
    <div className="p-4 border rounded-lg space-y-4">
      <div className="space-y-3">
        <Label className="flex items-center gap-2 text-sm font-medium">
          <Maximize2 className="w-4 h-4" />
          {t("imageTools.sizePreset", "Size Preset")}
        </Label>
        <Select
          value={resizeMode}
          onValueChange={(v) => onResizeModeChange(v as ResizeMode)}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(RESIZE_PRESETS).map(([key, preset]) => (
              <SelectItem key={key} value={key}>
                {resizeLabels[key as ResizeMode]}
                {preset.width && preset.height && (
                  <span className="text-muted-foreground ms-2">
                    ({preset.width}×{preset.height})
                  </span>
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {resizeMode === "custom" && (
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>{t("imageTools.widthPx", "Width (px)")}</Label>
            <input
              type="number"
              value={customWidth}
              onChange={(e) => onCustomWidthChange(Number(e.target.value))}
              className="w-full px-3 py-2 border rounded-md bg-background"
              min={100}
              max={4096}
            />
          </div>
          <div className="space-y-2">
            <Label>{t("imageTools.heightPx", "Height (px)")}</Label>
            <input
              type="number"
              value={customHeight}
              onChange={(e) => onCustomHeightChange(Number(e.target.value))}
              className="w-full px-3 py-2 border rounded-md bg-background"
              min={100}
              max={4096}
            />
          </div>
        </div>
      )}

      {resizeMode !== "original" && (
        <div className="space-y-3">
          <Label className="text-sm font-medium">{t("imageTools.crop.label", "Crop Mode")}</Label>
          <Select
            value={cropMode}
            onValueChange={(v) => onCropModeChange(v as CropMode)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(CROP_MODES).map(([key]) => (
                <SelectItem key={key} value={key}>
                  <div>
                    <span>{cropLabels[key as CropMode].label}</span>
                    <p className="text-xs text-muted-foreground">{cropLabels[key as CropMode].description}</p>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}
