// ═══════════════════════════════════════════════════════════════════════════
// TikTok Status Polling Hook
// Polls TikTok's publish status API for real-time updates (Section 5e compliance)
// ═══════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

export type TikTokPublishStatus = 
  | "PUBLISH_COMPLETE"
  | "PROCESSING_UPLOAD"
  | "PROCESSING_DOWNLOAD"
  | "SEND_TO_USER_INBOX"
  | "FAILED"
  | "pending"
  | "unknown";

export interface TikTokStatusInfo {
  status: TikTokPublishStatus;
  postId: string | null;
  postUrl: string | null;
  failReason: string | null;
  progress: number;
  elapsedTime: number;
}

interface UseTikTokStatusPollingOptions {
  publishId: string | null;
  accountId: string | null;
  platformPostId?: string | null;
  onComplete?: (postId: string, postUrl: string) => void;
  onFailed?: (reason: string) => void;
  pollingInterval?: number;
  maxPollingTime?: number;
}

export function useTikTokStatusPolling({
  publishId,
  accountId,
  platformPostId,
  onComplete,
  onFailed,
  pollingInterval = 5000,
  maxPollingTime = 300000, // 5 minutes max
}: UseTikTokStatusPollingOptions) {
  const [statusInfo, setStatusInfo] = useState<TikTokStatusInfo>({
    status: "pending",
    postId: null,
    postUrl: null,
    failReason: null,
    progress: 0,
    elapsedTime: 0,
  });
  const [isPolling, setIsPolling] = useState(false);
  
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const { toast } = useToast();

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setIsPolling(false);
  }, []);

  const translateStatus = useCallback((status: TikTokPublishStatus): string => {
    switch (status) {
      case "PROCESSING_UPLOAD":
        return "Uploading to TikTok...";
      case "PROCESSING_DOWNLOAD":
        return "Processing video...";
      case "SEND_TO_USER_INBOX":
        return "Sent to your TikTok inbox";
      case "PUBLISH_COMPLETE":
        return "Published successfully!";
      case "FAILED":
        return "Publishing failed";
      case "pending":
        return "Starting upload...";
      default:
        return "Processing...";
    }
  }, []);

  const getProgressEstimate = useCallback((status: TikTokPublishStatus, elapsed: number): number => {
    switch (status) {
      case "pending":
        return Math.min(10, elapsed / 1000);
      case "PROCESSING_UPLOAD":
        return Math.min(40, 10 + (elapsed / 2000));
      case "PROCESSING_DOWNLOAD":
        return Math.min(70, 40 + (elapsed / 3000));
      case "SEND_TO_USER_INBOX":
        return 85;
      case "PUBLISH_COMPLETE":
        return 100;
      case "FAILED":
        return 0;
      default:
        return Math.min(50, elapsed / 2000);
    }
  }, []);

  const checkStatus = useCallback(async () => {
    if (!publishId || !accountId) return;

    const elapsed = startTimeRef.current 
      ? Date.now() - startTimeRef.current 
      : 0;

    // Check if we've exceeded max polling time
    if (elapsed > maxPollingTime) {
      stopPolling();
      setStatusInfo(prev => ({
        ...prev,
        status: "unknown",
        failReason: "Status check timed out. Please check TikTok directly.",
      }));
      return;
    }

    try {
      const { data, error } = await supabase.functions.invoke("tiktok-check-status", {
        body: { 
          publish_id: publishId, 
          account_id: accountId,
        },
      });

      if (error) {
        console.error("TikTok status check error:", error);
        return;
      }

      const newStatus = data?.status || "unknown";
      const postId = data?.post_id;
      const failReason = data?.fail_reason;

      setStatusInfo({
        status: newStatus,
        postId: postId || null,
        postUrl: postId ? `https://www.tiktok.com/@${data?.username || "user"}/video/${postId}` : null,
        failReason: failReason || null,
        progress: getProgressEstimate(newStatus, elapsed),
        elapsedTime: elapsed,
      });

      // Handle completion
      if (newStatus === "PUBLISH_COMPLETE" && postId) {
        stopPolling();
        const postUrl = `https://www.tiktok.com/@${data?.username || "user"}/video/${postId}`;
        
        toast({
          title: "✅ TikTok post published!",
          description: (
            <a 
              href={postUrl} 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-primary underline"
            >
              View on TikTok →
            </a>
          ),
          duration: 10000,
        });
        
        onComplete?.(postId, postUrl);
      }

      // Handle inbox delivery (considered success for API flow)
      if (newStatus === "SEND_TO_USER_INBOX") {
        stopPolling();
        toast({
          title: "📬 Sent to your TikTok inbox",
          description: "Open the TikTok app to complete posting.",
          duration: 8000,
        });
      }

      // Handle failure
      if (newStatus === "FAILED") {
        stopPolling();
        toast({
          title: "❌ TikTok post failed",
          description: failReason || "An error occurred while publishing.",
          variant: "destructive",
          duration: 10000,
        });
        onFailed?.(failReason || "Unknown error");
      }

    } catch (err) {
      console.error("Status polling error:", err);
    }
  }, [publishId, accountId, maxPollingTime, stopPolling, getProgressEstimate, toast, onComplete, onFailed]);

  // Start polling when publishId is set
  useEffect(() => {
    if (!publishId || !accountId) {
      stopPolling();
      return;
    }

    setIsPolling(true);
    startTimeRef.current = Date.now();
    
    // Initial check
    checkStatus();
    
    // Set up interval
    intervalRef.current = setInterval(checkStatus, pollingInterval);

    return () => stopPolling();
  }, [publishId, accountId, pollingInterval, checkStatus, stopPolling]);

  // Also check database for status updates (realtime fallback)
  useEffect(() => {
    if (!platformPostId) return;

    const channel = supabase
      .channel(`platform_post:${platformPostId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "platform_posts",
          filter: `id=eq.${platformPostId}`,
        },
        (payload) => {
          const newRecord = payload.new as { status?: string; platform_post_id?: string; platform_post_url?: string; error_message?: string };
          if (newRecord.status === "success") {
            stopPolling();
            setStatusInfo(prev => ({
              ...prev,
              status: "PUBLISH_COMPLETE",
              postId: newRecord.platform_post_id,
              postUrl: newRecord.platform_post_url,
              progress: 100,
            }));
          } else if (newRecord.status === "failed") {
            stopPolling();
            setStatusInfo(prev => ({
              ...prev,
              status: "FAILED",
              failReason: newRecord.error_message,
              progress: 0,
            }));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [platformPostId, stopPolling]);

  return {
    ...statusInfo,
    isPolling,
    stopPolling,
    translateStatus: translateStatus(statusInfo.status),
  };
}
