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
  getKnowledgeSourceType,
} from "@/lib/aiKnowledge";
import { supabase } from "@/integrations/supabase/client";

export function AiKnowledgeManager({
  platform,
}: {
  platform: AiAgentPlatform;
}) {
  const { config, upsertConfig } = useAiAgentConfig(platform);
  const { user, sources, isLoading, graphExport, invoke } = useAiKnowledge();
  const isWhatsApp = platform === "whatsapp";
  const catalogHook = useWhatsAppCatalog();
  const waAccount = isWhatsApp ? catalogHook.waAccount : null;
  const catalog = isWhatsApp ? catalogHook.catalog : null;
  const [profile, setProfile] = useState("");
  const [uploading, setUploading] = useState(false);
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
  const upload = async (file?: File) => {
    if (!file || !user) return;
    const type = getKnowledgeSourceType(file.name);
    if (!type) {
      toast.error("Supported files: CSV, XLSX, XLS, PDF, TXT, MD, PNG, JPG, WEBP.");
      return;
    }
    setUploading(true);
    try {
      // Knowledge files go to Cloudinary under the user's folder
      // (media/{user}/ai-knowledge/) as raw assets; ai-knowledge-ingest
      // downloads them back from the CDN URL stored in file_path.
      const fileData = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error("Failed to read file"));
        reader.readAsDataURL(file);
      });
      const { data: uploadData, error: uploadError } = await supabase.functions.invoke(
        "cloudinary-upload",
        {
          body: {
            fileData,
            fileName: file.name,
            fileType: "raw",
            subfolder: "ai-knowledge",
            skipMediaFiles: true,
          },
        },
      );
      if (uploadError || !uploadData?.success) {
        throw new Error(uploadData?.error || uploadError?.message || "Upload failed");
      }
      const { data: source, error } = await (supabase as any)
        .from("ai_knowledge_sources")
        .insert({
          user_id: user.id,
          source_type: type,
          file_name: file.name,
          file_path: uploadData.url,
          status: "pending",
        })
        .select()
        .single();
      if (error) throw error;
      await run(
        "ingest_source",
        { source_id: source.id },
        "Knowledge file indexed",
      );
    } catch (error) {
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
            onClick={() => run("export_graph", {}, "Knowledge graph exports generated")}
          >
            {invoke.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Generate exports
          </Button>
          {graphExport?.html_url && (
            <Button variant="secondary" asChild>
              <a href={graphExport.html_url} target="_blank" rel="noreferrer">
                <ExternalLink className="mr-2 h-4 w-4" />
                Open graph
              </a>
            </Button>
          )}
          {graphExport?.vault_url && (
            <Button variant="secondary" asChild>
              <a href={graphExport.vault_url} target="_blank" rel="noreferrer">
                <FileArchive className="mr-2 h-4 w-4" />
                Download vault
              </a>
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
