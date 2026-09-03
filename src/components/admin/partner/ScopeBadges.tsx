import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface ScopeBadgesProps {
  scopes: string[];
  activeScope: string | null;
  onToggle: (scope: string) => void;
}

/** Clickable scope badges; clicking one filters the table by that scope. */
export function ScopeBadges({ scopes, activeScope, onToggle }: ScopeBadgesProps) {
  return (
    <div className="flex flex-wrap gap-1">
      {scopes.map((scope) => (
        <button
          key={scope}
          type="button"
          aria-pressed={activeScope === scope}
          onClick={() => onToggle(scope)}
          className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Badge variant={activeScope === scope ? "default" : "secondary"} className={cn("cursor-pointer font-mono text-[11px]")}>
            {scope}
          </Badge>
        </button>
      ))}
    </div>
  );
}
