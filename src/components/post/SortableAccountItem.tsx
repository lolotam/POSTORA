import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/checkbox";
import { Platform } from "@/lib/types";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, AlertCircle, Users, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export interface SortableAccountItemProps {
  id: string;
  platform: Platform;
  username: string | null;
  avatarUrl: string | null;
  maxChars: number;
  isSelected: boolean;
  isOverLimit: boolean;
  isTokenExpired?: boolean;
  onToggle: () => void;
}

export function SortableAccountItem({
  id,
  platform,
  username,
  avatarUrl,
  maxChars,
  isSelected,
  isOverLimit,
  isTokenExpired = false,
  onToggle,
}: SortableAccountItemProps) {
  const { t } = useTranslation("post");
  const [imageError, setImageError] = useState(false);
  
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const showFallback = !avatarUrl || imageError;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            ref={setNodeRef}
            style={style}
            className={cn(
              "flex items-center gap-3 p-2.5 rounded-lg transition-all",
              isDragging && "opacity-50 shadow-lg z-50",
              isTokenExpired
                ? "bg-destructive/5 border border-destructive/20 opacity-60 cursor-not-allowed"
                : "cursor-pointer",
              !isTokenExpired && isSelected
                ? isOverLimit
                  ? "bg-destructive/10 border border-destructive/30"
                  : "bg-primary/10 border border-primary/30"
                : !isTokenExpired && "bg-secondary/50 border border-transparent hover:bg-secondary"
            )}
          >
            <button
              className="cursor-grab active:cursor-grabbing touch-none text-muted-foreground hover:text-foreground"
              {...attributes}
              {...listeners}
            >
              <GripVertical className="w-4 h-4" />
            </button>

            <Checkbox
              checked={isTokenExpired ? false : isSelected}
              onCheckedChange={isTokenExpired ? undefined : onToggle}
              disabled={isTokenExpired}
            />

            <div className="w-8 h-8 rounded-full bg-muted overflow-hidden flex-shrink-0 flex items-center justify-center">
              {!showFallback ? (
                <img
                  src={avatarUrl}
                  alt={username || t("accountItem.avatarAlt", "Account avatar")}
                  className={cn("w-full h-full object-cover", isTokenExpired && "grayscale")}
                  onError={() => setImageError(true)}
                />
              ) : (
                <Users className="w-4 h-4 text-muted-foreground" />
              )}
            </div>

            <div className="flex-1 min-w-0" onClick={isTokenExpired ? undefined : onToggle}>
              <p className={cn("text-sm font-medium truncate", isTokenExpired && "text-muted-foreground")}>
                {username || t("accountItem.unknownAccount", "Unknown account")}
              </p>
              {isTokenExpired ? (
                <p className="text-xs text-destructive font-medium flex items-center gap-1">
                  <ShieldAlert className="w-3 h-3" />
                  {t("accountItem.tokenExpired", "Token expired — reconnect")}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t("accountItem.charsMax", "{{count}} chars max", { count: maxChars })}
                </p>
              )}
            </div>

            {isTokenExpired && (
              <ShieldAlert className="w-4 h-4 text-destructive flex-shrink-0" />
            )}

            {!isTokenExpired && isSelected && isOverLimit && (
              <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0" />
            )}
          </div>
        </TooltipTrigger>
        {isTokenExpired && (
          <TooltipContent side="top" className="max-w-xs">
            <p>{t("accountItem.tokenExpiredTooltip", "This account's token has expired. Go to Profiles to reconnect it before posting.")}</p>
          </TooltipContent>
        )}
      </Tooltip>
    </TooltipProvider>
  );
}
