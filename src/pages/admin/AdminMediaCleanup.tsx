import { useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Loader2, Trash2, Search, AlertTriangle, CheckCircle2, Image, Video, FileWarning, RefreshCw, Columns } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { format } from "date-fns";

interface OrphanedFile {
  id: string;
  publicId: string;
  path: string;
  createdAt: string;
  fileType?: string;
  storageBucket?: string;
  thumbnailUrl?: string;
}

interface CleanupResult {
  totalOrphaned: number;
  deleted: number;
  failed: number;
  errors: string[];
  deletedFiles: string[];
}

export default function AdminMediaCleanup() {
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [orphanedFiles, setOrphanedFiles] = useState<OrphanedFile[]>([]);
  const [cleanupResult, setCleanupResult] = useState<CleanupResult | null>(null);
  const [dryRun, setDryRun] = useState(true);
  const [maxFiles, setMaxFiles] = useState(100);
  const [olderThanDays, setOlderThanDays] = useState(7);
  const [hasScanned, setHasScanned] = useState(false);
  const [columnsPerRow, setColumnsPerRow] = useState(() => {
    const saved = localStorage.getItem("adminMediaCleanupColumnsPerRow");
    return saved ? parseInt(saved, 10) : 5;
  });

  const scanForOrphanedFiles = async () => {
    setIsLoading(true);
    setCleanupResult(null);
    
    try {
      const { data, error } = await supabase.functions.invoke("cleanup-media", {
        body: {
          dryRun: true,
          maxFiles,
          olderThanDays,
        },
      });

      if (error) throw error;

      if (data.filesToDelete) {
        setOrphanedFiles(data.filesToDelete);
      }
      
      setCleanupResult(data.result);
      setHasScanned(true);

      toast({
        title: "Scan Complete",
        description: `Found ${data.result?.totalOrphaned || 0} orphaned files`,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to scan";
      toast({
        title: "Scan Failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const runCleanup = async () => {
    if (dryRun) {
      await scanForOrphanedFiles();
      return;
    }

    setIsDeleting(true);
    setCleanupResult(null);

    try {
      const { data, error } = await supabase.functions.invoke("cleanup-media", {
        body: {
          dryRun: false,
          maxFiles,
          olderThanDays,
        },
      });

      if (error) throw error;

      setCleanupResult(data.result);
      setOrphanedFiles([]);
      setHasScanned(false);

      toast({
        title: "Cleanup Complete",
        description: `Deleted ${data.result?.deleted || 0} orphaned files`,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to cleanup";
      toast({
        title: "Cleanup Failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Media Cleanup</h2>
          <p className="text-muted-foreground">
            Find and delete orphaned media files from Cloudinary to reduce storage costs
          </p>
        </div>

        {/* Settings Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Search className="w-5 h-5" />
              Scan Settings
            </CardTitle>
            <CardDescription>
              Configure how to find orphaned files
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="olderThanDays">Files older than (days)</Label>
                <Input
                  id="olderThanDays"
                  type="number"
                  min={1}
                  max={365}
                  value={olderThanDays}
                  onChange={(e) => setOlderThanDays(Number(e.target.value))}
                />
                <p className="text-xs text-muted-foreground">
                  Only scan files created more than X days ago
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="maxFiles">Max files per run</Label>
                <Input
                  id="maxFiles"
                  type="number"
                  min={1}
                  max={500}
                  value={maxFiles}
                  onChange={(e) => setMaxFiles(Number(e.target.value))}
                />
                <p className="text-xs text-muted-foreground">
                  Limit to prevent timeouts (max 500)
                </p>
              </div>
            </div>

            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <Label htmlFor="dryRun" className="text-base">Dry Run Mode</Label>
                <p className="text-sm text-muted-foreground">
                  {dryRun 
                    ? "Preview only - no files will be deleted" 
                    : "⚠️ Files will be permanently deleted!"}
                </p>
              </div>
              <Switch
                id="dryRun"
                checked={dryRun}
                onCheckedChange={setDryRun}
              />
            </div>

            <div className="flex gap-3">
              <Button 
                onClick={scanForOrphanedFiles} 
                disabled={isLoading || isDeleting}
                variant="outline"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="me-2 h-4 w-4 animate-spin" />
                    Scanning...
                  </>
                ) : (
                  <>
                    <Search className="me-2 h-4 w-4" />
                    Scan for Orphaned Files
                  </>
                )}
              </Button>

              {hasScanned && orphanedFiles.length > 0 && (
                <Button 
                  onClick={runCleanup} 
                  disabled={isLoading || isDeleting || dryRun}
                  variant={dryRun ? "secondary" : "destructive"}
                >
                  {isDeleting ? (
                    <>
                      <Loader2 className="me-2 h-4 w-4 animate-spin" />
                      Deleting...
                    </>
                  ) : (
                    <>
                      <Trash2 className="me-2 h-4 w-4" />
                      Delete {orphanedFiles.length} Files
                    </>
                  )}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Results */}
        {cleanupResult && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {cleanupResult.failed > 0 ? (
                  <AlertTriangle className="w-5 h-5 text-yellow-500" />
                ) : (
                  <CheckCircle2 className="w-5 h-5 text-green-500" />
                )}
                Cleanup Results
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="text-center p-4 rounded-lg bg-muted">
                  <div className="text-3xl font-bold">{cleanupResult.totalOrphaned}</div>
                  <div className="text-sm text-muted-foreground">Total Orphaned</div>
                </div>
                <div className="text-center p-4 rounded-lg bg-green-500/10">
                  <div className="text-3xl font-bold text-green-600">{cleanupResult.deleted}</div>
                  <div className="text-sm text-muted-foreground">Deleted</div>
                </div>
                <div className="text-center p-4 rounded-lg bg-red-500/10">
                  <div className="text-3xl font-bold text-red-600">{cleanupResult.failed}</div>
                  <div className="text-sm text-muted-foreground">Failed</div>
                </div>
              </div>

              {cleanupResult.errors.length > 0 && (
                <Alert variant="destructive" className="mt-4">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>Errors</AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc ps-4 mt-2 space-y-1">
                      {cleanupResult.errors.slice(0, 5).map((error, i) => (
                        <li key={i} className="text-sm">{error}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        )}

        {/* Orphaned Files Grid */}
        {orphanedFiles.length > 0 && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="space-y-1">
                  <CardTitle className="flex items-center gap-2">
                    <FileWarning className="w-5 h-5 text-yellow-500" />
                    Orphaned Files Preview
                    <Badge variant="secondary">{orphanedFiles.length}</Badge>
                  </CardTitle>
                  <CardDescription>
                    These files are not referenced by any posts and can be safely deleted
                  </CardDescription>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="gap-2">
                      <Columns className="w-4 h-4" />
                      {columnsPerRow} per row
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {[3, 4, 5, 6, 7, 8, 10].map((cols) => (
                      <DropdownMenuItem
                        key={cols}
                        className={cn(columnsPerRow === cols && "bg-secondary")}
                        onClick={() => {
                          setColumnsPerRow(cols);
                          localStorage.setItem("adminMediaCleanupColumnsPerRow", cols.toString());
                        }}
                      >
                        {cols} per row
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[500px]">
                <div
                  className="grid gap-3"
                  style={{ gridTemplateColumns: `repeat(${columnsPerRow}, minmax(0, 1fr))` }}
                >
                  {orphanedFiles.map((file) => {
                    const isVideo = file.fileType === "video" || file.path.match(/\.(mp4|mov|avi|webm)$/i);
                    const thumb = file.thumbnailUrl;
                    return (
                      <div
                        key={file.id}
                        className="group relative rounded-xl overflow-hidden border border-border bg-muted"
                      >
                        <div className="relative aspect-square">
                          {thumb ? (
                            isVideo ? (
                              <video
                                src={thumb}
                                className="w-full h-full object-cover"
                                muted
                                playsInline
                              />
                            ) : (
                              <img
                                src={thumb}
                                alt={file.publicId || file.path}
                                className="w-full h-full object-cover"
                                loading="lazy"
                                onError={(e) => {
                                  const target = e.currentTarget;
                                  target.style.display = "none";
                                  const fallback = target.parentElement?.querySelector("[data-fallback]");
                                  if (fallback) (fallback as HTMLElement).style.display = "flex";
                                }}
                              />
                            )
                          ) : null}
                          <div
                            data-fallback
                            className="absolute inset-0 hidden items-center justify-center bg-muted text-muted-foreground"
                          >
                            {isVideo ? <Video className="w-8 h-8" /> : <Image className="w-8 h-8" />}
                          </div>
                          <div className="absolute bottom-1 start-1 flex gap-0.5">
                            <Badge variant="secondary" className="text-[10px] px-1 py-0 opacity-90">
                              {isVideo ? "Video" : "Image"}
                            </Badge>
                          </div>
                        </div>
                        <div className="p-2 space-y-1">
                          <div className="font-mono text-[10px] truncate text-foreground" title={file.publicId || file.path}>
                            {file.publicId || file.path}
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            {file.createdAt ? format(new Date(file.createdAt), "MMM d, yyyy") : "-"}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        )}

        {/* Empty State */}
        {hasScanned && orphanedFiles.length === 0 && (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <CheckCircle2 className="w-12 h-12 text-green-500 mb-4" />
              <h3 className="text-lg font-semibold">No Orphaned Files Found</h3>
              <p className="text-muted-foreground text-center mt-2">
                All media files are currently in use or newer than {olderThanDays} days.
              </p>
              <Button 
                variant="outline" 
                className="mt-4"
                onClick={() => {
                  setOlderThanDays(1);
                  scanForOrphanedFiles();
                }}
              >
                <RefreshCw className="me-2 h-4 w-4" />
                Scan All Ages
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Info Card */}
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>How it works</AlertTitle>
          <AlertDescription className="mt-2 space-y-2">
            <p>1. <strong>Scan</strong> finds media files not used by any post</p>
            <p>2. <strong>Dry Run</strong> previews what would be deleted</p>
            <p>3. <strong>Delete</strong> removes files from Cloudinary and database</p>
            <p className="text-muted-foreground text-sm mt-2">
              Tip: Set up a weekly cron job to automate cleanup
            </p>
          </AlertDescription>
        </Alert>
      </div>
    </AdminLayout>
  );
}
