// ═══════════════════════════════════════════════════════════════════════════
// TikTok Processing Status Component
// Real-time status display during post processing (Section 5d & 5e compliance)
// ═══════════════════════════════════════════════════════════════════════════

import { motion, AnimatePresence } from "framer-motion";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Upload,
  Video,
  Inbox,
  ExternalLink,
  AlertCircle,
} from "lucide-react";
import type { TikTokPublishStatus } from "@/hooks/useTikTokStatusPolling";

interface TikTokProcessingStatusProps {
  status: TikTokPublishStatus;
  progress: number;
  elapsedTime: number;
  postUrl: string | null;
  failReason: string | null;
  onDismiss?: () => void;
  className?: string;
}

export function TikTokProcessingStatus({
  status,
  progress,
  elapsedTime,
  postUrl,
  failReason,
  onDismiss,
  className,
}: TikTokProcessingStatusProps) {
  const { t } = useTranslation("postpreview");

  const formatTime = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return t("tikTokProcessing.seconds", { count: seconds, defaultValue: `${seconds}s` });
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return t("tikTokProcessing.minutesSeconds", { minutes, seconds: remainingSeconds, defaultValue: `${minutes}m ${remainingSeconds}s` });
  };

  const getStatusInfo = () => {
    switch (status) {
      case "pending":
        return {
          icon: Clock,
          label: t("tikTokProcessing.preparingUpload", "Preparing upload..."),
          color: "text-muted-foreground",
          bgColor: "bg-muted/30",
        };
      case "PROCESSING_UPLOAD":
        return {
          icon: Upload,
          label: t("tikTokProcessing.uploadingToTikTok", "Uploading to TikTok..."),
          color: "text-blue-500",
          bgColor: "bg-blue-500/10",
        };
      case "PROCESSING_DOWNLOAD":
        return {
          icon: Video,
          label: t("tikTokProcessing.processingVideo", "Processing video..."),
          color: "text-primary",
          bgColor: "bg-primary/10",
        };
      case "SEND_TO_USER_INBOX":
        return {
          icon: Inbox,
          label: t("tikTokProcessing.sentToInbox", "Sent to your TikTok inbox"),
          color: "text-amber-500",
          bgColor: "bg-amber-500/10",
        };
      case "PUBLISH_COMPLETE":
        return {
          icon: CheckCircle2,
          label: t("tikTokProcessing.publishedSuccess", "Published successfully!"),
          color: "text-green-500",
          bgColor: "bg-green-500/10",
        };
      case "FAILED":
        return {
          icon: XCircle,
          label: t("tikTokProcessing.publishingFailed", "Publishing failed"),
          color: "text-destructive",
          bgColor: "bg-destructive/10",
        };
      default:
        return {
          icon: Loader2,
          label: t("tikTokProcessing.processingVideo", "Processing..."),
          color: "text-muted-foreground",
          bgColor: "bg-muted/30",
        };
    }
  };

  const statusInfo = getStatusInfo();
  const StatusIcon = statusInfo.icon;
  const isComplete = status === "PUBLISH_COMPLETE";
  const isFailed = status === "FAILED";
  const isInbox = status === "SEND_TO_USER_INBOX";
  const isProcessing = !isComplete && !isFailed && !isInbox;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className={cn(
        "rounded-lg border p-4 space-y-3",
        statusInfo.bgColor,
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={cn(
            "w-10 h-10 rounded-full flex items-center justify-center",
            "bg-[#00f2ea]"
          )}>
            <span className="text-white text-xs font-bold">TT</span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <StatusIcon className={cn(
                "w-4 h-4",
                statusInfo.color,
                isProcessing && (status as string) !== "SEND_TO_USER_INBOX" && "animate-spin"
              )} />
              <span className={cn("font-medium", statusInfo.color)}>
                {statusInfo.label}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("tikTokProcessing.elapsed", { time: formatTime(elapsedTime), defaultValue: `Elapsed: ${formatTime(elapsedTime)}` })}
            </p>
          </div>
        </div>

        {(isComplete || isFailed || isInbox) && onDismiss && (
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            {t("tikTokProcessing.dismiss", "Dismiss")}
          </Button>
        )}
      </div>

      {/* Progress Bar */}
      <AnimatePresence>
        {isProcessing && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="space-y-1"
          >
            <Progress value={progress} className="h-2" />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{t("tikTokProcessing.processingVideo", "Processing...")}</span>
              <span>{Math.round(progress)}%</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Processing Steps */}
      <AnimatePresence>
        {isProcessing && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="space-y-2"
          >
            <ProcessingStep
              label={t("tikTokProcessing.stepUploadFile", "Upload file")}
              completed={["PROCESSING_DOWNLOAD", "SEND_TO_USER_INBOX", "PUBLISH_COMPLETE"].includes(status as string)}
              active={status === "PROCESSING_UPLOAD"}
            />
            <ProcessingStep
              label={t("tikTokProcessing.stepProcessVideo", "Process video")}
              completed={["SEND_TO_USER_INBOX", "PUBLISH_COMPLETE"].includes(status as string)}
              active={status === "PROCESSING_DOWNLOAD"}
            />
            <ProcessingStep
              label={t("tikTokProcessing.stepReviewPublish", "Review & Publish")}
              completed={(status as string) === "PUBLISH_COMPLETE"}
              active={(status as string) === "SEND_TO_USER_INBOX"}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Success Message */}
      <AnimatePresence>
        {isComplete && postUrl && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="p-3 bg-green-500/10 border border-green-500/30 rounded-lg"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-green-500" />
                <span className="text-sm font-medium text-green-700 dark:text-green-300">
                  {t("tikTokProcessing.postLive", "Your post is live on TikTok!")}
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                asChild
                className="border-green-500/30 hover:bg-green-500/10"
              >
                <a href={postUrl} target="_blank" rel="noopener noreferrer">
                  {t("tikTokProcessing.viewPost", "View Post")}
                  <ExternalLink className="w-3 h-3 ms-1" />
                </a>
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Inbox Message */}
      <AnimatePresence>
        {isInbox && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg"
          >
            <div className="flex items-start gap-2">
              <Inbox className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
                  {t("tikTokProcessing.inboxTitle", "Check your TikTok inbox")}
                </p>
                <p className="text-xs text-amber-600/80 dark:text-amber-400/80 mt-1">
                  {t("tikTokProcessing.inboxDescription", "Open the TikTok app to review and complete the post. This may take a few minutes to appear.")}
                </p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Error Message */}
      <AnimatePresence>
        {isFailed && failReason && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="p-3 bg-destructive/10 border border-destructive/30 rounded-lg"
          >
            <div className="flex items-start gap-2">
              <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-destructive">
                  {t("tikTokProcessing.publishingFailed", "Publishing failed")}
                </p>
                <p className="text-xs text-destructive/80 mt-1">
                  {failReason}
                </p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Processing Time Notice */}
      {isProcessing && (
        <p className="text-xs text-muted-foreground text-center">
          {t("tikTokProcessing.closeNotice", "You can close this panel. We'll notify you when it's done.")}
        </p>
      )}
    </motion.div>
  );
}

// Helper component for processing steps
function ProcessingStep({ 
  label, 
  completed, 
  active 
}: { 
  label: string; 
  completed: boolean; 
  active: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      {completed ? (
        <CheckCircle2 className="w-4 h-4 text-green-500" />
      ) : active ? (
        <Loader2 className="w-4 h-4 text-primary animate-spin" />
      ) : (
        <div className="w-4 h-4 rounded-full border-2 border-muted-foreground/30" />
      )}
      <span className={cn(
        "text-sm",
        completed ? "text-green-600" : active ? "text-foreground font-medium" : "text-muted-foreground"
      )}>
        {label}
      </span>
    </div>
  );
}
