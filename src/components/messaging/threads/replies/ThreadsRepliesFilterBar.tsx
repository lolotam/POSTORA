import { format, endOfDay, startOfDay } from "date-fns";
import { Calendar as CalendarIcon, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { ThreadsReply } from "@/hooks/useThreadsReplies";

export type StatusFilter = "all" | "visible" | "hidden" | "pending";
export type TypeFilter = "all" | "top" | "nested";
export type HasRepliesFilter = "all" | "with" | "without";
export type SortBy = "newest" | "oldest" | "longest" | "shortest";

export interface ReplyFilters {
  search: string;
  from?: Date;
  to?: Date;
  status: StatusFilter;
  type: TypeFilter;
  hasReplies: HasRepliesFilter;
  sortBy: SortBy;
}

export const defaultReplyFilters: ReplyFilters = {
  search: "",
  from: undefined,
  to: undefined,
  status: "all",
  type: "all",
  hasReplies: "all",
  sortBy: "newest",
};

export function applyReplyFilters(
  replies: ThreadsReply[],
  f: ReplyFilters,
): ThreadsReply[] {
  const q = f.search.trim().toLowerCase();
  const from = f.from ? startOfDay(f.from).getTime() : null;
  const to = f.to ? endOfDay(f.to).getTime() : null;

  const filtered = replies.filter((r) => {
    if (q && !(r.text || "").toLowerCase().includes(q)) return false;
    if (from !== null) {
      if (!r.timestamp || new Date(r.timestamp).getTime() < from) return false;
    }
    if (to !== null) {
      if (!r.timestamp || new Date(r.timestamp).getTime() > to) return false;
    }
    if (f.status === "visible" && r.hide_status === "HIDDEN") return false;
    if (f.status === "hidden" && r.hide_status !== "HIDDEN") return false;
    if (f.status === "pending" && r.hide_status !== "PENDING") return false;

    const parentId = r.replied_to?.id ?? null;
    const rootId = r.root_post?.id ?? null;
    const isNested = !!parentId && parentId !== rootId;
    if (f.type === "top" && isNested) return false;
    if (f.type === "nested" && !isNested) return false;

    if (f.hasReplies === "with" && !r.has_replies) return false;
    if (f.hasReplies === "without" && r.has_replies) return false;

    return true;
  });

  const ts = (r: ThreadsReply) =>
    r.timestamp ? new Date(r.timestamp).getTime() : 0;
  const len = (r: ThreadsReply) => (r.text || "").length;

  const sorted = [...filtered];
  switch (f.sortBy) {
    case "oldest":
      sorted.sort((a, b) => ts(a) - ts(b));
      break;
    case "longest":
      sorted.sort((a, b) => len(b) - len(a));
      break;
    case "shortest":
      sorted.sort((a, b) => len(a) - len(b));
      break;
    case "newest":
    default:
      sorted.sort((a, b) => ts(b) - ts(a));
      break;
  }
  return sorted;
}

interface Props {
  filters: ReplyFilters;
  onChange: (next: ReplyFilters) => void;
  total: number;
  shown: number;
}

function DateField({
  value,
  onChange,
  placeholder,
}: {
  value?: Date;
  onChange: (d?: Date) => void;
  placeholder: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "h-8 justify-start text-left font-normal text-xs",
            !value && "text-muted-foreground",
          )}
        >
          <CalendarIcon className="mr-2 h-3.5 w-3.5" />
          {value ? format(value, "MMM d, yyyy") : placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={value}
          onSelect={onChange}
          initialFocus
          className={cn("p-3 pointer-events-auto")}
        />
      </PopoverContent>
    </Popover>
  );
}

export function ThreadsRepliesFilterBar({ filters, onChange, total, shown }: Props) {
  const { t } = useTranslation("threads");
  const update = (patch: Partial<ReplyFilters>) =>
    onChange({ ...filters, ...patch });

  const isDirty =
    !!filters.search ||
    !!filters.from ||
    !!filters.to ||
    filters.status !== "all" ||
    filters.type !== "all" ||
    filters.hasReplies !== "all" ||
    filters.sortBy !== "newest";

  return (
    <div className="rounded-md border bg-card p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={filters.search}
          onChange={(e) => update({ search: e.target.value })}
          placeholder={t("filters.searchReply", "Search reply text…")}
          className="h-8 w-full sm:w-48 text-xs"
        />

        <DateField
          value={filters.from}
          onChange={(d) => update({ from: d })}
          placeholder={t("filters.fromDate", "From date")}
        />
        <DateField
          value={filters.to}
          onChange={(d) => update({ to: d })}
          placeholder={t("filters.toDate", "To date")}
        />

        <Select
          value={filters.status}
          onValueChange={(v) => update({ status: v as StatusFilter })}
        >
          <SelectTrigger className="h-8 w-[130px] text-xs">
            <SelectValue placeholder={t("filters.status", "Status")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("filters.allStatuses", "All statuses")}</SelectItem>
            <SelectItem value="visible">{t("filters.visible", "Visible")}</SelectItem>
            <SelectItem value="hidden">{t("badge.hidden", "Hidden")}</SelectItem>
            <SelectItem value="pending">{t("common:status.pending", "Pending")}</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={filters.type}
          onValueChange={(v) => update({ type: v as TypeFilter })}
        >
          <SelectTrigger className="h-8 w-[130px] text-xs">
            <SelectValue placeholder={t("filters.type", "Type")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("filters.allTypes", "All types")}</SelectItem>
            <SelectItem value="top">{t("filters.topLevel", "Top-level")}</SelectItem>
            <SelectItem value="nested">{t("filters.nested", "Nested")}</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={filters.hasReplies}
          onValueChange={(v) => update({ hasReplies: v as HasRepliesFilter })}
        >
          <SelectTrigger className="h-8 w-[140px] text-xs">
            <SelectValue placeholder={t("filters.hasReplies", "Has replies")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("filters.anyReplies", "Any replies")}</SelectItem>
            <SelectItem value="with">{t("filters.withReplies", "With replies")}</SelectItem>
            <SelectItem value="without">{t("filters.withoutReplies", "Without replies")}</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={filters.sortBy}
          onValueChange={(v) => update({ sortBy: v as SortBy })}
        >
          <SelectTrigger className="h-8 w-[150px] text-xs">
            <SelectValue placeholder={t("filters.sortBy", "Sort by")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">{t("filters.newest", "Newest first")}</SelectItem>
            <SelectItem value="oldest">{t("filters.oldest", "Oldest first")}</SelectItem>
            <SelectItem value="longest">{t("filters.longest", "Longest text")}</SelectItem>
            <SelectItem value="shortest">{t("filters.shortest", "Shortest text")}</SelectItem>
          </SelectContent>
        </Select>

        {isDirty && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-xs"
            onClick={() => onChange(defaultReplyFilters)}
          >
            <X className="h-3.5 w-3.5 mr-1" />
            {t("common:reset", "Reset")}
          </Button>
        )}

        <div className="ml-auto text-xs text-muted-foreground">
          {t("filters.showing", "Showing {{shown}} of {{total}}", { shown, total })}
        </div>
      </div>
    </div>
  );
}