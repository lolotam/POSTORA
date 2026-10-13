import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, ExternalLink, RotateCcw, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { browserTimeZone } from "@/features/scheduled";
import { usePipelineDrafts } from "../../application/usePipelineDrafts";
import { useSubmissionStatuses } from "../../application/useSubmissionStatuses";
import { useTikTokReviewCommands } from "../../application/useTikTokReview";
import {
  dayKey,
  parseCalendarView,
  parseDayKey,
  periodTitle,
  shiftAnchor,
  visibleDays,
  type CalendarView as View,
} from "../../domain/calendarGrid";
import { toPipelineItem, type PipelineItem } from "../../domain/pipelineItems";
import { musicConsentText } from "../../domain/reviewRules";
import { REVIEW_PATHS } from "../../domain/shellRoutes";
import { formatInZone } from "../../domain/scheduleRules";
import { captionTitle, useDescribeError } from "../reviewCopy";
import { PipelineHeader } from "../shell/PipelineHeader";
import { TikTokGlyph } from "../shell/TikTokGlyph";
import "../approvals/approvals.css";
import "./calendar.css";

const SENT = ["submitted"] as const;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const VIEW_LABELS: Record<View, string> = { month: "Month", week: "Week", day: "Day" };

export function CalendarView() {
  const [params, setParams] = useSearchParams();
  const view = parseCalendarView(params.get("view"));
  const timeZone = useMemo(() => browserTimeZone(), []);
  // Previous / Next / Today move the visible period without rewriting ?date= (the initial anchor).
  const [anchor, setAnchor] = useState(() => parseDayKey(params.get("date"), new Date()));
  const pipeline = usePipelineDrafts(SENT);
  const describeError = useDescribeError();
  const statuses = useSubmissionStatuses(pipeline.drafts);
  const items = pipeline.drafts.map((draft) => toPipelineItem(draft, statuses.get(draft.id) ?? null));
  const days = visibleDays(anchor, view);
  const todayKey = dayKey(new Date());

  const byDay = new Map<string, PipelineItem[]>();
  for (const item of items) {
    const key = dayKey(new Date(item.when));
    byDay.set(key, [...(byDay.get(key) ?? []), item].sort((a, b) => a.when.localeCompare(b.when)));
  }

  function setView(next: View) {
    const nextParams = new URLSearchParams(params);
    if (next === "month") nextParams.delete("view");
    else nextParams.set("view", next);
    setParams(nextParams, { replace: true });
  }

  return (
    <div>
      <PipelineHeader
        title={periodTitle(anchor, view)}
        actions={(
          <>
            <button type="button" className="rs-btn rs-btn-outline rs-btn-sm !text-[10.4px] uppercase tracking-wider" onClick={() => setAnchor(new Date())}>
              Today
            </button>
            <button type="button" className="rs-btn rs-btn-outline !h-9 !w-9 !p-0" aria-label="Previous" onClick={() => setAnchor((current) => shiftAnchor(current, view, -1))}>
              <ChevronLeft />
            </button>
            <button type="button" className="rs-btn rs-btn-outline !h-9 !w-9 !p-0" aria-label="Next" onClick={() => setAnchor((current) => shiftAnchor(current, view, 1))}>
              <ChevronRight />
            </button>
          </>
        )}
      />

      <div className="ap-filters">
        <div className="ap-filter">
          <span className="rs-label">View</span>
          <Select value={view} onValueChange={(value) => setView(value as View)}>
            <SelectTrigger className="ap-select-trigger" aria-label="View">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(VIEW_LABELS) as View[]).map((key) => <SelectItem key={key} value={key}>{VIEW_LABELS[key]}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {view !== "month" ? (
          <button type="button" className="rs-btn rs-btn-ghost rs-btn-sm" onClick={() => setView("month")}>
            <X /> Clear
          </button>
        ) : null}
        {pipeline.isPending ? <span className="rs-label">Loading…</span> : null}
      </div>

      {pipeline.isError ? (
        <div className="mb-4" role="alert">
          <p className="ap-alert">{describeError(pipeline.error)}</p>
          <button type="button" className="rs-btn rs-btn-cream rs-btn-sm mt-2" onClick={pipeline.refetch}>Retry</button>
        </div>
      ) : null}

      {view === "day" ? (
        <section className="rs-card ca-day" aria-label="Calendar day">
          {(byDay.get(dayKey(anchor)) ?? []).length === 0 ? (
            <p className="ap-empty">Nothing scheduled this day</p>
          ) : (
            (byDay.get(dayKey(anchor)) ?? []).map((item) => (
              <div key={item.draft.id} className="p-2"><Chip item={item} timeZone={timeZone} withTime /></div>
            ))
          )}
        </section>
      ) : (
        <section className="ca-grid" role="region" aria-label="Calendar grid" data-view={view}>
          {WEEKDAYS.map((name) => <div key={name} className="ca-weekday">{name}</div>)}
          {days.map((day) => {
            const key = dayKey(day);
            const outside = view === "month" && day.getMonth() !== anchor.getMonth();
            return (
              <div key={key} className="ca-cell" data-outside={outside} data-view={view}>
                <span className="ca-daynum" data-today={key === todayKey}>{day.getDate()}</span>
                <div className="flex flex-col gap-1">
                  {(byDay.get(key) ?? []).map((item) => (
                    <Chip key={item.draft.id} item={item} timeZone={timeZone} withTime={view === "week"} />
                  ))}
                </div>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}

function Chip({ item, timeZone, withTime }: { item: PipelineItem; timeZone: string; withTime: boolean }) {
  const title = captionTitle(item.draft.caption, "Untitled post");
  const tone = item.filter === "failed" ? "failed" : item.filter === "published" ? "published" : "scheduled";
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(item.when));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="ca-chip" data-tone={tone} aria-label={`${title}, ${item.status.pill}`}>
          <span className="flex items-center gap-1.5">
            <span className="ca-chip-tile"><TikTokGlyph className="h-2.5 w-2.5" /></span>
            <span className="truncate">{title}</span>
          </span>
          <span className="ca-chip-status">{withTime ? `${time} · ` : ""}{item.status.pill}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[300px] rounded-xl border-[color:var(--rs-rule-strong)] bg-[color:var(--rs-paper-card)] p-4">
        <ChipDetail item={item} timeZone={timeZone} />
      </PopoverContent>
    </Popover>
  );
}

function ChipDetail({ item, timeZone }: { item: PipelineItem; timeZone: string }) {
  const commands = useTikTokReviewCommands();
  const describeError = useDescribeError();
  const [error, setError] = useState<string | null>(null);
  const failed = item.filter === "failed";
  const excerpt = item.draft.caption.length > 160 ? `${item.draft.caption.slice(0, 160)}…` : item.draft.caption;

  return (
    <div>
      <div className="text-[14px] font-semibold">{captionTitle(item.draft.caption, "Untitled post")}</div>
      <div className="ap-meta">TikTok · {item.status.pill}</div>
      <div className="mt-1 text-[12px] text-[color:var(--rs-ink-soft)]">{formatInZone(item.when, timeZone)}</div>
      {excerpt ? <p className="mt-2 whitespace-pre-wrap text-[12px]">{excerpt}</p> : null}
      {failed ? (
        <div className="ca-failed">
          <div className="rs-label !text-[color:var(--rs-tomato)]">Publish failed</div>
          <div className="mt-1 break-words text-[12px]">{item.failureReason || "TikTok did not accept this post."}</div>
        </div>
      ) : null}
      {failed ? (
        <>
          <p className="ap-notice !text-[11px]">{musicConsentText(item.draft.settings)}</p>
          <p className="ap-notice !mt-1 !text-[11px]">After publishing, TikTok may take a few minutes to process your post and show it on your profile.</p>
        </>
      ) : null}
      {error ? <p className="ap-alert" role="alert">{error}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Link to={`${REVIEW_PATHS.approvals}?tab=all&item=${item.draft.id}`} className="rs-btn rs-btn-ink rs-btn-sm">Open</Link>
        {item.postUrl ? (
          <a href={item.postUrl} target="_blank" rel="noreferrer" className="rs-btn rs-btn-outline rs-btn-sm"><ExternalLink /> View on TikTok</a>
        ) : null}
        {failed ? (
          <button
            type="button"
            className="rs-btn rs-btn-outline rs-btn-sm"
            disabled={commands.reopenDraft.isPending}
            onClick={() => {
              setError(null);
              commands.reopenDraft
                .mutateAsync({ draftId: item.draft.id, expectedRevision: item.draft.revision })
                .catch((reason: unknown) => setError(describeError(reason)));
            }}
          >
            <RotateCcw /> Back to pending
          </button>
        ) : null}
      </div>
    </div>
  );
}
