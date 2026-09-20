import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sparkles } from "lucide-react";
import { QualityPreset, OutputFormat } from "../types";
import { QUALITY_PRESETS } from "../constants";

interface QualityOptionsProps {
  qualityPreset: QualityPreset;
  outputFormat: OutputFormat;
  onQualityPresetChange: (preset: QualityPreset) => void;
  onOutputFormatChange: (format: OutputFormat) => void;
}

export function QualityOptions({
  qualityPreset,
  outputFormat,
  onQualityPresetChange,
  onOutputFormatChange,
}: QualityOptionsProps) {
  const { t } = useTranslation("assets");
  const qualityLabels: Record<QualityPreset, string> = {
    auto: t("imageTools.qualityPreset.auto", "Auto (recommended)"),
    best: t("imageTools.qualityPreset.best", "Best Quality"),
    high: t("imageTools.qualityPreset.high", "High (80%)"),
    medium: t("imageTools.qualityPreset.medium", "Medium (60%)"),
    low: t("imageTools.qualityPreset.low", "Low (40%)"),
    eco: t("imageTools.qualityPreset.eco", "Eco (20%)"),
  };
  return (
    <div className="p-4 border rounded-lg space-y-4">
      <Label className="flex items-center gap-2 text-sm font-medium">
        <Sparkles className="w-4 h-4" />
        {t("imageTools.qualityTitle", "Quality & Compression")}
      </Label>
      
      {/* Quality Preset */}
      <div className="space-y-2">
        <Label className="text-xs">{t("imageTools.qualityLevel", "Quality Level")}</Label>
        <Select
          value={qualityPreset}
          onValueChange={(v) => onQualityPresetChange(v as QualityPreset)}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(QUALITY_PRESETS).map(([key]) => (
              <SelectItem key={key} value={key}>
                {qualityLabels[key as QualityPreset]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      
      {/* Output Format */}
      <div className="space-y-2">
        <Label className="text-xs">{t("imageTools.output.label", "Output Format")}</Label>
        <Select
          value={outputFormat}
          onValueChange={(v) => onOutputFormatChange(v as OutputFormat)}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">{t("imageTools.output.auto", "Auto (recommended)")}</SelectItem>
            <SelectItem value="jpg">{t("imageTools.output.jpg", "JPG - Smaller size")}</SelectItem>
            <SelectItem value="png">{t("imageTools.output.png", "PNG - Best for transparency")}</SelectItem>
            <SelectItem value="webp">{t("imageTools.output.webp", "WebP - Modern, efficient")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      
      {/* Quality indicator */}
      <div className="p-3 bg-muted/50 rounded-lg">
        <p className="text-xs text-muted-foreground">
          {qualityPreset === "auto" && t("imageTools.qualityHint.auto", "Cloudinary will automatically optimize quality and format for best balance.")}
          {qualityPreset === "best" && t("imageTools.qualityHint.best", "Maximum quality, larger file size. Best for print or archiving.")}
          {qualityPreset === "high" && t("imageTools.qualityHint.high", "High quality with good compression. Suitable for most uses.")}
          {qualityPreset === "medium" && t("imageTools.qualityHint.medium", "Balanced quality and file size. Good for web use.")}
          {qualityPreset === "low" && t("imageTools.qualityHint.low", "Smaller file size with noticeable quality reduction.")}
          {qualityPreset === "eco" && t("imageTools.qualityHint.eco", "Minimum file size. Only use when size is critical.")}
        </p>
      </div>
    </div>
  );
}
