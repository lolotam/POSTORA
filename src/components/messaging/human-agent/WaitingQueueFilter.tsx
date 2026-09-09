import { Button } from "@/components/ui/button";
import { platformLabel, resolveQueueFilter, type Platform, type QueueFilter } from "./queueFilter";

interface WaitingQueueFilterProps {
  platforms: Platform[];
  counts: Record<Platform, number>;
  totalCount: number;
  value: QueueFilter;
  onChange: (next: QueueFilter) => void;
}

export function WaitingQueueFilter({ platforms, counts, totalCount, value, onChange }: WaitingQueueFilterProps) {
  if (platforms.length < 2) return null;

  // Re-resolve so the pressed chip always matches what the queue is showing,
  // even if a caller passes a value whose platform has since disappeared.
  // resolveQueueFilter is idempotent, so the page resolving first is harmless.
  const active = resolveQueueFilter(value, platforms);

  const chips: { value: QueueFilter; label: string; count: number }[] = [
    { value: "all", label: "All", count: totalCount },
    ...platforms.map((platform) => ({
      value: platform as QueueFilter,
      label: platformLabel(platform),
      count: counts[platform] ?? 0,
    })),
  ];

  return (
    <div role="group" aria-label="Filter waiting queue by platform" className="mb-4 flex flex-wrap gap-2">
      {chips.map((chip) => {
        const isActive = active === chip.value;
        return (
          <Button
            key={chip.value}
            type="button"
            size="sm"
            variant={isActive ? "default" : "outline"}
            aria-pressed={isActive}
            onClick={() => onChange(chip.value)}
          >
            {chip.label} {chip.count}
          </Button>
        );
      })}
    </div>
  );
}
