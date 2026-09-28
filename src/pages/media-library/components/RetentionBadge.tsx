import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { daysUntilDeletion, retentionBadgeTone } from "@/lib/mediaRetention";
import { cn } from "@/lib/utils";

export function RetentionBadge({
  expiresAt,
  deletionPaused,
  onKeep,
}: {
  expiresAt: string | null | undefined;
  deletionPaused: boolean;
  onKeep?: () => void;
}) {
  const { t } = useTranslation("assets");
  if (!expiresAt) return null;
  const days = daysUntilDeletion(expiresAt, new Date());
  const tone = retentionBadgeTone(days);
  const label = deletionPaused
    ? t("retention.paused", "Would be deleted — deletion paused by admin")
    : t("retention.deletesIn", "Deletes in {{count}} days", { count: days });

  return (
    <span className="inline-flex items-center gap-1 max-w-full">
      <Badge
        variant="secondary"
        title={label}
        className={cn(
          "text-[10px] px-1 py-0",
          deletionPaused
            ? "bg-amber-500/15 text-amber-800 dark:text-amber-200"
            : tone === "red"
              ? "bg-red-600 text-white"
              : "bg-amber-500 text-black",
        )}
      >
        {label}
      </Badge>
      {onKeep && (
        <button
          type="button"
          className="text-[10px] underline"
          onClick={(event) => {
            event.stopPropagation();
            onKeep();
          }}
        >
          {t("retention.keep", "Keep")}
        </button>
      )}
    </span>
  );
}

export function RetentionKeepItem({
  keepForever,
  onToggle,
}: {
  keepForever: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation("assets");
  return (
    <DropdownMenuItem
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      {keepForever
        ? t("retention.allowExpiry", "Allow expiry")
        : t("retention.keepForever", "Keep forever")}
    </DropdownMenuItem>
  );
}
