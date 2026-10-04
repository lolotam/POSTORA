import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Save } from "lucide-react";
import { FeatureFlagCategoryDropdown } from "./FeatureFlagCategoryDropdown";
import type { LucideIcon } from "lucide-react";

interface FeatureFlagCardProps {
  flagKey: string;
  label: string;
  description: string;
  icon: LucideIcon;
  isEnabled: boolean;
  hasCharacterLimit?: boolean;
  titleCharacterLimit: number;
  onTitleCharacterLimitChange: (val: number) => void;
  onSaveCharacterLimit: () => void;
  onToggle: (key: string, enabled: boolean) => void;
  isPending: boolean;
  category: string;
  categories: string[];
  onCategoryChange: (flagKey: string, category: string) => void;
}

export function FeatureFlagCard({
  flagKey,
  label,
  description,
  icon: Icon,
  isEnabled,
  hasCharacterLimit,
  titleCharacterLimit,
  onTitleCharacterLimitChange,
  onSaveCharacterLimit,
  onToggle,
  isPending,
  category,
  categories,
  onCategoryChange,
}: FeatureFlagCardProps) {
  return (
    <Card
      interactive
      className={`relative cursor-pointer group hover:shadow-lg hover:-translate-y-1 ${
        isEnabled ? 'ring-2 ring-primary/50 bg-primary/5' : 'hover:ring-1 hover:ring-primary/20'
      }`}
    >
      <CardContent className="p-3 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 transition-all duration-300 group-hover:scale-110 group-hover:bg-primary/20 group-hover:shadow-md">
            <Icon className="w-4 h-4 text-primary transition-transform duration-300 group-hover:scale-110" />
          </div>
          <Switch
            checked={isEnabled}
            onCheckedChange={(checked) => onToggle(flagKey, checked)}
            disabled={isPending}
            className="scale-90"
          />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium leading-tight">{label}</p>
          <p className="text-xs text-muted-foreground line-clamp-2">{description}</p>
        </div>
        <FeatureFlagCategoryDropdown
          currentCategory={category}
          categories={categories}
          onChange={(cat) => onCategoryChange(flagKey, cat)}
        />
        {hasCharacterLimit && isEnabled && (
          <div className="flex items-center gap-2 pt-1 border-t">
            <Input
              type="number"
              min={1}
              max={500}
              value={titleCharacterLimit}
              onChange={(e) => onTitleCharacterLimitChange(parseInt(e.target.value, 10) || 100)}
              className="h-7 text-xs w-16"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={onSaveCharacterLimit}
              disabled={isPending}
            >
              {isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
