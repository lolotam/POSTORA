import React, { createContext, useContext, useEffect, useRef } from "react";
import { useRealtimePostUpdates, PublishingPost, RealtimeUpdate } from "@/hooks/useRealtimePostUpdates";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { useNotificationSound } from "@/hooks/useNotificationSound";
import { getPlatformName } from "@/components/PlatformIcon";
import { useAuth } from "@/hooks/useAuth";

interface PublishingContextValue {
  publishingPosts: Map<string, PublishingPost>;
  recentUpdates: RealtimeUpdate[];
  trackPublishingPost: (postId: string, platforms: string[]) => void;
  clearPublishingPost: (postId: string) => void;
  isPublishing: boolean;
}

const PublishingContext = createContext<PublishingContextValue | null>(null);

export function PublishingProvider({ children }: { children: React.ReactNode }) {
  const realtimeHook = useRealtimePostUpdates();
  const { sendNotification, isEnabled: pushEnabled } = usePushNotifications();
  const { playSuccessSound, playErrorSound } = useNotificationSound();
  const { profile } = useAuth();
  
  // Check if sound is enabled from user preferences (default to true)
  const soundEnabled = profile?.notification_sound_enabled ?? true;
  
  // Track which updates we've already played sounds for
  const playedSoundsRef = useRef<Set<string>>(new Set());

  // Send push notifications and play sounds for completed platforms
  useEffect(() => {
    const latestUpdate = realtimeHook.recentUpdates[0];
    if (!latestUpdate) return;

    const updateKey = `${latestUpdate.postId}-${latestUpdate.platform}-${latestUpdate.status}`;
    
    // Prevent duplicate sounds
    if (playedSoundsRef.current.has(updateKey)) return;
    playedSoundsRef.current.add(updateKey);
    
    // Clean up old keys to prevent memory bloat (keep last 50)
    if (playedSoundsRef.current.size > 50) {
      const keysArray = Array.from(playedSoundsRef.current);
      keysArray.slice(0, keysArray.length - 50).forEach(key => playedSoundsRef.current.delete(key));
    }

    // Only notify on status changes (not pending)
    if (latestUpdate.status === "success") {
      if (soundEnabled) {
        playSuccessSound();
      }
      if (pushEnabled) {
        sendNotification(
          `✅ Published to ${getPlatformName(latestUpdate.platform as any)}`,
          {
            body: "Your post was published successfully!",
            tag: `publish-${latestUpdate.postId}-${latestUpdate.platform}`,
            requireInteraction: false,
          }
        );
      }
    } else if (latestUpdate.status === "failed") {
      if (soundEnabled) {
        playErrorSound();
      }
      if (pushEnabled) {
        sendNotification(
          `❌ Failed on ${getPlatformName(latestUpdate.platform as any)}`,
          {
            body: "There was an error publishing your post.",
            tag: `publish-${latestUpdate.postId}-${latestUpdate.platform}`,
            requireInteraction: true,
          }
        );
      }
    }
  }, [realtimeHook.recentUpdates, pushEnabled, sendNotification, playSuccessSound, playErrorSound, soundEnabled]);

  return (
    <PublishingContext.Provider value={realtimeHook}>
      {children}
    </PublishingContext.Provider>
  );
}

export function usePublishing() {
  const context = useContext(PublishingContext);
  if (!context) {
    throw new Error("usePublishing must be used within a PublishingProvider");
  }
  return context;
}
