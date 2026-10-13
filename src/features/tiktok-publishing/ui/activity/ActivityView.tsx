import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronRight, ExternalLink, X } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePipelineDrafts } from "../../application/usePipelineDrafts";
import { useSubmissionStatuses } from "../../application/useSubmissionStatuses";
import {
  ACTIVITY_FILTER_LABELS,
  activityGroup,
  countByFilter,
  toPipelineItem,
  type ActivityFilter,
  type ActivityGroup,
  type PipelineItem,
} from "../../domain/pipelineItems";
import { REVIEW_PATHS } from "../../domain/shellRoutes";
import { formatInZone } from "../../domain/scheduleRules";
import { browserTimeZone } from "@/features/scheduled";
import { captionTitle, useDescribeError } from "../reviewCopy";
import { PipelineHeader } from "../shell/PipelineHeader";
import { TikTokGlyph } from "../shell/TikTokGlyph";
import "../approvals/approvals.css";
import "./activity.css";

const ALL_STATES = ["pending_review", "submitted", "rejected", "archived"] as const;
const GROUPS: ActivityGroup[] = ["Today", "This week", "Earlier"];

function parseFilter(value: string | null): ActivityFilter {
  return value && value in ACTIVITY_FILTER_LABELS ? (value as ActivityFilter) : "all";
}

function shortDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone }).format(new Date(iso));
}

export function ActivityView() {
  const [params, setParams] = useSearchParams();
  const filter = parseFilter(params.get("status"));
  const expanded = params.get("item");
  const timeZone = useMemo(() => browserTimeZone(), []);
  const pipeline = usePipelineDrafts(ALL_STATES);
  const describeError = useDescribeError();
  const statuses = useSubmissionStatuses(pipeline.drafts);
  const items = pipeline.drafts.map((draft) => toPipelineItem(draft, statuses.get(draft.id) ?? null));
  const counts = countByFilter(items);
  const shown = filter === "all" ? items : items.filter((item) => item.filter === filter);
  const now = new Date();

  function update(next: { status?: ActivityFilter; item?: string | null }) {
    const nextParams = new URLSearchParams(params);
    if (next.status !== undefined) {
      if (next.status === "all") nextParams.delete("status");
      else nextParams.set("status", next.status);
    }
    if (next.item !== undefined) {
      if (next.item) nextParams.set("item", next.item);
      else nextParams.delete("item");
    }
    setParams(nextParams, { replace: true });
  }

  return (
    <div>
      <PipelineHeader
        title="Activity"
        subtitle={pipeline.isPending ? " " : `${shown.length} of ${items.length} shown · click a row to unfold`}
      />

      <div className="ap-filters">
        <div className="ap-filter">
          <span className="rs-label">Status</span>
          <Select value={filter} onValueChange={(value) => update({ status: value as ActivityFilter })}>
            <SelectTrigger className="ap-select-trigger" aria-label="Status">
              <SelectValue>{`${ACTIVITY_FILTER_LABELS[filter]} ${counts[filter]}`}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(ACTIVITY_FILTER_LABELS) as ActivityFilter[]).map((key) => (
                <SelectItem key={key} value={key}>
                  {ACTIVITY_FILTER_LABELS[key]} <span className="text-[color:var(--rs-ink-mute)]">{counts[key]}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {filter !== "all" ? (
          <button type="button" className="rs-btn rs-btn-ghost rs-btn-sm" onClick={() => update({ status: "all" })}>
            <X /> Clear
          </button>
        ) : null}
      </div>

      <section className="rs-card overflow-hidden" aria-label="Activity">
        {pipeline.isPending && items.length === 0 ? (
          <div className="p-4" role="status" aria-label="Loading activity">
            {[0, 1, 2, 3].map((key) => <div key={key} className="rs-skeleton mb-3 h-10 w-full" />)}
          </div>
        ) : pipeline.isError ? (
          <div className="p-4" role="alert">
            <p className="ap-alert">{describeError(pipeline.error)}</p>
            <button type="button" className="rs-btn rs-btn-cream rs-btn-sm mt-2" onClick={pipeline.refetch}>Retry</button>
          </div>
        ) : shown.length === 0 ? (
          <p className="ap-empty">Nothing in this filter</p>
        ) : (
          GROUPS.map((group) => {
            const rows = shown.filter((item) => activityGroup(item.draft.updatedAt, now) === group);
            if (rows.length === 0) return null;
            return (
              <div key={group}>
                <div className="ac-group">
                  <span>{group}</span>
                  <span>{rows.length}</span>
                </div>
                {rows.map((item) => (
                  <ActivityRow
                    key={item.draft.id}
                    item={item}
                    open={expanded === item.draft.id}
                    timeZone={timeZone}
                    onToggle={() => update({ item: expanded === item.draft.id ? null : item.draft.id })}
                  />
                ))}
              </div>
            );
          })
        )}
      </section>
    </div>
  );
}

function ActivityRow({ item, open, timeZone, onToggle }: { item: PipelineItem; open: boolean; timeZone: string; onToggle: () => void }) {
  const title = captionTitle(item.draft.caption, "Untitled post");
  return (
    <div className="ac-row-wrap">
      <button type="button" className="ac-row" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${title}`} onClick={onToggle}>
        <span className="rs-tile"><TikTokGlyph /></span>
        <span className="min-w-0 flex-1 text-left">
          <span className="block truncate text-[14px]">{title}</span>
          <span className="ap-meta block">
            TikTok · Post · {shortDate(item.draft.updatedAt, timeZone)}
            {item.scheduledAt ? <span className="text-[color:var(--rs-tomato)]"> · Sched {formatInZone(item.scheduledAt, timeZone)}</span> : null}
          </span>
        </span>
        <span className="rs-pill" data-tone={item.status.tone}>{item.status.pill}</span>
        {open ? <ChevronDown className="h-4 w-4 text-[color:var(--rs-ink-mute)]" /> : <ChevronRight className="h-4 w-4 text-[color:var(--rs-ink-mute)]" />}
      </button>
      {open ? (
        <div className="ac-expand">
          <div className="ap-section-title mb-2">Post preview</div>
          <p className="ap-caption !text-[14px]">{item.draft.caption || "No caption yet."}</p>
          {item.failureReason ? <p className="ap-alert">{item.failureReason}</p> : null}
          {item.draft.rejectionReason ? <p className="ap-alert">Rejected: {item.draft.rejectionReason}</p> : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <Link to={`${REVIEW_PATHS.approvals}?tab=all&item=${item.draft.id}`} className="rs-btn rs-btn-ink rs-btn-sm">Open in Approvals</Link>
            {item.postUrl ? (
              <a href={item.postUrl} target="_blank" rel="noreferrer" className="rs-btn rs-btn-outline rs-btn-sm">
                <ExternalLink /> View on TikTok
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
