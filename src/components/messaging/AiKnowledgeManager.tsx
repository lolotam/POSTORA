/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState } from "react";
import { Globe, PencilLine, Upload } from "lucide-react";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useAiAgentConfig,
  type AiAgentPlatform,
} from "@/hooks/useAiAgentConfig";
import { useAiKnowledge } from "@/hooks/useAiKnowledge";
import { useWhatsAppCatalog } from "@/hooks/useWhatsAppCatalog";
import { useSocialAccounts } from "@/hooks/useSocialAccounts";
import { visibleToAccount } from "@/lib/knowledgeVisibility";
import {
  accountLabel,
  agentAccounts,
  effectiveAccountIds,
  nextSharing,
  type SharingAccount,
} from "@/lib/knowledgeSharing";
import {
  AI_KNOWLEDGE_BUCKET,
  aiKnowledgeContentType,
  aiKnowledgeObjectPath,
  aiKnowledgeStorageRef,
  getKnowledgeSourceType,
} from "@/lib/aiKnowledge";
import { supabase } from "@/integrations/supabase/client";
import { renderBusinessProfileText, type BusinessProfile } from "@/lib/agentProfile";
import { KnowledgeSourcesPanel } from "@/components/messaging/knowledge/KnowledgeSourcesPanel";
import { KnowledgeGraphCard } from "@/components/messaging/knowledge/KnowledgeGraphCard";
import { ManualProfilePanel } from "@/components/messaging/knowledge/ManualProfilePanel";
import { UploadPanel } from "@/components/messaging/knowledge/UploadPanel";
import { WebsitePanel } from "@/components/messaging/knowledge/WebsitePanel";
import { WebsiteSetupDrafts } from "@/components/messaging/knowledge/WebsiteSetupDrafts";
import { mergeProfileRefresh, websiteIndexingMessage } from "@/lib/websiteSetup";

