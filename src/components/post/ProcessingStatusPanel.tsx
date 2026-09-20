import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { 
  Loader2, 
  CheckCircle2, 
  XCircle, 
  RefreshCw, 
  Clock,
  Crop,
  FileDown,
  X
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

export type ProcessingStatus = "queued" | "processing" | "done" | "error";
export type OperationType = "crop" | "compress";

export interface ProcessingJob {
  id: string;
  fileId: string;
  fileName: string;
  operation: OperationType;
  status: ProcessingStatus;
  progress: number;
  error?: string;
  startedAt: Date;
  completedAt?: Date;
  // Context for retry functionality
  retryContext?: {
    mediaSrc?: string;
    mediaType?: "image" | "video" | "gif";
    targetRatio?: string;
    mediaFileId?: string;
    file?: File;
  };
}

interface ProcessingStatusPanelProps {
  jobs: ProcessingJob[];
  onRetry: (jobId: string) => void;
  onDismiss: (jobId: string) => void;
  onClear: () => void;
  className?: string;
}

export function ProcessingStatusPanel({
  jobs,
  onRetry,
  onDismiss,
  onClear,
  className,
}: ProcessingStatusPanelProps) {
  const { t } = useTranslation(["postpreview", "common"]);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);

  // Auto-expand first error job
  useEffect(() => {
    const errorJob = jobs.find(j => j.status === "error");
    if (errorJob && !expandedJobId) {
      setExpandedJobId(errorJob.id);
    }
  }, [jobs, expandedJobId]);

  if (jobs.length === 0) return null;

  const completedCount = jobs.filter(j => j.status === "done").length;
  const errorCount = jobs.filter(j => j.status === "error").length;
  const processingCount = jobs.filter(j => j.status === "processing" || j.status === "queued").length;

  const getStatusIcon = (status: ProcessingStatus) => {
    switch (status) {
      case "queued":
        return <Clock className="w-4 h-4 text-muted-foreground" />;
      case "processing":
        return <Loader2 className="w-4 h-4 text-primary animate-spin" />;
      case "done":
        return <CheckCircle2 className="w-4 h-4 text-green-500" />;
      case "error":
        return <XCircle className="w-4 h-4 text-destructive" />;
    }
  };

  const getOperationIcon = (operation: OperationType) => {
    switch (operation) {
      case "crop":
        return <Crop className="w-3.5 h-3.5" />;
      case "compress":
        return <FileDown className="w-3.5 h-3.5" />;
    }
  };

  const getStatusLabel = (status: ProcessingStatus) => {
    switch (status) {
      case "queued":
        return t("postpreview:processingPanel.statusQueued", "Queued");
      case "processing":
        return t("common:status.processing", "Processing");
      case "done":
        return t("common:status.completed", "Complete");
      case "error":
        return t("common:status.failed", "Failed");
    }
  };

  const getElapsedTime = (startedAt: Date, completedAt?: Date) => {
    const end = completedAt || new Date();
    const elapsed = Math.round((end.getTime() - startedAt.getTime()) / 1000);
    if (elapsed < 60) return `${elapsed}s`;
    return `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
  };

  return (
    <Card className={cn("border-border/50", className)}>
      <CardContent className="p-3 space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{t("postpreview:processingPanel.title", "Processing")}</span>
            <div className="flex gap-1">
              {processingCount > 0 && (
                <Badge variant="secondary" className="text-xs h-5">
                  {t("postpreview:processingPanel.activeCount", { count: processingCount, defaultValue: `${processingCount} active` })}
                </Badge>
              )}
              {completedCount > 0 && (
                <Badge variant="outline" className="text-xs h-5 text-green-600 border-green-200">
                  {t("postpreview:processingPanel.doneCount", { count: completedCount, defaultValue: `${completedCount} done` })}
                </Badge>
              )}
              {errorCount > 0 && (
                <Badge variant="destructive" className="text-xs h-5">
                  {t("postpreview:processingPanel.failedCount", { count: errorCount, defaultValue: `${errorCount} failed` })}
                </Badge>
              )}
            </div>
          </div>
          {jobs.every(j => j.status === "done" || j.status === "error") && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onClear}
              className="h-6 text-xs"
            >
              {t("postpreview:processingPanel.clearAll", "Clear all")}
            </Button>
          )}
        </div>

        {/* Job List */}
        <div className="space-y-2">
          {jobs.map((job) => (
            <div
              key={job.id}
              className={cn(
                "rounded-lg border p-2.5 transition-colors",
                job.status === "error" && "border-destructive/50 bg-destructive/5",
                job.status === "done" && "border-green-500/30 bg-green-500/5",
                (job.status === "queued" || job.status === "processing") && "border-primary/30 bg-primary/5"
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  {getStatusIcon(job.status)}
                  <div className="flex items-center gap-1.5">
                    {getOperationIcon(job.operation)}
                    <span className="text-sm font-medium truncate max-w-[120px]">
                      {job.fileName}
                    </span>
                  </div>
                </div>
                
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {getElapsedTime(job.startedAt, job.completedAt)}
                  </span>
                  
                  {job.status === "error" && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => onRetry(job.id)}
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                    </Button>
                  )}
                  
                  {(job.status === "done" || job.status === "error") && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => onDismiss(job.id)}
                    >
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>
              </div>

              {/* Progress bar for processing/queued */}
              {(job.status === "processing" || job.status === "queued") && (
                <div className="mt-2">
                  <Progress value={job.progress} className="h-1.5" />
                  <div className="flex justify-between mt-1">
                    <span className="text-xs text-muted-foreground">
                      {getStatusLabel(job.status)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {job.progress}%
                    </span>
                  </div>
                </div>
              )}

              {/* Error message */}
              {job.status === "error" && job.error && (
                <div className="mt-2 text-xs text-destructive bg-destructive/10 rounded p-2">
                  {job.error}
                </div>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// Hook to manage processing jobs
export function useProcessingJobs() {
  const [jobs, setJobs] = useState<ProcessingJob[]>([]);

  const addJob = (job: Omit<ProcessingJob, "startedAt">) => {
    setJobs(prev => [...prev, { ...job, startedAt: new Date() }]);
  };

  const updateJob = (jobId: string, updates: Partial<ProcessingJob>) => {
    setJobs(prev =>
      prev.map(job =>
        job.id === jobId
          ? { ...job, ...updates, completedAt: updates.status === "done" || updates.status === "error" ? new Date() : job.completedAt }
          : job
      )
    );
  };

  const removeJob = (jobId: string) => {
    setJobs(prev => prev.filter(job => job.id !== jobId));
  };

  const clearCompleted = () => {
    setJobs(prev => prev.filter(job => job.status !== "done" && job.status !== "error"));
  };

  const retryJob = (jobId: string) => {
    setJobs(prev =>
      prev.map(job =>
        job.id === jobId
          ? { ...job, status: "queued" as ProcessingStatus, progress: 0, error: undefined, startedAt: new Date(), completedAt: undefined }
          : job
      )
    );
  };

  return {
    jobs,
    addJob,
    updateJob,
    removeJob,
    clearCompleted,
    retryJob,
  };
}
