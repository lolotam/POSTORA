import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { PlatformIcon } from "@/components/PlatformIcon";
import type { AiKnowledgeSource } from "@/hooks/useAiKnowledge";
import { displaySourceTitle } from "@/lib/knowledgeSourceDisplay";
import { accountLabel, type SharingAccount } from "@/lib/knowledgeSharing";
import type { Platform } from "@/lib/types";

interface NamedAccount {
  id: string;
  platform: string;
  platform_username?: string | null;
  platform_user_id?: string | null;
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
  onToggleShare,
}: KnowledgeSourcesPanelProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sources in the vector database</CardTitle>
        <CardDescription>
          Everything the agent can actually read. Live status, chunk counts, and which agents each
          source reaches.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : linksError ? (
          // Say the list is unreliable rather than render an unfiltered or
          // over-filtered one, either of which reads as fact.
          <p className="text-sm text-destructive">
            Could not check which sources this account can use. Refresh to try again.
          </p>
        ) : sources.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {allSourcesCount === 0
              ? "No knowledge sources yet."
              : "No sources are available to this account yet."}
          </p>
        ) : (
          sources.map((source) => (
            <div
              key={source.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
            >
              <div>
                <p className="font-medium">{displaySourceTitle(source.file_name, socialAccounts)}</p>
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
                      ? "All accounts"
                      : accountsReady
                        ? `${(sharedBySource.get(source.id) ?? []).length} account${
                            (sharedBySource.get(source.id) ?? []).length === 1 ? "" : "s"
                          }`
                        : // The count is derived from the accounts list; without
                          // it, "0 accounts" would be a claim rather than a
                          // reading. Say only what is still known.
                          "Some accounts"}
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
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    )}
                    {source.status}
                    {source.status === "ready" ? ` · ${source.chunk_count} chunks` : ""}
                  </Badge>
                </div>
                {source.error && <p className="mt-1 text-xs text-destructive">{source.error}</p>}
              </div>
              <div className="flex gap-2">
                <Button
                  size="icon"
                  variant="outline"
                  aria-label="Re-ingest source"
                  disabled={source.source_type === "catalog" || busy}
                  title={source.source_type === "catalog" ? "Use Sync catalog" : "Re-ingest"}
                  onClick={() => onReingest(source)}
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="destructive"
                  aria-label="Delete source"
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
                  Could not load your connected accounts, so sharing cannot be changed here.
                  Refresh to try again.
                </p>
              ) : (
                linksReady &&
                accountsReady &&
                shareAccounts.length > 1 && (
                  <div className="mt-3 w-full border-t pt-3">
                    <p className="mb-2 text-xs font-medium text-muted-foreground">
                      Agents that can read this
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
                            aria-label={`Share ${displaySourceTitle(source.file_name, socialAccounts)} with ${accountLabel(account)}`}
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
