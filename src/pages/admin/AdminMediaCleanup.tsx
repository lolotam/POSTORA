import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Loader2, Trash2, Search, AlertTriangle, CheckCircle2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface RetentionFile {
  id: string;
  action: string;
}

interface CleanupResult {
  warned: number;
  due: number;
  deleted: number;
  failed: number;
  backlog: number;
}

export default function AdminMediaCleanup() {
  const { t } = useTranslation("assets");
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [files, setFiles] = useState<RetentionFile[]>([]);
  const [cleanupResult, setCleanupResult] = useState<CleanupResult | null>(null);
  const [deleteEnabled, setDeleteEnabled] = useState<boolean | null>(null);
  const [dryRun, setDryRun] = useState(true);

  const applyResponse = (data: {
    result?: CleanupResult;
    filesToDelete?: RetentionFile[];
    deleteEnabled?: boolean;
  }) => {
    setCleanupResult(data.result ?? null);
    setFiles(Array.isArray(data.filesToDelete) ? data.filesToDelete : []);
    if (typeof data.deleteEnabled === "boolean") setDeleteEnabled(data.deleteEnabled);
  };

  const preview = async () => {
    setIsLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("cleanup-media", {
        body: { dryRun: true },
      });
      if (error) throw error;
      applyResponse(data ?? {});
      toast({
        title: t("retentionAdmin.previewDone", "Preview complete"),
        description: t("retentionAdmin.previewCount", "{{count}} files would be warned or are due.", {
          count: (data?.result?.warned ?? 0) + (data?.result?.due ?? 0),
        }),
      });
    } catch (error: unknown) {
      toast({
        title: t("retentionAdmin.previewFailed", "Preview failed"),
        description: error instanceof Error ? error.message : t("errors.unknownError", "An error occurred"),
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const runRetention = async () => {
    if (dryRun) {
      await preview();
      return;
    }
    setIsDeleting(true);
    try {
      const { data, error } = await supabase.functions.invoke("cleanup-media", {
        body: { dryRun: false },
      });
      if (error) throw error;
      applyResponse(data ?? {});
      toast({
        title: t("retentionAdmin.runDone", "Retention run complete"),
        description: data?.deleteEnabled
          ? t("retentionAdmin.deletedCount", "Deleted {{count}} files.", { count: data?.result?.deleted ?? 0 })
          : t("retentionAdmin.pausedRun", "Deletion is paused by the admin switch. Nothing was deleted."),
      });
    } catch (error: unknown) {
      toast({
        title: t("retentionAdmin.runFailed", "Retention run failed"),
        description: error instanceof Error ? error.message : t("errors.unknownError", "An error occurred"),
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">{t("retentionAdmin.title", "Media retention")}</h2>
          <p className="text-muted-foreground">
            {t("retentionAdmin.subtitle", "Warn and delete unused library files using each account's own retention setting.")}
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Search className="w-5 h-5" />
              {t("retentionAdmin.settingsTitle", "How retention works")}
            </CardTitle>
            <CardDescription>
              {t("retentionAdmin.settingsDescription", "Age is not chosen on this page.")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <p className="text-sm text-muted-foreground">
              {t(
                "retentionAdmin.perUser",
                "Each account chooses 7, 30 or 90 days, or Never, from Settings. A file is warned 7 days before it would be deleted. Files that are in use, or marked keep forever, are never deleted. This page cannot change another account's setting.",
              )}
            </p>

            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <Label htmlFor="dryRun" className="text-base">{t("retentionAdmin.dryRun", "Dry run")}</Label>
                <p className="text-sm text-muted-foreground">
                  {dryRun
                    ? t("retentionAdmin.dryRunOn", "Preview only. This request writes nothing.")
                    : t("retentionAdmin.dryRunOff", "A real run follows the server deletion switch.")}
                </p>
              </div>
              <Switch id="dryRun" checked={dryRun} onCheckedChange={setDryRun} />
            </div>

            {deleteEnabled !== null && (
              <p className="text-sm" data-testid="delete-switch-state">
                {deleteEnabled
                  ? t("retentionAdmin.switchOn", "Server deletion switch: on")
                  : t("retentionAdmin.switchOff", "Server deletion switch: paused")}
              </p>
            )}

            <div className="flex gap-3">
              <Button onClick={preview} disabled={isLoading || isDeleting} variant="outline">
                {isLoading ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <Search className="me-2 h-4 w-4" />}
                {t("retentionAdmin.preview", "Preview")}
              </Button>
              <Button onClick={runRetention} disabled={isLoading || isDeleting || dryRun} variant="destructive">
                {isDeleting ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <Trash2 className="me-2 h-4 w-4" />}
                {t("retentionAdmin.run", "Run retention")}
              </Button>
            </div>
          </CardContent>
        </Card>

        {cleanupResult && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {cleanupResult.failed > 0 ? (
                  <AlertTriangle className="w-5 h-5 text-yellow-500" />
                ) : (
                  <CheckCircle2 className="w-5 h-5 text-green-500" />
                )}
                {t("retentionAdmin.results", "Retention results")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-5">
                <Count label={t("retentionAdmin.warned", "Warned")} value={cleanupResult.warned} />
                <Count label={t("retentionAdmin.due", "Due")} value={cleanupResult.due} />
                <Count label={t("retentionAdmin.deleted", "Deleted")} value={cleanupResult.deleted} />
                <Count label={t("retentionAdmin.failed", "Failed")} value={cleanupResult.failed} />
                <Count label={t("retentionAdmin.backlog", "Backlog")} value={cleanupResult.backlog} />
              </div>
            </CardContent>
          </Card>
        )}

        {files.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {t("retentionAdmin.previewList", "Preview")}
                <Badge variant="secondary">{files.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {files.map((file) => (
                  <li key={`${file.action}-${file.id}`} className="flex items-center justify-between gap-3 text-sm">
                    <span className="font-mono truncate">{file.id}</span>
                    <Badge variant="secondary">{file.action}</Badge>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t("retentionAdmin.noteTitle", "Deletion switch")}</AlertTitle>
          <AlertDescription>
            {t(
              "retentionAdmin.noteBody",
              "While the server switch is paused, a real run only clears and warns. It does not delete files.",
            )}
          </AlertDescription>
        </Alert>
      </div>
    </AdminLayout>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-center p-4 rounded-lg bg-muted">
      <div className="text-3xl font-bold">{value}</div>
      <div className="text-sm text-muted-foreground">{label}</div>
    </div>
  );
}
