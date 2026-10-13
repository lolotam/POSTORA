import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Archive, Check, Plus, X } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePipelineDrafts } from "../../application/usePipelineDrafts";
import { useSubmissionStatuses } from "../../application/useSubmissionStatuses";
import { draftStatus, parseApprovalsTab, statesForTab, type ApprovalsTab } from "../../domain/approvals";
import { REVIEW_PATHS } from "../../domain/shellRoutes";
import { formatInZone } from "../../domain/scheduleRules";
import type { PublishStatus, ReviewDraft, TikTokAccount } from "../../domain/types";
import { captionTitle, describeError } from "../reviewCopy";
import { PipelineHeader } from "../shell/PipelineHeader";
import { TikTokGlyph } from "../shell/TikTokGlyph";
import { useDraftReview } from "../useDraftReview";
import { ApprovalDetail } from "./ApprovalDetail";
import "./approvals.css";

const TAB_LABELS: Record<ApprovalsTab, string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  all: "All",
};

function subtitleFor(tab: ApprovalsTab, count: number): string {
  switch (tab) {
    case "pending":
      return `${count} ${count === 1 ? "item" : "items"} waiting.`;
    case "approved":
      return `${count} approved ${count === 1 ? "item" : "items"}.`;
    case "rejected":
      return `${count} rejected ${count === 1 ? "item" : "items"}.`;
    case "all":
      return `${count} total ${count === 1 ? "item" : "items"}.`;
  }
}

