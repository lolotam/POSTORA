import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SlidersHorizontal } from "lucide-react";
import { EdgeMode } from "../types";

interface BgRemovalOptionsProps {
  edgeMode: EdgeMode;
  onEdgeModeChange: (mode: EdgeMode) => void;
}

export function BgRemovalOptions({ edgeMode, onEdgeModeChange }: BgRemovalOptionsProps) {
  const { t } = useTranslation("assets");
  return (
    <div className="p-4 border rounded-lg space-y-3">
      <Label className="flex items-center gap-2 text-sm font-medium">
        <SlidersHorizontal className="w-4 h-4" />
        {t("imageTools.edge.label", "Edge Quality")}
      </Label>
      <Select
        value={edgeMode}
        onValueChange={(v) => onEdgeModeChange(v as EdgeMode)}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">{t("imageTools.edge.standard", "Standard")}</SelectItem>
          <SelectItem value="fine">{t("imageTools.edge.fine", "Fine Edges (better for hair, fur)")}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
