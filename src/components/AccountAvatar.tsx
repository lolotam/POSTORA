import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Platform } from "@/lib/types";
import { cn } from "@/lib/utils";

interface AccountAvatarProps {
  platform: Platform;
  avatarUrl?: string | null;
  name?: string | null;
  size?: "sm" | "md" | "lg";
  className?: string;
  title?: string;
}

const sizeMap = {
  sm: { avatar: "w-7 h-7", badge: "w-3.5 h-3.5 p-[2px]", icon: "xs" as const, fallback: "text-[10px]" },
  md: { avatar: "w-10 h-10", badge: "w-4 h-4 p-[2px]", icon: "xs" as const, fallback: "text-xs" },
  lg: { avatar: "w-12 h-12", badge: "w-5 h-5 p-[3px]", icon: "sm" as const, fallback: "text-sm" },
};

/**
 * Account avatar with platform icon overlay (bottom-right badge),
 * matching the layout used in the Create New Post platform section.
 */
export function AccountAvatar({
  platform,
  avatarUrl,
  name,
  size = "md",
  className,
  title,
}: AccountAvatarProps) {
  const s = sizeMap[size];
  return (
    <div className={cn("relative inline-block shrink-0", className)} title={title ?? name ?? platform}>
      <Avatar className={cn(s.avatar, "border-2 border-background shadow-sm")}>
        <AvatarImage src={avatarUrl || undefined} alt={name || platform} />
        <AvatarFallback className={cn(s.fallback, "font-semibold")}>
          {(name?.[0] || platform[0] || "?").toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <span
        className={cn(
          "absolute -bottom-0.5 -end-0.5 rounded-full bg-background ring-1 ring-border flex items-center justify-center shadow",
          s.badge,
        )}
      >
        <PlatformIcon platform={platform} size={s.icon} />
      </span>
    </div>
  );
}