/** How knowledge gets in. Alternatives, so they are tabs. */
type KnowledgeMethod = "manual" | "upload" | "website";

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
  // `error` and `isSuccess`, not just `data`. A failed read leaves data
  // undefined, and the `= []` default would then be indistinguishable from "this
  // user has no connected accounts" -- which would silently remove the sharing
  // strip and make every restricted source claim it reaches 0 accounts.
  const {
    data: socialAccounts = [],
    isSuccess: accountsReady,
    error: accountsError,
  } = useSocialAccounts();
  const isWhatsApp = platform === "whatsapp";
  const catalogHook = useWhatsAppCatalog();
  const waAccount = isWhatsApp ? catalogHook.waAccount : null;
  const catalog = isWhatsApp ? catalogHook.catalog : null;
  const [profile, setProfile] = useState<BusinessProfile>({});
  const profileRef = useRef(profile);
  profileRef.current = profile;
  const loadedProfile = useRef<{ scope: string; profile: BusinessProfile } | null>(null);
  const profileScope = `${platform}:${accountId ?? ""}`;
  const [uploading, setUploading] = useState(false);
  // Where a NEW upload lands. Defaults to the selected account, because a file
  // added while looking at one page is almost always that page's -- and until
  // this existed every upload was hardcoded shared, so a WhatsApp price list
  // answered Instagram customers too. "All accounts" stays one click away.
  const [uploadScope, setUploadScope] = useState<"account" | "all">("account");
  const [method, setMethod] = useState<KnowledgeMethod>("manual");
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
  const storedText = config?.business_profile_text || "";
  // Keyed on the SERIALISED structure, not the object: the config query hands
  // back a fresh object identity on every render, and depending on that would
  // reset the editor under the user's cursor on each one.
  const storedProfileKey = JSON.stringify(config?.business_profile ?? {});
  useEffect(() => {
    const structure = JSON.parse(storedProfileKey) as BusinessProfile;
    // The two can disagree during the rollout window: the migration backfilled
    // the structure once, and any text-only save between then and this build
    // reaching the browser updated only the text. The TEXT is what the agent has
    // been answering from, so it wins -- initialising from stale JSON would let
    // the next Save & index overwrite a profile the user edited more recently.
    // An EMPTY stored text counts as divergence too. Excluding it meant that a
    // legacy form clearing the profile after the backfill left a non-empty JSON
    // looked "consistent" -- so the stale structure was restored into the editor
    // and the next Save & index resurrected the profile the user had deleted.
    const diverged = renderBusinessProfileText(structure).trim() !== storedText.trim();
    // The text replaces the structure rather than merging into it. Divergence
    // means a writer that does not mirror touched the text, so the text is the
    // whole truth and the structure's other fields are stale by definition;
    // keeping them would re-save values the user no longer has.
    const nextProfile = diverged ? { notes: storedText } : structure;
    const previous = loadedProfile.current;
    // A draft application may finish after the user returns to Manual profile.
    // Refetching its saved config must not erase edits made during that request.
    setProfile(previous?.scope === profileScope
      ? mergeProfileRefresh(profileRef.current, previous.profile, nextProfile)
      : nextProfile);
    loadedProfile.current = { scope: profileScope, profile: nextProfile };
    // storedText participates deliberately: a text-only refresh must re-run this.
  }, [storedProfileKey, storedText, profileScope]);
  // An empty box over a stored value is the user having deleted it -- the same
  // asymmetry the settings form relies on, since the loaded config IS the
  // baseline here. Declared to the server rather than refused: refusing would
  // leave a business profile unclearable, because no other surface edits this
  // field, and would make the ingest delete branch unreachable.
  // The client's verdict has to match the server's exactly. renderBusinessProfileText
  // here is a verbatim port of the server module for that reason: if the client
  // under-reports "this renders to empty", it omits confirm_clear, the server
  // renders "" anyway and refuses with a 409 -- and the profile becomes
  // impossible to clear, however many times the user retries.
  const renderedText = renderBusinessProfileText(profile);
  const wouldBlankStoredProfile = renderedText.trim() === "" && storedText.trim() !== "";
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
    success: string | ((response: { queued?: boolean; chunk_count?: number }) => string),
  ) => {
    try {
      const response = await invoke.mutateAsync({ action, ...body });
      toast.success(typeof success === "function" ? success(response) : success);
      if (action === "ingest_website" && response.setup_error) {
        toast.warning("Website knowledge was accepted, but setup generation could not start. Use Generate setup from indexed website to retry after indexing finishes.");
      }
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
  // Which sources are mid-write, so only their own strips go disabled -- a
  // single `invoke.isPending` would freeze every row on the page.
  //
  // A SET, not one id (Codex P1). Toggling source B while A was still writing
  // overwrote A's id, re-enabling A's boxes mid-flight; a click there would then
  // compute its full replacement set from pre-refetch links and silently discard
  // the change A was in the middle of making. Every update below is functional,
  // because two toggles can land in the same render batch.
  const [sharingSourceIds, setSharingSourceIds] = useState<readonly string[]>([]);
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
    setSharingSourceIds((current) => [...current, source.id]);
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
    setSharingSourceIds((current) => current.filter((id) => id !== source.id));
  };
  const saveProfile = async () => {
    try {
      // The STRUCTURE is sent; the server renders business_profile_text from it.
      // Sending the text too would be a second, conflicting claim about the same
      // column.
      await upsertConfig.mutateAsync({
        business_profile: profile,
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
    // pointed at the export URL once it arrives. Calling window.open after the
    // await instead would be treated as an unsolicited popup and silently
    // blocked, so the button would appear to do nothing.
    //
    // The feature string must NOT contain `noopener`: with it, window.open
    // returns null by specification even though the tab opens. The handle was
    // therefore always null here, every click fell through to the same-tab
    // fallback that used to live below, and the tab that did open stayed blank
    // forever -- one blank tab plus the app navigated away, on every click.
    // `opener` is severed on the handle instead, which gives the same
    // protection while keeping the reference this needs.
    const tab = window.open("", "_blank");
    if (!tab) {
      toast.error("Allow pop-ups for this site to open the export.");
      return;
    }
    tab.opener = null;
    try {
      const urls = await resolveExportUrls.mutateAsync();
      const url = kind === "html" ? urls.html_url : urls.vault_url;
      if (!url) {
        tab.close();
        setUnresolvable((prev) => ({ ...prev, [kind]: true }));
        toast.error("Export link is unavailable — regenerate the exports.");
        return;
      }
      // replace, not assign: the blank entry never becomes a history step, so
      // the new tab's Back button is not a dead end.
      tab.location.replace(url);
    } catch (error) {
      tab.close();
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
      {/* How knowledge gets IN. The three methods are alternatives, so they are
          tabs -- but the sources panel below is not one of them: it is the
          answer to "did that work", and that answer is the same whichever
          method produced it. It therefore lives outside <Tabs> and stays
          mounted. */}
      <Tabs value={method} onValueChange={(value) => setMethod(value as KnowledgeMethod)}>
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="manual">
            <PencilLine className="mr-1.5 h-4 w-4" /> Manual profile
          </TabsTrigger>
          <TabsTrigger value="upload">
            <Upload className="mr-1.5 h-4 w-4" /> Upload files
          </TabsTrigger>
          <TabsTrigger value="website">
            <Globe className="mr-1.5 h-4 w-4" /> Website scraping
          </TabsTrigger>
        </TabsList>
        <TabsContent value="manual" className="mt-4">
          <ManualProfilePanel
            profile={profile}
            onProfileChange={setProfile}
            onSave={saveProfile}
            saveDisabled={!configLoaded || upsertConfig.isPending || invoke.isPending}
            saving={upsertConfig.isPending || invoke.isPending}
            showCatalog={isWhatsApp}
            catalog={catalog}
            hasCatalogAccount={!!waAccount}
            catalogBusy={invoke.isPending}
            onSyncCatalog={() =>
              run(
                "sync_catalog",
                { social_account_id: waAccount!.id, catalog_id: catalog!.catalog_id },
                "Catalog synced",
              )
            }
          />
        </TabsContent>
        <TabsContent value="upload" className="mt-4">
          <UploadPanel
            accountId={accountId ?? null}
            selectedAccountLabel={selectedAccountLabel}
            uploadScope={uploadScope}
            onUploadScopeChange={setUploadScope}
            uploading={uploading}
            onFileSelected={upload}
          />
        </TabsContent>
        <TabsContent value="website" className="mt-4">
          <WebsitePanel
            accountId={accountId ?? null}
            selectedAccountLabel={selectedAccountLabel}
            submitting={invoke.isPending}
            onSubmit={(input) =>
              run(
                "ingest_website",
                { ...input, platform, social_account_id: accountId ?? undefined },
                websiteIndexingMessage,
              )
            }
          />
          {accountId && <WebsiteSetupDrafts
            key={`${platform}:${accountId}`} platform={platform} accountId={accountId}
            sources={visibleSources} config={config} configError={error} profile={profile}
            profileDirty={configLoaded && renderedText.trim() !== storedText.trim()}
          />}
        </TabsContent>
      </Tabs>
      <KnowledgeSourcesPanel
        sources={visibleSources}
        allSourcesCount={sources.length}
        isLoading={isLoading}
        linksError={linksError}
        accountsError={accountsError}
        linksReady={linksReady}
        accountsReady={accountsReady}
        shareAccounts={shareAccounts}
        sharedBySource={sharedBySource}
        sharingSourceIds={sharingSourceIds}
        socialAccounts={socialAccounts}
        busy={invoke.isPending}
        onReingest={(source) =>
          run(
            source.source_type === "profile_text" ? "ingest_profile_text" : "ingest_source",
            source.source_type === "profile_text"
              ? { platform, social_account_id: accountId ?? undefined }
              : { source_id: source.id },
            "Source indexing started",
          )
        }
        onDelete={(source) => run("delete_source", { source_id: source.id }, "Source deleted")}
        onRename={(source, fileName) =>
          run("rename_source", { source_id: source.id, file_name: fileName }, "Source renamed")}
        onToggleShare={toggleShare}
      />
      <KnowledgeGraphCard
        graphExport={graphExport}
        busy={invoke.isPending}
        resolving={resolveExportUrls.isPending}
        unresolvable={unresolvable}
        onGenerate={async () => {
          await run("export_graph", {}, "Knowledge graph exports generated");
          setUnresolvable({ html: false, vault: false });
        }}
        onOpen={openExport}
      />
    </div>
  );
}
