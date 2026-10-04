import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ZoomIn, Cloud, Sparkles } from "lucide-react";
import { UpscaleMode, UpscalePlatform } from "../types";

interface UpscaleOptionsProps {
  upscaleMode: UpscaleMode;
  onUpscaleModeChange: (mode: UpscaleMode) => void;
  upscalePlatform?: UpscalePlatform;
  onUpscalePlatformChange?: (platform: UpscalePlatform) => void;
  showAtlasCloud?: boolean; // Feature flag - when false, hide AtlasCloud option
}

export function UpscaleOptions({ 
  upscaleMode, 
  onUpscaleModeChange,
  upscalePlatform = "cloudinary",
  onUpscalePlatformChange,
  showAtlasCloud = false
}: UpscaleOptionsProps) {
  const { t } = useTranslation("assets");
  // If AtlasCloud is hidden and currently selected, reset to cloudinary
  if (!showAtlasCloud && upscalePlatform === "atlascloud" && onUpscalePlatformChange) {
    onUpscalePlatformChange("cloudinary");
  }

  return (
    <div className="p-4 border rounded-lg space-y-4">
      <Label className="flex items-center gap-2 text-sm font-medium">
        <ZoomIn className="w-4 h-4" />
        {t("imageTools.upscaleSettings", "AI Upscale Settings")}
      </Label>
      
      {/* Platform Selection - only show if AtlasCloud is enabled or if we want to show the selector */}
      {onUpscalePlatformChange && showAtlasCloud && (
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">{t("imageTools.upscalePlatform", "Upscale Platform")}</Label>
          <Select
            value={upscalePlatform}
            onValueChange={(v) => onUpscalePlatformChange(v as UpscalePlatform)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="cloudinary">
                <div className="flex items-center gap-2">
                  <Cloud className="w-4 h-4 text-blue-500" />
                  <div>
                    <span>Cloudinary</span>
                    <p className="text-xs text-muted-foreground">{t("imageTools.cloudinaryDesc", "Up to 4x upscale with AI enhancement")}</p>
                  </div>
                </div>
              </SelectItem>
              <SelectItem value="atlascloud">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-foreground" />
                  <div>
                    <span>AtlasCloud 4K</span>
                    <p className="text-xs text-muted-foreground">{t("imageTools.atlasDesc", "Premium 4K upscaling with AI restoration")}</p>
                  </div>
                </div>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Mode Selection - only for Cloudinary */}
      {upscalePlatform === "cloudinary" && (
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">{t("imageTools.upscaleMode", "Upscale Mode")}</Label>
          <Select
            value={upscaleMode}
            onValueChange={(v) => onUpscaleModeChange(v as UpscaleMode)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="standard">
                <div>
                  <span>{t("imageTools.upscaleStandard", "Standard Upscale")}</span>
                  <p className="text-xs text-muted-foreground">{t("imageTools.upscaleStandardDesc", "AI Super Resolution for higher quality")}</p>
                </div>
              </SelectItem>
              <SelectItem value="enhance">
                <div>
                  <span>{t("imageTools.upscaleEnhance", "Upscale + Enhance")}</span>
                  <p className="text-xs text-muted-foreground">{t("imageTools.upscaleEnhanceDesc", "Also improves colors and lighting")}</p>
                </div>
              </SelectItem>
              <SelectItem value="restore">
                <div>
                  <span>{t("imageTools.upscaleRestore", "Upscale + Restore")}</span>
                  <p className="text-xs text-muted-foreground">{t("imageTools.upscaleRestoreDesc", "Best for old or damaged photos")}</p>
                </div>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      
      <div className="p-3 bg-muted/50 rounded-lg">
        <p className="text-xs text-muted-foreground">
          {upscalePlatform === "atlascloud" && t("imageTools.upscaleHint.atlas", "Uses AtlasCloud's premium AI to upscale images to 4K resolution with advanced detail restoration and enhancement.")}
          {upscalePlatform === "cloudinary" && upscaleMode === "standard" && t("imageTools.upscaleHint.standard", "Uses AI Super Resolution to increase image quality and prevent pixelation when enlarging.")}
          {upscalePlatform === "cloudinary" && upscaleMode === "enhance" && t("imageTools.upscaleHint.enhance", "Upscales the image and automatically enhances colors, contrast, and lighting for a more vibrant result.")}
          {upscalePlatform === "cloudinary" && upscaleMode === "restore" && t("imageTools.upscaleHint.restore", "Upscales and uses AI to restore old, damaged, or low-quality photos by fixing artifacts and improving details.")}
        </p>
      </div>
    </div>
  );
}
