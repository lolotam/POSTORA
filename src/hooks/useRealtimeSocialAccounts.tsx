import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "./use-toast";
import { getPlatformName } from "@/components/PlatformIcon";
import type { Platform } from "@/lib/types";

/** The social_accounts columns a realtime change event is read for. */
interface SocialAccountChange {
  is_active?: boolean;
  platform?: Platform;
  platform_username?: string | null;
}

/**
 * Hook that listens for real-time changes to social_accounts table
 * and automatically refreshes the UI when accounts are connected/disconnected.
 */
export function useRealtimeSocialAccounts() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  useEffect(() => {
    if (!user?.id) return;

    console.log("[Realtime] Setting up social_accounts subscription for user:", user.id);

    const channel = supabase
      .channel("social-accounts-changes")
      .on(
        "postgres_changes",
        {
          event: "*", // Listen to INSERT, UPDATE, DELETE
          schema: "public",
          table: "social_accounts",
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          console.log("[Realtime] social_accounts change:", payload);

          const newRecord = payload.new as SocialAccountChange;
          const oldRecord = payload.old as SocialAccountChange;

          // Invalidate all related queries to refresh the UI
          queryClient.invalidateQueries({ queryKey: ["social_accounts"] });
          queryClient.invalidateQueries({ queryKey: ["social_accounts_by_profile"] });
          queryClient.invalidateQueries({ queryKey: ["social_profiles"] });
          queryClient.invalidateQueries({ queryKey: ["all_social_accounts"] });
          queryClient.invalidateQueries({ queryKey: ["posts_with_results"] });
          queryClient.invalidateQueries({ queryKey: ["post_stats"] });

          // Show toast for new account connections
          if (payload.eventType === "INSERT" && newRecord?.is_active) {
            const platformName = getPlatformName(newRecord.platform);
            toastRef.current({
              title: `${platformName} connected!`,
              description: newRecord.platform_username
                ? `Connected as ${newRecord.platform_username}`
                : `Your ${platformName} account is now connected.`,
            });
          }

          // Show toast for account reconnections (when is_active changes to true)
          if (
            payload.eventType === "UPDATE" &&
            !oldRecord?.is_active &&
            newRecord?.is_active
          ) {
            const platformName = getPlatformName(newRecord.platform);
            toastRef.current({
              title: `${platformName} reconnected!`,
              description: `Your ${platformName} account is active again.`,
            });
          }

          // Show toast for disconnections
          if (
            payload.eventType === "UPDATE" &&
            oldRecord?.is_active &&
            !newRecord?.is_active
          ) {
            const platformName = getPlatformName(newRecord.platform);
            toastRef.current({
              title: `${platformName} disconnected`,
              description: `Your ${platformName} account has been disconnected.`,
              variant: "destructive",
            });
          }
        }
      )
      .subscribe((status) => {
        console.log("[Realtime] social_accounts subscription status:", status);
      });

    return () => {
      console.log("[Realtime] Cleaning up social_accounts subscription");
      supabase.removeChannel(channel);
    };
  }, [user?.id, queryClient]);
}
