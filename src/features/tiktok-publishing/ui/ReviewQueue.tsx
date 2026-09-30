import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ReviewDraft, ReviewState, TikTokAccount } from "../domain/types";
import { captionTitle } from "./reviewCopy";

const FILTERS: readonly ReviewState[] = ["pending_review", "rejected", "archived", "submitted"];

export type QueueScreen =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "empty"; message: string }
  | { kind: "ready"; drafts: ReviewDraft[] };

interface ReviewQueueProps {
  headerLink: ReactNode;
  accounts: TikTokAccount[];
  accountId: string | null;
  onAccountId: (accountId: string) => void;
  accountsLoading: boolean;
  filter: ReviewState;
  onFilter: (state: ReviewState) => void;
  pendingCount: number | null;
  pendingLoading: boolean;
  queue: QueueScreen;
  selectedId: string | null;
  onSelect: (draftId: string) => void;
  onCreate: () => void;
  creating: boolean;
  onRetry: () => void;
}

function stateLabel(t: (key: string, fallback: string) => string, state: ReviewState): string {
  switch (state) {
    case "pending_review":
      return t("tiktokReview.state.pending_review", "Pending review");
    case "rejected":
      return t("tiktokReview.state.rejected", "Rejected");
    case "archived":
      return t("tiktokReview.state.archived", "Archived");
    case "submitted":
      return t("tiktokReview.state.submitted", "Submitted");
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}

export function ReviewQueue({
  headerLink,
  accounts,
  accountId,
  onAccountId,
  accountsLoading,
  filter,
  onFilter,
  pendingCount,
  pendingLoading,
  queue,
  selectedId,
  onSelect,
  onCreate,
  creating,
  onRetry,
}: ReviewQueueProps) {
  const { t } = useTranslation("post");
  const waiting = pendingLoading
    ? t("tiktokReview.waitingLoading", "Loading the waiting count…")
    : pendingCount === null
      ? t("tiktokReview.waitingUnknown", "Waiting count unavailable.")
      : t("tiktokReview.waiting", `${pendingCount} items waiting.`);

  return (
    <section className="tiktok-review-queue" aria-label={t("tiktokReview.queueLabel", "TikTok review queue")}>
      <div className="tiktok-review-topbar">{headerLink}</div>
      <p className="tiktok-review-eyebrow">{t("tiktokReview.eyebrow", "Publishing")}</p>
      <h1 className="tiktok-review-title">{t("tiktokReview.title", "TikTok review")}</h1>
      <p className="tiktok-review-waiting">{waiting}</p>
      <div className="tiktok-review-filters">
        <label className="tiktok-review-secondary">
          <span className="tiktok-review-eyebrow">{t("tiktokReview.accountLabel", "Account")}</span>
          <select
            className="tiktok-review-select"
            value={accountId ?? ""}
            disabled={accountsLoading || accounts.length === 0}
            onChange={(event) => onAccountId(event.target.value)}
          >
            {accounts.length === 0 ? (
              <option value="">{t("tiktokReview.noAccount", "No TikTok account")}</option>
            ) : null}
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                @{account.username || account.id}
              </option>
            ))}
          </select>
        </label>
        <label className="tiktok-review-secondary">
          <span className="tiktok-review-eyebrow">{t("tiktokReview.statusLabel", "Status")}</span>
          <select
            className="tiktok-review-select"
            value={filter}
            onChange={(event) => {
              const next = FILTERS.find((state) => state === event.target.value);
              if (next) onFilter(next);
            }}
          >
            {FILTERS.map((state) => (
              <option key={state} value={state}>{stateLabel(t, state)}</option>
            ))}
          </select>
        </label>
        <button type="button" className="tiktok-review-button tiktok-review-new" onClick={onCreate} disabled={creating || !accountId}>
          {t("tiktokReview.newPost", "New post")}
        </button>
      </div>
      <QueueBody queue={queue} selectedId={selectedId} onSelect={onSelect} onRetry={onRetry} />
    </section>
  );
}

function QueueBody({
  queue,
  selectedId,
  onSelect,
  onRetry,
}: {
  queue: QueueScreen;
  selectedId: string | null;
  onSelect: (draftId: string) => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation("post");
  switch (queue.kind) {
    case "loading":
      return <p role="status">{t("tiktokReview.loadingPosts", "Loading posts…")}</p>;
    case "error":
      return (
        <div role="alert">
          <p className="tiktok-review-alert">{queue.message}</p>
          <button type="button" className="tiktok-review-button tiktok-review-button-edit" onClick={onRetry}>
            {t("tiktokReview.retry", "Retry")}
          </button>
        </div>
      );
    case "empty":
      return <p>{queue.message}</p>;
    case "ready":
      return (
        <ul className="tiktok-review-rows">
          {queue.drafts.map((draft) => (
            <li key={draft.id}>
              <button
                type="button"
                className={draft.id === selectedId ? "tiktok-review-row is-selected" : "tiktok-review-row"}
                aria-current={draft.id === selectedId ? "true" : undefined}
                onClick={() => onSelect(draft.id)}
              >
                <span className="tiktok-review-row-title">
                  {captionTitle(draft.caption, t("tiktokReview.untitled", "Untitled post"))}
                </span>
                <span className={draft.state === "rejected" ? "tiktok-review-chip tiktok-review-chip-rejected" : "tiktok-review-chip"}>
                  {stateLabel(t, draft.state)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      );
    default: {
      const unreachable: never = queue;
      return unreachable;
    }
  }
}
