/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useState } from "react";
import { ExternalLink, FileArchive, Loader2, RefreshCw, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  useAiAgentConfig,
  type AiAgentPlatform,
} from "@/hooks/useAiAgentConfig";
import { useAiKnowledge } from "@/hooks/useAiKnowledge";
import { useWhatsAppCatalog } from "@/hooks/useWhatsAppCatalog";
import { useSocialAccounts } from "@/hooks/useSocialAccounts";
import { Checkbox } from "@/components/ui/checkbox";
import type { Platform } from "@/lib/types";
import { PlatformIcon } from "@/components/PlatformIcon";
import { displaySourceTitle } from "@/lib/knowledgeSourceDisplay";
import { visibleToAccount } from "@/lib/knowledgeVisibility";
import {
  accountLabel,
  agentAccounts,
  effectiveAccountIds,
  nextSharing,
  type SharingAccount,
} from "@/lib/knowledgeSharing";
import {
  AI_KNOWLEDGE_ACCEPT,
  AI_KNOWLEDGE_BUCKET,
  aiKnowledgeContentType,
  aiKnowledgeObjectPath,
  aiKnowledgeStorageRef,
  getKnowledgeSourceType,
} from "@/lib/aiKnowledge";
import { supabase } from "@/integrations/supabase/client";

