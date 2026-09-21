import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronUp, RotateCcw, Search } from "lucide-react";
import type { ThreadsMentionsFiltersState } from "@/hooks/useThreadsMentions";

interface Props {
  filters: ThreadsMentionsFiltersState;
  setFilters: (patch: Partial<ThreadsMentionsFiltersState>) => void;
  reset: () => void;
  availableLabels: string[];
}

export function ThreadsMentionsFilters({ filters, setFilters, reset, availableLabels }: Props) {
  const { t } = useTranslation("threads");
  const [showMore, setShowMore] = useState(filters.labels.length > 0 || filters.assigned !== "all");

  const toggleLabel = (label: string) => {
    const set = new Set(filters.labels);
    if (set.has(label)) set.delete(label);
    else set.add(label);
    setFilters({ labels: Array.from(set) });
  };

  return (
    <Card>
      <CardContent className="p-3 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={filters.status} onValueChange={(v) => setFilters({ status: v as ThreadsMentionsFiltersState["status"] })}>
            <SelectTrigger className="w-[130px] h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("filters.allStatus", "All status")}</SelectItem>
              <SelectItem value="new">{t("status.new", "New")}</SelectItem>
              <SelectItem value="read">{t("status.read", "Read")}</SelectItem>
              <SelectItem value="replied">{t("status.replied", "Replied")}</SelectItem>
              <SelectItem value="archived">{t("status.archived", "Archived")}</SelectItem>
            </SelectContent>
          </Select>

          <Select value={filters.sentiment} onValueChange={(v) => setFilters({ sentiment: v as ThreadsMentionsFiltersState["sentiment"] })}>
            <SelectTrigger className="w-[140px] h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("filters.allSentiment", "All sentiment")}</SelectItem>
              <SelectItem value="positive">{t("sentiment.positive", "Positive")}</SelectItem>
              <SelectItem value="neutral">{t("sentiment.neutral", "Neutral")}</SelectItem>
              <SelectItem value="negative">{t("sentiment.negative", "Negative")}</SelectItem>
              <SelectItem value="unknown">{t("common:unknown", "Unknown")}</SelectItem>
            </SelectContent>
          </Select>

          <Select value={filters.hasReply} onValueChange={(v) => setFilters({ hasReply: v as ThreadsMentionsFiltersState["hasReply"] })}>
            <SelectTrigger className="w-[140px] h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("filters.allReplies", "All replies")}</SelectItem>
              <SelectItem value="replied">{t("status.replied", "Replied")}</SelectItem>
              <SelectItem value="not_replied">{t("filters.notReplied", "Not replied")}</SelectItem>
            </SelectContent>
          </Select>

          <Select value={filters.sort} onValueChange={(v) => setFilters({ sort: v as ThreadsMentionsFiltersState["sort"] })}>
            <SelectTrigger className="w-[130px] h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">{t("filters.newest", "Newest first")}</SelectItem>
              <SelectItem value="oldest">{t("filters.oldest", "Oldest first")}</SelectItem>
            </SelectContent>
          </Select>

          <div className="relative flex-1 min-w-[180px]">
            <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={filters.search}
              onChange={(e) => setFilters({ search: e.target.value })}
              placeholder={t("filters.searchAuthor", "Search author or text…")}
              className="ps-8 h-9"
            />
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9"
            onClick={() => setShowMore((s) => !s)}
          >
            {showMore ? <ChevronUp className="h-4 w-4 me-1.5" /> : <ChevronDown className="h-4 w-4 me-1.5" />}
            {t("actions.more", "More")}
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-9"
            onClick={reset}
          >
            <RotateCcw className="h-3.5 w-3.5 me-1.5" />
            {t("common:reset", "Reset")}
          </Button>
        </div>

        {showMore && (
          <div className="flex flex-wrap items-center gap-3 pt-1 border-t">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{t("assignee.assigned", "Assigned:")}</span>
              <Select value={filters.assigned} onValueChange={(v) => setFilters({ assigned: v as ThreadsMentionsFiltersState["assigned"] })}>
                <SelectTrigger className="w-[140px] h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("common:all", "All")}</SelectItem>
                  <SelectItem value="unassigned">{t("assignee.unassigned", "Unassigned")}</SelectItem>
                  <SelectItem value="me">{t("assignee.me", "Me")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {availableLabels.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 flex-1 min-w-[200px]">
                <span className="text-xs text-muted-foreground me-1">{t("filters.labels", "Labels:")}</span>
                {availableLabels.map((l) => {
                  const active = filters.labels.includes(l);
                  return (
                    <button
                      key={l}
                      type="button"
                      onClick={() => toggleLabel(l)}
                      className="focus:outline-none"
                    >
                      <Badge variant={active ? "default" : "outline"} className="cursor-pointer">
                        #{l}
                      </Badge>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
