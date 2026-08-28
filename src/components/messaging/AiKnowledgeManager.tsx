/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from "react";
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
import {
  useAiAgentConfig,
  type AiAgentPlatform,
} from "@/hooks/useAiAgentConfig";
import { useAiKnowledge } from "@/hooks/useAiKnowledge";
import { useWhatsAppCatalog } from "@/hooks/useWhatsAppCatalog";
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
}: {
  platform: AiAgentPlatform;
}) {
  const { config, upsertConfig } = useAiAgentConfig(platform);
  const { user, sources, isLoading, graphExport, invoke, resolveExportUrls } = useAiKnowledge();
  const isWhatsApp = platform === "whatsapp";
  const catalogHook = useWhatsAppCatalog();
  const waAccount = isWhatsApp ? catalogHook.waAccount : null;
  const catalog = isWhatsApp ? catalogHook.catalog : null;
  const [profile, setProfile] = useState("");
  const [uploading, setUploading] = useState(false);
  // Set when a stored export link cannot be resolved (e.g. the object is gone
  // or the row predates signed URLs) — the button degrades to disabled until
  // exports are regenerated, never to a broken link.
  const [unresolvable, setUnresolvable] = useState({ html: false, vault: false });
  const profileText = config?.business_profile_text || "";
  useEffect(() => setProfile(profileText), [profileText]);
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
  const saveProfile = async () => {
    try {
      await upsertConfig.mutateAsync({ business_profile_text: profile });
      await run(
        "ingest_profile_text",
        { platform },
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
          p_social_account_ids: [],
          p_visibility: "shared",
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
            disabled={upsertConfig.isPending || invoke.isPending}
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
        <CardContent>
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
          ) : sources.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No knowledge sources yet.
            </p>
          ) : (
            sources.map((source) => (
              <div
                key={source.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
              >
                <div>
                  <p className="font-medium">{source.file_name}</p>
                  <div className="mt-1 flex gap-2">
                    <Badge variant="secondary">{source.source_type}</Badge>
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
                          ? { platform }
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