export function ApprovalsView() {
  const [params, setParams] = useSearchParams();
  const tab = parseApprovalsTab(params.get("tab"));
  const states = useMemo(() => statesForTab(tab), [tab]);
  const pipeline = usePipelineDrafts(states);
  const statuses = useSubmissionStatuses(pipeline.drafts);
  const [selectedId, setSelectedId] = useState<string | null>(params.get("item"));
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [paneDetail, setPaneDetail] = useState(params.get("item") !== null);

  const drafts = pipeline.drafts;
  const selected = drafts.find((draft) => draft.id === selectedId) ?? null;
  const accountId = selected?.accountId ?? null;
  const review = useDraftReview({
    selectedId,
    accountId,
    onReopened: () => setTab("pending"),
  });
  const account = pipeline.accounts.find((item) => item.id === accountId) ?? null;

  // Default selection: the first item, as on load; keep a deep-linked ?item= even before the list arrives.
  useEffect(() => {
    if (pipeline.isPending) return;
    if (selectedId && drafts.some((draft) => draft.id === selectedId)) return;
    setSelectedId(drafts[0]?.id ?? null);
  }, [drafts, pipeline.isPending, selectedId]);

  useEffect(() => {
    setChecked(new Set());
  }, [tab]);

  function setTab(next: ApprovalsTab) {
    const nextParams = new URLSearchParams(params);
    if (next === "pending") nextParams.delete("tab");
    else nextParams.set("tab", next);
    nextParams.delete("item");
    setParams(nextParams, { replace: true });
    setSelectedId(null);
  }

  function select(id: string) {
    setSelectedId(id);
    setPaneDetail(true);
  }

  async function createPost(target: TikTokAccount) {
    try {
      const created = await review.commands.createDraft.mutateAsync(target.id);
      if (tab !== "pending") setTab("pending");
      setSelectedId(created.id);
      setPaneDetail(true);
    } catch (error) {
      review.report(error);
    }
  }

  async function archiveChecked() {
    setBulkBusy(true);
    try {
      for (const draft of drafts.filter((item) => checked.has(item.id))) {
        await review.commands.archiveDraft.mutateAsync({ draftId: draft.id, expectedRevision: draft.revision });
      }
      setChecked(new Set());
    } catch (error) {
      review.report(error);
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <div>
      <PipelineHeader title="Approvals" subtitle={pipeline.isPending ? " " : subtitleFor(tab, drafts.length)} />

      <div className="ap-filters">
        <div className="ap-filter">
          <span className="rs-label">Status</span>
          <Select value={tab} onValueChange={(value) => setTab(value as ApprovalsTab)}>
            <SelectTrigger className="ap-select-trigger" aria-label="Status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(TAB_LABELS) as ApprovalsTab[]).map((key) => (
                <SelectItem key={key} value={key}>{TAB_LABELS[key]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {tab !== "pending" ? (
          <button type="button" className="rs-btn rs-btn-ghost rs-btn-sm" onClick={() => setTab("pending")}>
            <X /> Clear
          </button>
        ) : null}
      </div>

      <div className="ap-layout" data-pane={paneDetail && selectedId ? "detail" : "list"}>
        <section className="rs-card ap-list" aria-label="Approvals">
          <div className="ap-list-head">
            <span className="rs-label">{TAB_LABELS[tab]}</span>
            <NewPostButton
              accounts={pipeline.accounts}
              accountsLoading={pipeline.isPending && pipeline.accounts.length === 0}
              creating={review.commands.createDraft.isPending}
              onCreate={(target) => { void createPost(target); }}
            />
          </div>
          <ApprovalsList
            tab={tab}
            drafts={drafts}
            accounts={pipeline.accounts}
            statuses={statuses}
            loading={pipeline.isPending}
            error={pipeline.isError ? describeError(review.translate, pipeline.error) : null}
            onRetry={pipeline.refetch}
            selectedId={selectedId}
            onSelect={select}
            checked={checked}
            onCheck={(id, value) => {
              setChecked((current) => {
                const next = new Set(current);
                if (value) next.add(id);
                else next.delete(id);
                return next;
              });
            }}
            timeZone={review.timeZone}
          />
        </section>
        <ApprovalDetail review={review} account={account} onBack={() => setPaneDetail(false)} />
      </div>

      {checked.size > 0 ? (
        <div className="ap-bulk" role="region" aria-label="Bulk actions">
          <span className="rs-label !text-[color:var(--rs-ink)]">{checked.size} selected</span>
          <span className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rs-btn rs-btn-mint rs-btn-sm"
              disabled
              title="Each TikTok post needs its own settings and consent — open it to approve."
            >
              <Check /> Approve
            </button>
            <button type="button" className="rs-btn rs-btn-outline rs-btn-sm" disabled={bulkBusy} onClick={() => { void archiveChecked(); }}>
              <Archive /> Archive
            </button>
            <button type="button" className="rs-btn rs-btn-ghost rs-btn-sm" onClick={() => setChecked(new Set())}>
              <X /> Clear
            </button>
          </span>
        </div>
      ) : null}
    </div>
  );
}

function NewPostButton({
  accounts,
  accountsLoading,
  creating,
  onCreate,
}: {
  accounts: TikTokAccount[];
  accountsLoading: boolean;
  creating: boolean;
  onCreate: (account: TikTokAccount) => void;
}) {
  if (accountsLoading) return <span className="rs-skeleton h-[30px] w-24" />;
  if (accounts.length === 0) {
    return (
      <Link to={REVIEW_PATHS.integrations} className="rs-btn rs-btn-ink rs-btn-sm">
        <Plus /> Connect TikTok
      </Link>
    );
  }
  if (accounts.length === 1) {
    const only = accounts[0];
    return (
      <button type="button" className="rs-btn rs-btn-ink rs-btn-sm" disabled={creating} onClick={() => only && onCreate(only)}>
        <Plus /> New post
      </button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="rs-btn rs-btn-ink rs-btn-sm" disabled={creating}>
          <Plus /> New post
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {accounts.map((item) => (
          <DropdownMenuItem key={item.id} onSelect={() => onCreate(item)}>
            @{item.username}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface ApprovalsListProps {
  tab: ApprovalsTab;
  drafts: ReviewDraft[];
  accounts: TikTokAccount[];
  statuses: Map<string, PublishStatus>;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  checked: Set<string>;
  onCheck: (id: string, value: boolean) => void;
  timeZone: string;
}

function ApprovalsList(props: ApprovalsListProps) {
  if (props.loading && props.drafts.length === 0) {
    return (
      <div className="p-4" role="status" aria-label="Loading approvals">
        {[0, 1, 2].map((key) => (
          <div key={key} className="mb-4 flex gap-3">
            <div className="rs-skeleton h-8 w-8" />
            <div className="flex-1">
              <div className="rs-skeleton h-3.5 w-3/4" />
              <div className="rs-skeleton mt-2 h-2.5 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (props.error) {
    return (
      <div className="p-4" role="alert">
        <p className="ap-alert">{props.error}</p>
        <button type="button" className="rs-btn rs-btn-cream rs-btn-sm mt-2" onClick={props.onRetry}>Retry</button>
      </div>
    );
  }
  if (props.drafts.length === 0) {
    return (
      <p className="ap-empty">
        {props.accounts.length === 0 ? "Connect a TikTok account to start" : "Nothing in this filter"}
      </p>
    );
  }
  return (
    <div role="listbox" aria-label="Posts">
      {props.drafts.map((draft) => {
        const title = captionTitle(draft.caption, "Untitled post");
        const status = draftStatus(draft.state, props.statuses.get(draft.id)?.state ?? null);
        const username = props.accounts.find((item) => item.id === draft.accountId)?.username;
        const scheduled = draft.submission?.scheduledAt;
        return (
          <div
            key={draft.id}
            role="option"
            tabIndex={0}
            aria-selected={draft.id === props.selectedId}
            className="ap-row"
            onClick={() => props.onSelect(draft.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                props.onSelect(draft.id);
              }
            }}
          >
            {props.tab === "pending" ? (
              <span onClick={(event) => event.stopPropagation()} className="pt-2">
                <Checkbox
                  checked={props.checked.has(draft.id)}
                  onCheckedChange={(value) => props.onCheck(draft.id, value === true)}
                  aria-label={`Select ${title}`}
                />
              </span>
            ) : null}
            <span className="rs-tile"><TikTokGlyph /></span>
            <span className="min-w-0 flex-1">
              <span className="ap-row-title block">{title}</span>
              <span className="ap-meta block">
                TikTok{username ? ` · @${username}` : ""}
                {scheduled ? ` · ${formatInZone(scheduled, props.timeZone)}` : ""}
              </span>
              <span className="ap-row-pills">
                {props.tab !== "pending" ? <span className="rs-pill" data-tone={status.tone}>{status.pill}</span> : null}
                {draft.revision > 1 && draft.state === "pending_review" ? <span className="rs-pill" data-tone="indigo">Edited</span> : null}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
