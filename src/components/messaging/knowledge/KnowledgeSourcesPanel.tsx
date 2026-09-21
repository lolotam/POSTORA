import { useState } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n";
import type { TFunction } from "i18next";
import { Check, Circle, Download, Loader2, Pencil, RefreshCw, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { PlatformIcon } from "@/components/PlatformIcon";
import {
  requestSourceDownloadUrl,
  type AiKnowledgeSource,
} from "@/hooks/useAiKnowledge";
import { displaySourceTitle } from "@/lib/knowledgeSourceDisplay";
import { accountLabel, type SharingAccount } from "@/lib/knowledgeSharing";
import type { Platform } from "@/lib/types";

interface NamedAccount {
  id: string;
  platform: string;
  platform_username?: string | null;
  platform_user_id?: string | null;
}

/** The source types ingested from an uploaded object, and so the only ones with
 *  something to hand back. An allow-list mirroring the one `ingest_source`
 *  accepts: a future source type that carries no file then defaults to no
 *  download button, rather than to a button that always 404s. The fileless
 *  types today are website, catalog and profile_text. */
const DOWNLOADABLE_SOURCE_TYPES = ["csv", "excel", "pdf", "doc", "image"];

function sourceHasFile(sourceType: string): boolean {
  return DOWNLOADABLE_SOURCE_TYPES.includes(sourceType);
}

function IndexedBadge({ status, indexedAt }: { status: AiKnowledgeSource["status"]; indexedAt: string | null }) {
  const { t } = useTranslation("agent");
  if (status !== "ready") return null;
  if (!indexedAt) return null;
  const date = new Date(indexedAt);
  if (Number.isNaN(date.getTime())) return null;
  return (
    <Badge variant="outline" title={date.toLocaleString()}>
      {t("knowledge.indexed", "Indexed {{date}}", { date: date.toLocaleDateString() })}
    </Badge>
  );
}

/**
 * The stages a website source moves through, in order.
 *
 * Driven entirely by `metadata.stage`, which the ingest action and the worker
 * both write. No new transport: the sources query already polls every 5s while
 * a source is pending or processing, which is exactly the window this is shown
 * in.
 */
const CRAWL_STAGES = [
  { key: "crawling", label: "Reading pages" },
  { key: "extracting", label: "Extracting text" },
  { key: "embedding", label: "Indexing into the vector database" },
] as const;

function crawlLabel(key: (typeof CRAWL_STAGES)[number]["key"], fallback: string, t: TFunction): string {
  switch (key) {
    case "crawling": return t("knowledge.crawlCrawling", fallback);
    case "extracting": return t("knowledge.crawlExtracting", fallback);
    case "embedding": return t("knowledge.crawlEmbedding", fallback);
  }
}

function CrawlProgress({ metadata }: { metadata: Record<string, unknown> | null | undefined }) {
  const { t } = useTranslation("agent");
  const stage = String(metadata?.stage ?? "crawling");
  const current = CRAWL_STAGES.findIndex((entry) => entry.key === stage);
  const done = Number(metadata?.pages_done ?? NaN);
  const total = Number(metadata?.pages_total ?? NaN);
  const showCount = Number.isFinite(done) && Number.isFinite(total) && total > 0;

  return (
    <div className="mt-2 space-y-1">
      {CRAWL_STAGES.map((entry, index) => (
        <div key={entry.key} className="flex items-center gap-2 text-xs">
          {/* An unknown stage puts `current` at -1, which renders every step as
              still ahead rather than claiming progress nobody reported. */}
          {index < current ? (
            <Check className="h-3 w-3 text-emerald-500" />
          ) : index === current ? (
            <Loader2 className="h-3 w-3 animate-spin text-primary" />
          ) : (
            <Circle className="h-3 w-3 text-muted-foreground/40" />
          )}
          <span className={index <= current ? "text-foreground" : "text-muted-foreground"}>
            {crawlLabel(entry.key, entry.label, t)}
            {index === current && showCount ? ` (${done}/${total})` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

function sourceStatusLabel(status: AiKnowledgeSource["status"], t: TFunction): string {
  switch (status) {
    case "pending": return t("common:status.pending", "pending");
    case "processing": return t("common:status.processing", "processing");
    case "failed": return t("common:status.failed", "failed");
    case "ready": return t("knowledge.statusReady", "ready");
    default: return status;
  }
}

export interface KnowledgeSourcesPanelProps {
  /** Already narrowed to what this account can read. */
  sources: AiKnowledgeSource[];
  /** The unfiltered total, so "nothing exists" and "nothing here" stay distinguishable. */
  allSourcesCount: number;
  isLoading: boolean;
  linksError: unknown;
  accountsError: unknown;
  linksReady: boolean;
  accountsReady: boolean;
  shareAccounts: SharingAccount[];
  sharedBySource: Map<string, string[]>;
  sharingSourceIds: readonly string[];
  socialAccounts: NamedAccount[];
  busy: boolean;
  onReingest: (source: AiKnowledgeSource) => void;
  onDelete: (source: AiKnowledgeSource) => void;
  /** Rename any source; the label is display only, never an identity. */
  onRename: (source: AiKnowledgeSource, fileName: string) => void;
  onToggleShare: (source: AiKnowledgeSource, target: SharingAccount, checked: boolean) => void;
}

/**
 * The live mirror of the vector database.
 *
 * Pinned below the input methods rather than living inside one of them: what
 * the agent can actually read is the answer to "did that work", and it is the
 * same answer whichever way the source got there.
 */
export function KnowledgeSourcesPanel({
  sources,
  allSourcesCount,
  isLoading,
  linksError,
  accountsError,
  linksReady,
  accountsReady,
  shareAccounts,
  sharedBySource,
  sharingSourceIds,
  socialAccounts,
  busy,
  onReingest,
  onDelete,
  onRename,
  onToggleShare,
}: KnowledgeSourcesPanelProps) {
  const { t } = useTranslation("agent");
  // One row editable at a time; the draft is local until Save so a stray
  // keystroke never reaches the server.
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const submitRename = (source: AiKnowledgeSource) => {
    const next = (renaming?.draft ?? "").replace(/\s+/g, " ").trim();
    setRenaming(null);
    if (!next || next === source.file_name) return;
    onRename(source, next);
  };
  // A set, not one id: the row being resolved is the only one disabled, so a
  // second download can start while the first is still in flight. With a single
  // id the later click overwrote the earlier one and whichever settled first
  // cleared the shared state, showing the other row as idle while it ran.
  const [downloadingIds, setDownloadingIds] = useState<ReadonlySet<string>>(new Set());

  const markDownloading = (sourceId: string, active: boolean) =>
    setDownloadingIds((current) => {
      const next = new Set(current);
      if (active) next.add(sourceId);
      else next.delete(sourceId);
      return next;
    });

  const downloadSource = async (sourceId: string) => {
    markDownloading(sourceId, true);
    try {
      const url = await requestSourceDownloadUrl(sourceId);
      window.location.assign(url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("toast.downloadFailed", "Could not download source"));
    } finally {
      markDownloading(sourceId, false);
    }
  };

  const accountCountLabel = (count: number) =>
    count === 1
      ? t("knowledge.oneAccount", "{{count}} account", { count })
      : t("knowledge.nAccounts", "{{count}} accounts", { count });

  const reingestTitle = (sourceType: string) => {
    if (sourceType === "catalog") return t("knowledge.reingestCatalog", "Use Sync catalog");
    if (sourceType === "website") return t("knowledge.reingestWebsite", "Delete and scrape the address again to refresh a website");
    return t("knowledge.reingest", "Re-ingest");
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("knowledge.sourcesTitle", "Sources in the vector database")}</CardTitle>
        <CardDescription>
          {t("knowledge.sourcesDescription", "Everything the agent can actually read. Live status, chunk counts, and which agents each source reaches.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : linksError ? (
          // Say the list is unreliable rather than render an unfiltered or
          // over-filtered one, either of which reads as fact.
          <p className="text-sm text-destructive">
            {t("knowledge.couldNotCheckSources", "Could not check which sources this account can use. Refresh to try again.")}
          </p>
        ) : sources.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {allSourcesCount === 0
              ? t("knowledge.sourcesEmptyAll", "No knowledge sources yet.")
              : t("knowledge.sourcesEmptyAccount", "No sources are available to this account yet.")}
          </p>
        ) : (
          sources.map((source) => (
            <div
              key={source.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
            >
              <div>
                {renaming?.id === source.id ? (
                  <form
                    className="flex items-center gap-2"
                    onSubmit={(event) => { event.preventDefault(); submitRename(source); }}
                  >
                    <Input
                      aria-label={t("knowledge.sourceName", "Source name")}
                      autoFocus
                      maxLength={120}
                      className="h-8 w-72"
                      value={renaming.draft}
                      onChange={(event) => setRenaming({ id: source.id, draft: event.target.value })}
                      onKeyDown={(event) => { if (event.key === "Escape") setRenaming(null); }}
                    />
                    <Button type="submit" size="sm" className="h-8" disabled={busy}>
                      {t("common:save", "Save")}
                    </Button>
                    <Button type="button" size="icon" variant="ghost" className="h-8 w-8" aria-label={t("knowledge.cancelRename", "Cancel rename")} onClick={() => setRenaming(null)}>
                      <X className="h-4 w-4" />
                    </Button>
                  </form>
                ) : (
                  <p className="flex items-center gap-1.5 font-medium">
                    {displaySourceTitle(source.file_name, socialAccounts)}
                    <button
                      type="button"
                      aria-label={t("knowledge.renameSource", "Rename source")}
                      title={t("common:rename", "Rename")}
                      className="text-muted-foreground hover:text-foreground"
                      disabled={busy}
                      onClick={() => setRenaming({
                        id: source.id,
                        draft: displaySourceTitle(source.file_name, socialAccounts) ?? "",
                      })}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  </p>
                )}
                <div className="mt-1 flex gap-2">
                  <Badge variant="secondary">{source.source_type}</Badge>
                  {/* How many OTHER accounts can read this, stated rather than
                      inferred from the fact that it appears in this account's
                      list. Counted from the effective set, not from
                      `visibility` alone: once a source is shared with three of
                      five accounts it is neither "all accounts" nor "this
                      account", and calling it either would be a lie the
                      checkbox strip below immediately contradicts. */}
                  <Badge variant={source.visibility === "shared" ? "outline" : "secondary"}>
                    {source.visibility === "shared"
                      ? t("knowledge.allAccounts", "All accounts")
                      : accountsReady
                        ? accountCountLabel((sharedBySource.get(source.id) ?? []).length)
                        : // The count is derived from the accounts list; without
                          // it, "0 accounts" would be a claim rather than a
                          // reading. Say only what is still known.
                          t("knowledge.someAccounts", "Some accounts")}
                  </Badge>
                  <Badge
                    variant={
                      source.status === "failed"
                        ? "destructive"
                        : source.status === "ready"
                          ? "default"
                          : "secondary"
                    }
                  >
                    {["pending", "processing"].includes(source.status) && (
                      <Loader2 className="me-1 h-3 w-3 animate-spin" />
                    )}
                    {sourceStatusLabel(source.status, t)}
                    {source.status === "ready" ? t("knowledge.chunksSuffix", " · {{count}} chunks", { count: source.chunk_count }) : ""}
                    {/* A large file is indexed in resumable slices and sits
                        `pending` between them; the running count is what tells
                        a slow file apart from a stuck one. */}
                    {["pending", "processing"].includes(source.status) && source.chunk_count > 0
                      ? t("knowledge.chunksSoFarSuffix", " · {{count}} chunks so far", { count: source.chunk_count })
                      : ""}
                  </Badge>
                  <IndexedBadge status={source.status} indexedAt={source.indexed_at} />
                </div>
                {source.source_type === "website" &&
                  ["pending", "processing"].includes(source.status) && (
                    <CrawlProgress metadata={source.metadata} />
                  )}
                {source.error && <p className="mt-1 text-xs text-destructive">{source.error}</p>}
              </div>
              <div className="flex gap-2">
                {sourceHasFile(source.source_type) && (
                  <Button
                    size="icon"
                    variant="outline"
                    aria-label={t("knowledge.downloadSource", "Download source")}
                    disabled={busy || downloadingIds.has(source.id)}
                    title={t("common:download", "Download")}
                    onClick={() => void downloadSource(source.id)}
                  >
                    {downloadingIds.has(source.id) ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4" />
                    )}
                  </Button>
                )}
                {/* Re-ingest goes through `ingest_source`, which accepts only the
                    uploaded file types. A catalog has its own sync button, and a
                    website has no re-scrape action yet -- offering the control
                    anyway would just return "Source type not supported". */}
                <Button
                  size="icon"
                  variant="outline"
                  aria-label={t("knowledge.reingestSource", "Re-ingest source")}
                  disabled={
                    source.source_type === "catalog" ||
                    source.source_type === "website" ||
                    busy
                  }
                  title={reingestTitle(source.source_type)}
                  onClick={() => onReingest(source)}
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="destructive"
                  aria-label={t("knowledge.deleteSource", "Delete source")}
                  disabled={busy}
                  onClick={() => onDelete(source)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              {/* Which agents can read this file. Ticking a box links the
                  ALREADY-INDEXED chunks to that account, so a price list
                  uploaded under Facebook answers Instagram customers with no
                  second upload and no second embedding bill; unticking hides
                  it from that agent again without touching the chunks.

                  `w-full` inside the flex-wrap row above puts the strip on
                  its own line. Drawn only once the links have loaded: an
                  unsettled read renders every box unchecked, and a click on
                  that would write the wrong state back as if it were chosen. */}
              {accountsError ? (
                // Named, not hidden. Silently dropping the strip on a failed
                // account read tells the user sharing is unavailable, when in
                // fact the page simply does not know who to offer.
                <p className="mt-3 w-full border-t pt-3 text-xs text-destructive">
                  {t("knowledge.accountsCouldNotLoad", "Could not load your connected accounts, so sharing cannot be changed here. Refresh to try again.")}
                </p>
              ) : (
                linksReady &&
                accountsReady &&
                shareAccounts.length > 1 && (
                  <div className="mt-3 w-full border-t pt-3">
                    <p className="mb-2 text-xs font-medium text-muted-foreground">
                      {t("knowledge.agentsThatCanRead", "Agents that can read this")}
                    </p>
                    <div className="flex flex-wrap gap-x-4 gap-y-2">
                      {shareAccounts.map((account) => (
                        <label
                          key={account.id}
                          className="flex cursor-pointer items-center gap-2 text-sm"
                        >
                          <Checkbox
                            checked={(sharedBySource.get(source.id) ?? []).includes(account.id)}
                            disabled={sharingSourceIds.includes(source.id)}
                            onCheckedChange={(value) =>
                              onToggleShare(source, account, value === true)
                            }
                            aria-label={t("knowledge.shareWith", "Share {{source}} with {{account}}", {
                              source: displaySourceTitle(source.file_name, socialAccounts),
                              account: accountLabel(account),
                            })}
                          />
                          {/* Safe narrowing: agentAccounts already filtered to
                              the four agent platforms, all of which are members
                              of Platform. */}
                          <PlatformIcon platform={account.platform as Platform} size="xs" />
                          <span>{accountLabel(account)}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