export function AiKnowledgeManager({
  platform,
  accountId,
}: {
  platform: AiAgentPlatform;
  // The business profile below belongs to the selected account's config, so
  // the manager passes its selection down and reads/writes through it.
  accountId?: string | null;
}) {
  const { config, error, upsertConfig } = useAiAgentConfig(platform, accountId);
  const { user, sources, links, linksReady, linksError, isLoading, graphExport, invoke, resolveExportUrls } = useAiKnowledge();
  const { data: socialAccounts = [] } = useSocialAccounts();
  const isWhatsApp = platform === "whatsapp";
  const catalogHook = useWhatsAppCatalog();
  const waAccount = isWhatsApp ? catalogHook.waAccount : null;
  const catalog = isWhatsApp ? catalogHook.catalog : null;
  const [profile, setProfile] = useState("");
  const [uploading, setUploading] = useState(false);
  // Where a NEW upload lands. Defaults to the selected account, because a file
  // added while looking at one page is almost always that page's -- and until
  // this existed every upload was hardcoded shared, so a WhatsApp price list
  // answered Instagram customers too. "All accounts" stays one click away.
  const [uploadScope, setUploadScope] = useState<"account" | "all">("account");
  const selectedAccountLabel = socialAccounts.find((account) => account.id === accountId)
    ?.platform_username ?? null;
  // Set when a stored export link cannot be resolved (e.g. the object is gone
  // or the row predates signed URLs) — the button degrades to disabled until
  // exports are regenerated, never to a broken link.
  const [unresolvable, setUnresolvable] = useState({ html: false, vault: false });
  // Same rule as the settings form: `config` is undefined until the read
  // settles, and an unsettled read must not be saved over. Switching account
  // while B's config was still in flight would otherwise write A's editor
  // contents -- or an empty string -- into B's business profile, and
  // ingest_profile_text deletes and re-indexes the source from whatever it is
  // given.
  // `error` matters as much as `config`: React Query keeps the previously cached
  // data through a failed refetch, so a config that is present can still belong
  // to another account while THIS read errored -- and saving would then write
  // that account's profile here. The settings form learned this on 2026-08-28;
  // this surface never did, which is why it was still the weaker of the two.
  //
  // `loadedAccountId === accountId` is deliberately NOT needed here: `profile` is
  // re-derived from `profileText` whenever the config changes, and the query key
  // already contains the account, so a settled non-error read is this account's.
  const configLoaded = config !== undefined && !error;
  const profileText = config?.business_profile_text || "";
  useEffect(() => setProfile(profileText), [profileText]);
  // An empty box over a stored value is the user having deleted it -- the same
  // asymmetry the settings form relies on, since the loaded config IS the
  // baseline here. Declared to the server rather than refused: refusing would
  // leave a business profile unclearable, because no other surface edits this
  // field, and would make the ingest delete branch unreachable.
  const wouldBlankStoredProfile = profile.trim() === "" && profileText.trim() !== "";
  // The same predicate the retrieval RPCs use, so the list cannot promise the
  // agent a document it will not read, or hide one it will.
  // Filtering only once the links have actually arrived. An empty link set from
  // an unsettled or failed read is indistinguishable from "linked to nothing",
  // and acting on it would hide every restricted source behind a confident
  // "nothing available here".
  const visibleSources = useMemo(
    () =>
      linksReady
        ? sources.filter((source) => visibleToAccount(source, accountId ?? null, links))
        : sources,
    [sources, accountId, links, linksReady],
  );
  const run = async (
    action: string,
    body: Record<string, unknown>,
    success: string,
  ) => {
    try {
      await invoke.mutateAsync({ action, ...body });
      toast.success(success);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Knowledge action failed",
      );
    }
  };
  // Every connected account that can actually run an agent. This is the
  // checkbox strip on each source: ticking one shares the ALREADY-INDEXED
  // chunks with that account's agent, so a price list uploaded under Facebook
  // answers Instagram customers without a second upload or a second embedding
  // bill.
  const shareAccounts = useMemo(
    () => agentAccounts(socialAccounts),
    [socialAccounts],
  );
  // One pass over the link table for the whole list, so each checkbox is a
  // lookup instead of a scan. A shared source has no link rows at all, which is
  // why this goes through effectiveAccountIds rather than reading `links`
  // directly -- otherwise every box on a shared source would render unchecked.
  const sharedBySource = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const source of sources) {
      map.set(source.id, effectiveAccountIds(source, shareAccounts, links));
    }
    return map;
  }, [sources, shareAccounts, links]);
  // Which source is mid-write, so only its own strip goes disabled. A single
  // `invoke.isPending` would freeze every row on the page.
  const [sharingSourceId, setSharingSourceId] = useState<string | null>(null);
  const toggleShare = async (
    source: { id: string; visibility: "shared" | "restricted" },
    target: SharingAccount,
    checked: boolean,
  ) => {
    const next = nextSharing({
      source,
      accounts: shareAccounts,
      links,
      accountId: target.id,
      checked,
    });
    // Restricted with zero links is a source no agent can read AND no account
    // can list -- it would vanish from this page with no way back, since the
    // strip that could restore it is only drawn on rows the account can see.
    // The database allows that state on purpose; the UI must not be the thing
    // that strands a file in it.
    if (next.social_account_ids.length === 0) {
      toast.error(
        "At least one account has to keep this source. Delete it instead if no agent should read it.",
      );
      return;
    }
    setSharingSourceId(source.id);
    // Through `run` like every other action here, so the failure toast stays
    // identical. It reports rather than rethrows, which is why clearing the
    // pending flag needs no try/finally.
    await run(
      "set_source_visibility",
      {
        source_id: source.id,
        visibility: next.visibility,
        // The RPC REPLACES the link set, so the full desired list goes every
        // time -- a delta would strip the source from every other agent.
        social_account_ids: next.social_account_ids,
      },
      checked
        ? `Shared with ${accountLabel(target)}`
        : `Removed from ${accountLabel(target)}`,
    );
    // Fresh links are already in cache by here: mutateAsync resolves only after
    // the mutation's onSuccess refresh has invalidated and refetched them. That
    // is what keeps a fast second click from computing its full set out of
    // stale links and dropping the account the first click just added -- so if
    // `refresh` ever becomes fire-and-forget, this race reopens silently.
    setSharingSourceId(null);
  };
  const saveProfile = async () => {
    try {
      await upsertConfig.mutateAsync({
        business_profile_text: profile,
        confirm_clear: wouldBlankStoredProfile || undefined,
      });
      await run(
        "ingest_profile_text",
        // Naming the account keeps the re-index reading the same config the
        // save just wrote, instead of an ambiguous (user, platform) lookup.
        { platform, social_account_id: accountId ?? undefined },
        "Business profile indexed",
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not save business profile",
      );
    }
  };
  const openExport = async (kind: "html" | "vault") => {
    // The tab is opened synchronously, inside the click's user activation, and
    // pointed at the signed URL once it arrives. Calling window.open after the
    // await instead would be treated as an unsolicited popup and silently
    // blocked, so the button would appear to do nothing.
    const tab = window.open("", "_blank", "noopener,noreferrer");
    try {
      const urls = await resolveExportUrls.mutateAsync();
      const url = kind === "html" ? urls.html_url : urls.vault_url;
      if (!url) {
        tab?.close();
        setUnresolvable((prev) => ({ ...prev, [kind]: true }));
        toast.error("Export link is unavailable — regenerate the exports.");
        return;
      }
      if (tab) {
        tab.location.replace(url);
      } else {
        // The browser blocked the pre-opened tab; fall back to this one rather
        // than losing the link the user just waited for.
        window.location.assign(url);
      }
    } catch (error) {
      tab?.close();
      toast.error(
        error instanceof Error ? error.message : "Could not open export",
      );
    }
  };
  const upload = async (file?: File) => {
    if (!file || !user) return;
    const type = getKnowledgeSourceType(file.name);
    if (!type) {
      toast.error("Supported files: CSV, XLSX, XLS, PDF, TXT, MD, PNG, JPG, WEBP.");
      return;
    }
    const scopeToAccount = uploadScope === "account" && !!accountId;
    setUploading(true);
    // Set once the upload succeeds and cleared once the source row exists:
    // only on that stretch is the object unreferenced storage nobody can see
    // or delete from the UI (the row is what makes the object reachable).
    // Every failure on it — a resolved { error } or a rejected request — must
    // remove the object again.
    let orphanedObjectPath: string | null = null;
    try {
      // Knowledge files are business documents — price lists, company profiles,
      // internal templates — so they go straight into the private ai-knowledge
      // bucket under the uploader's own folder. They used to be pushed to a
      // public Cloudinary URL that anyone holding the link could read, and whose
      // path spelled out the owner's email address.
      const objectPath = aiKnowledgeObjectPath(user.id, file.name, crypto.randomUUID());
      const { error: uploadError } = await supabase.storage
        .from(AI_KNOWLEDGE_BUCKET)
        .upload(objectPath, file, { contentType: aiKnowledgeContentType(file.name) });
      if (uploadError) throw uploadError;
      orphanedObjectPath = objectPath;
      // The row is created through the create_ai_knowledge_source RPC so the
      // source, its visibility, and its account links land in one
      // transaction — a direct insert followed by separate link writes could
      // fail in between and leave a source no account can read. Every
      // document is shared with every account today; assigning documents to
      // specific accounts is a later change.
      const { data: sourceId, error } = await (supabase as any).rpc(
        "create_ai_knowledge_source",
        {
          p_source_type: type,
          p_file_name: file.name,
          p_file_path: aiKnowledgeStorageRef(objectPath),
          // A restricted source MUST name at least one account (the RPC refuses
          // otherwise), so with no account selected the only honest choice is
          // shared -- silently narrowing to an account we do not have would
          // create a source nothing can retrieve.
          p_social_account_ids: scopeToAccount ? [accountId] : [],
          p_visibility: scopeToAccount ? "restricted" : "shared",
        },
      );
      if (error) throw error;
      orphanedObjectPath = null;
      await run(
        "ingest_source",
        { source_id: sourceId },
        "Knowledge file indexed",
      );
    } catch (error) {
      if (orphanedObjectPath) {
        try {
          const { error: removeError } = await supabase.storage
            .from(AI_KNOWLEDGE_BUCKET)
            .remove([orphanedObjectPath]);
          // Compensation reports its own failure but never replaces the
          // error that caused the rollback.
          if (removeError) {
            console.error("Failed to remove orphaned knowledge upload:", removeError);
          }
        } catch (cleanupError) {
          console.error("Failed to remove orphaned knowledge upload:", cleanupError);
        }
      }
      toast.error(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Business profile</CardTitle>
          <CardDescription>
            This is included in what the AI knows.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={profile}
            onChange={(event) => setProfile(event.target.value)}
            rows={6}
            placeholder="Describe your business, products, policies, and FAQs."
          />
          <Button
            onClick={saveProfile}
            disabled={!configLoaded || upsertConfig.isPending || invoke.isPending}
          >
            {(upsertConfig.isPending || invoke.isPending) && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Save & index
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Upload knowledge file</CardTitle>
          <CardDescription>
            Spreadsheets (CSV/XLSX/XLS), PDFs, text files (TXT/MD), and images
            (PNG/JPG/WEBP — text is extracted automatically).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {accountId && (
            <div className="space-y-1.5">
              <Label htmlFor="upload-scope">Available to</Label>
              <Select
                value={uploadScope}
                onValueChange={(value) => setUploadScope(value as "account" | "all")}
              >
                <SelectTrigger id="upload-scope" className="w-full max-w-xs" data-testid="upload-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="account">
                    {selectedAccountLabel ? `Only ${selectedAccountLabel}` : "Only this account"}
                  </SelectItem>
                  <SelectItem value="all">All accounts</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Applies to the next file you upload. Existing files keep the scope they were
                given.
              </p>
            </div>
          )}
          <label className="flex cursor-pointer items-center gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={uploading}
              asChild
            >
              <span>
                {uploading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="mr-2 h-4 w-4" />
                )}
                Upload file
              </span>
            </Button>
            <input
              className="sr-only"
              type="file"
              accept={AI_KNOWLEDGE_ACCEPT}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                upload(file);
              }}
            />
          </label>
        </CardContent>
      </Card>
      {isWhatsApp && (
        <Card>
          <CardHeader>
            <CardTitle>WhatsApp catalog</CardTitle>
            <CardDescription>
              {waAccount && catalog?.catalog_id
                ? "Sync products for AI product answers."
                : "Connect a WhatsApp account with a catalog to sync products."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={() =>
                run(
                  "sync_catalog",
                  {
                    social_account_id: waAccount!.id,
                    catalog_id: catalog!.catalog_id,
                  },
                  "Catalog synced",
                )
              }
              disabled={!waAccount || !catalog?.catalog_id || invoke.isPending}
            >
              Sync catalog
            </Button>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Sources</CardTitle>
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
          ) : visibleSources.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {sources.length === 0
                ? "No knowledge sources yet."
                : "No sources are available to this account yet."}
            </p>
          ) : (
            visibleSources.map((source) => (
              <div
                key={source.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
              >
                <div>
                  <p className="font-medium">
                    {displaySourceTitle(source.file_name, socialAccounts)}
                  </p>
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
                        : `${(sharedBySource.get(source.id) ?? []).length} account${
                            (sharedBySource.get(source.id) ?? []).length === 1 ? "" : "s"
                          }`}
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
                      {source.status === "ready"
                        ? ` · ${source.chunk_count} chunks`
                        : ""}
                    </Badge>
                  </div>
                  {source.error && (
                    <p className="mt-1 text-xs text-destructive">
                      {source.error}
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button
                    size="icon"
                    variant="outline"
                    aria-label="Re-ingest source"
                    disabled={
                      source.source_type === "catalog" || invoke.isPending
                    }
                    title={
                      source.source_type === "catalog"
                        ? "Use Sync catalog"
                        : "Re-ingest"
                    }
                    onClick={() =>
                      run(
                        source.source_type === "profile_text"
                          ? "ingest_profile_text"
                          : "ingest_source",
                        source.source_type === "profile_text"
                          ? { platform, social_account_id: accountId ?? undefined }
                          : { source_id: source.id },
                        "Source indexing started",
                      )
                    }
                  >
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="destructive"
                    aria-label="Delete source"
                    disabled={invoke.isPending}
                    onClick={() =>
                      run(
                        "delete_source",
                        { source_id: source.id },
                        "Source deleted",
                      )
                    }
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
                {linksReady && shareAccounts.length > 1 && (
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
                            disabled={sharingSourceId === source.id}
                            onCheckedChange={(value) =>
                              toggleShare(source, account, value === true)
                            }
                            aria-label={`Share ${displaySourceTitle(source.file_name, socialAccounts)} with ${accountLabel(account)}`}
                          />
                          {/* Safe narrowing: agentAccounts already filtered to
                              the four agent platforms, all of which are members
                              of Platform. */}
                          <PlatformIcon
                            platform={account.platform as Platform}
                            size="xs"
                          />
                          <span>{accountLabel(account)}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Knowledge graph</CardTitle>
          <CardDescription>
            Generate inspection exports from the knowledge currently indexed for this business.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={invoke.isPending}
            onClick={async () => {
              await run("export_graph", {}, "Knowledge graph exports generated");
              setUnresolvable({ html: false, vault: false });
            }}
          >
            {invoke.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Generate exports
          </Button>
          {graphExport?.html_url && (
            <Button
              variant="secondary"
              disabled={unresolvable.html || resolveExportUrls.isPending}
              title={unresolvable.html ? "Regenerate exports to refresh this link" : undefined}
              onClick={() => openExport("html")}
            >
              {resolveExportUrls.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <ExternalLink className="mr-2 h-4 w-4" />
              )}
              Open graph
            </Button>
          )}
          {graphExport?.vault_url && (
            <Button
              variant="secondary"
              disabled={unresolvable.vault || resolveExportUrls.isPending}
              title={unresolvable.vault ? "Regenerate exports to refresh this link" : undefined}
              onClick={() => openExport("vault")}
            >
              {resolveExportUrls.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <FileArchive className="mr-2 h-4 w-4" />
              )}
              Download vault
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
