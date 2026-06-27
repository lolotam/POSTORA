import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { User } from "lucide-react";

interface DestinationAvatar {
  id: string;
  name: string;
  avatarUrl?: string | null;
  isPersonal?: boolean;
}

interface LinkedInDestinationStackProps {
  destinations: DestinationAvatar[];
  max?: number;
}

/**
 * Vertical stack of small avatars rendered directly under the LinkedIn chip
 * to make the selected publish destinations visible at a glance.
 *
 * Caps at `max` (default 4) and shows a `+N` overflow chip.
 */
export function LinkedInDestinationStack({
  destinations,
  max = 4,
}: LinkedInDestinationStackProps) {
  if (destinations.length === 0) return null;

  const visible = destinations.slice(0, max);
  const overflow = destinations.length - visible.length;

  return (
    <div className="flex flex-col items-center gap-1 pt-0.5">
      {visible.map((d) => (
        <Avatar
          key={d.id}
          className="h-5 w-5 ring-2 ring-background shadow-sm"
          title={d.name}
        >
          {d.avatarUrl ? <AvatarImage src={d.avatarUrl} alt={d.name} /> : null}
          <AvatarFallback className="text-[9px] font-semibold">
            {d.isPersonal ? (
              <User className="w-3 h-3" />
            ) : (
              d.name.charAt(0).toUpperCase()
            )}
          </AvatarFallback>
        </Avatar>
      ))}
      {overflow > 0 && (
        <span
          className="h-5 min-w-5 px-1 rounded-full bg-muted text-muted-foreground text-[9px] font-semibold flex items-center justify-center ring-2 ring-background"
          title={`${overflow} more destination${overflow > 1 ? "s" : ""}`}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}
