import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Palette, Sun, Contrast, Droplets, CircleDot, Focus, Eraser, Sparkles, RefreshCw } from "lucide-react";
import { ArtisticFilter } from "../types";
import { ARTISTIC_FILTERS } from "../constants";

interface FiltersOptionsProps {
  brightness: number;
  contrast: number;
  saturation: number;
  blur: number;
  sharpening: number;
  noiseReduction: number;
  artisticFilter: ArtisticFilter;
  hasModifications: boolean;
  onBrightnessChange: (value: number) => void;
  onContrastChange: (value: number) => void;
  onSaturationChange: (value: number) => void;
  onBlurChange: (value: number) => void;
  onSharpeningChange: (value: number) => void;
  onNoiseReductionChange: (value: number) => void;
  onArtisticFilterChange: (filter: ArtisticFilter) => void;
  onReset: () => void;
}

export function FiltersOptions({
  brightness,
  contrast,
  saturation,
  blur,
  sharpening,
  noiseReduction,
  artisticFilter,
  hasModifications,
  onBrightnessChange,
  onContrastChange,
  onSaturationChange,
  onBlurChange,
  onSharpeningChange,
  onNoiseReductionChange,
  onArtisticFilterChange,
  onReset,
}: FiltersOptionsProps) {
  const { t } = useTranslation("assets");
  const artisticLabels: Record<ArtisticFilter, string> = {
    none: t("imageTools.artistic.none", "None"),
    al_dente: t("imageTools.artistic.al_dente", "Al Dente"),
    athena: t("imageTools.artistic.athena", "Athena"),
    audrey: t("imageTools.artistic.audrey", "Audrey"),
    aurora: t("imageTools.artistic.aurora", "Aurora"),
    daguerre: t("imageTools.artistic.daguerre", "Daguerre"),
    eucalyptus: t("imageTools.artistic.eucalyptus", "Eucalyptus"),
    fes: t("imageTools.artistic.fes", "Fes"),
    frost: t("imageTools.artistic.frost", "Frost"),
    hairspray: t("imageTools.artistic.hairspray", "Hairspray"),
    hokusai: t("imageTools.artistic.hokusai", "Hokusai"),
    incognito: t("imageTools.artistic.incognito", "Incognito"),
    linen: t("imageTools.artistic.linen", "Linen"),
    peacock: t("imageTools.artistic.peacock", "Peacock"),
    primavera: t("imageTools.artistic.primavera", "Primavera"),
    quartz: t("imageTools.artistic.quartz", "Quartz"),
    red_rock: t("imageTools.artistic.red_rock", "Red Rock"),
    refresh: t("imageTools.artistic.refresh", "Refresh"),
    sizzle: t("imageTools.artistic.sizzle", "Sizzle"),
    sonnet: t("imageTools.artistic.sonnet", "Sonnet"),
    ukulele: t("imageTools.artistic.ukulele", "Ukulele"),
    zorro: t("imageTools.artistic.zorro", "Zorro"),
  };
  return (
    <div className="p-4 border rounded-lg space-y-5">
      <Label className="flex items-center gap-2 text-sm font-medium">
        <Palette className="w-4 h-4" />
        {t("imageTools.filtersEffects", "Filters & Effects")}
      </Label>
      
      {/* Brightness */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="flex items-center gap-2 text-xs">
            <Sun className="w-3 h-3" />
            {t("filters.brightness", "Brightness")}
          </Label>
          <span className="text-xs text-muted-foreground">{brightness}</span>
        </div>
        <Slider
          value={[brightness]}
          onValueChange={([v]) => onBrightnessChange(v)}
          min={-100}
          max={100}
          step={5}
        />
      </div>
      
      {/* Contrast */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="flex items-center gap-2 text-xs">
            <Contrast className="w-3 h-3" />
            {t("filters.contrast", "Contrast")}
          </Label>
          <span className="text-xs text-muted-foreground">{contrast}</span>
        </div>
        <Slider
          value={[contrast]}
          onValueChange={([v]) => onContrastChange(v)}
          min={-100}
          max={100}
          step={5}
        />
      </div>
      
      {/* Saturation */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="flex items-center gap-2 text-xs">
            <Droplets className="w-3 h-3" />
            {t("filters.saturation", "Saturation")}
          </Label>
          <span className="text-xs text-muted-foreground">{saturation}</span>
        </div>
        <Slider
          value={[saturation]}
          onValueChange={([v]) => onSaturationChange(v)}
          min={-100}
          max={100}
          step={5}
        />
      </div>
      
      {/* Blur */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="flex items-center gap-2 text-xs">
            <CircleDot className="w-3 h-3" />
            {t("filters.blur", "Blur")}
          </Label>
          <span className="text-xs text-muted-foreground">{blur}</span>
        </div>
        <Slider
          value={[blur]}
          onValueChange={([v]) => onBlurChange(v)}
          min={0}
          max={100}
          step={5}
        />
      </div>
      
      {/* Sharpening */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="flex items-center gap-2 text-xs">
            <Focus className="w-3 h-3" />
            {t("filters.sharpening", "Sharpening")}
          </Label>
          <span className="text-xs text-muted-foreground">{sharpening}</span>
        </div>
        <Slider
          value={[sharpening]}
          onValueChange={([v]) => onSharpeningChange(v)}
          min={0}
          max={100}
          step={5}
        />
      </div>
      
      {/* Noise Reduction */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="flex items-center gap-2 text-xs">
            <Eraser className="w-3 h-3" />
            {t("filters.noiseReduction", "Noise Reduction")}
          </Label>
          <span className="text-xs text-muted-foreground">{noiseReduction}</span>
        </div>
        <Slider
          value={[noiseReduction]}
          onValueChange={([v]) => onNoiseReductionChange(v)}
          min={0}
          max={100}
          step={5}
        />
      </div>
      
      {/* Artistic Filter */}
      <div className="space-y-2">
        <Label className="flex items-center gap-2 text-xs">
          <Sparkles className="w-3 h-3" />
          {t("imageTools.artistic.label", "Artistic Filter")}
        </Label>
        <Select
          value={artisticFilter}
          onValueChange={(v) => onArtisticFilterChange(v as ArtisticFilter)}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-60">
            {Object.entries(ARTISTIC_FILTERS).map(([key]) => (
              <SelectItem key={key} value={key}>
                {artisticLabels[key as ArtisticFilter]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      
      {/* Reset Filters Button */}
      {hasModifications && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onReset}
          className="w-full"
        >
          <RefreshCw className="w-3 h-3 mr-2" />
          {t("imageTools.resetFilters", "Reset Filters")}
        </Button>
      )}
    </div>
  );
}
