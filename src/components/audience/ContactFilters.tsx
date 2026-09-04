import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import type { ContactFilters as Filters, ContactPlatform, ContactSource } from "@/features/audience";

const PLATFORMS: Array<{ value: ContactPlatform | "all"; label: string }> = [
  { value: "all", label: "All platforms" }, { value: "facebook", label: "Facebook" },
  { value: "instagram", label: "Instagram" }, { value: "threads", label: "Threads" },
];
const SOURCES: Array<{ value: ContactSource | "all"; label: string }> = [
  { value: "all", label: "All sources" }, { value: "organic_comment", label: "Organic" }, { value: "workflow_lead", label: "Workflow leads" },
];

export function ContactFilters({ value, tags, onChange }: { value: Filters; tags: string[]; onChange: (next: Filters) => void }) {
  const toggleTag = (tag: string) =>
    onChange({ ...value, tags: value.tags.includes(tag) ? value.tags.filter((t) => t !== tag) : [...value.tags, tag] });
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-center">
      <Input
        placeholder="Search name, handle, phone or email"
        value={value.search}
        onChange={(e) => onChange({ ...value, search: e.target.value })}
        className="md:max-w-sm"
      />
      <Select value={value.platform} onValueChange={(v) => onChange({ ...value, platform: v as Filters["platform"] })}>
        <SelectTrigger className="md:w-44"><SelectValue /></SelectTrigger>
        <SelectContent>{PLATFORMS.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}</SelectContent>
      </Select>
      <Select value={value.source} onValueChange={(v) => onChange({ ...value, source: v as Filters["source"] })}>
        <SelectTrigger className="md:w-44"><SelectValue /></SelectTrigger>
        <SelectContent>{SOURCES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
      </Select>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <button key={tag} type="button" onClick={() => toggleTag(tag)} aria-pressed={value.tags.includes(tag)}>
              <Badge variant={value.tags.includes(tag) ? "default" : "outline"}>{tag}</Badge>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
