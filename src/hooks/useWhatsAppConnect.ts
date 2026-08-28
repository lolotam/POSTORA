import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { launchWhatsAppSignup, type WhatsAppConnectionMode } from "@/lib/whatsappEmbeddedSignup";

export function useWhatsAppConnect() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (mode: WhatsAppConnectionMode) => {
      const signup = await launchWhatsAppSignup(mode);
      const { data, error } = await supabase.functions.invoke("whatsapp-oauth", {
        body: {
          action: "exchange_signup",
          code: signup.code,
          waba_id: signup.waba_id,
          phone_number_id: signup.phone_number_id,
          business_id: signup.business_id,
          mode: signup.mode,
        },
      });
      if (error) throw new Error(error.message || "Failed to complete WhatsApp connection.");
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (_data, mode) => {
      toast({
        title: "WhatsApp connected",
        description:
          mode === "coexistence"
            ? "Your number is now active in Postora and your mobile WhatsApp Business app."
            : "Your number is now connected via Cloud API.",
      });
      queryClient.invalidateQueries({ queryKey: ["social_accounts"] });
      queryClient.invalidateQueries({ queryKey: ["messaging_accounts"] });
    },
    onError: (err: Error) => {
      toast({
        title: "WhatsApp connection failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });
}

export function useWhatsAppRequestSync() {
  return useMutation({
    mutationFn: async (socialAccountId: string) => {
      const { data, error } = await supabase.functions.invoke("whatsapp-oauth", {
        body: { action: "request_sync", social_account_id: socialAccountId },
      });
      if (error) throw new Error(error.message || "Failed to request chat sync.");
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (data) => {
      const failed = (data?.results || []).filter((r: { success: boolean }) => !r.success);
      if (failed.length === 0) {
        toast({
          title: "Chat sync requested",
          description: "Your phone's chats and contacts will appear in the inbox within a few minutes.",
        });
      } else {
        toast({
          title: "Chat sync partially failed",
          description:
            "Meta rejected the sync request. If you connected more than 24 hours ago, or declined " +
            "chat-history sharing during setup, disconnect in the WhatsApp Business app " +
            "(Settings → Account → Business platforms) and reconnect, approving history sharing.",
          variant: "destructive",
        });
      }
    },
    onError: (err: Error) => {
      toast({ title: "Chat sync request failed", description: err.message, variant: "destructive" });
    },
  });
}

/**
 * Restores a Meta-hosted account that was disconnected in-product.
 *
 * Embedded Signup cannot do this: it offers numbers available to *onboard*, so a
 * number already owned by a WABA never appears there and the operator is left
 * with a live, healthy number, an empty picker, and no messages arriving.
 */
export function useWhatsAppReconnect() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (socialAccountId: string) => {
      const { data, error } = await supabase.functions.invoke("whatsapp-oauth", {
        body: { action: "reconnect", social_account_id: socialAccountId },
      });
      if (error) throw new Error(error.message || "Failed to reconnect.");
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: () => {
      toast({
        title: "WhatsApp reconnected",
        description: "Webhooks are subscribed again and messages will resume.",
      });
      queryClient.invalidateQueries({ queryKey: ["social_accounts"] });
      queryClient.invalidateQueries({ queryKey: ["messaging_accounts"] });
    },
    onError: (err: Error) => {
      toast({ title: "Reconnect failed", description: err.message, variant: "destructive" });
    },
  });
}

export function useWhatsAppDisconnect() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (socialAccountId: string) => {
      const { data, error } = await supabase.functions.invoke("whatsapp-oauth", {
        body: { action: "disconnect", social_account_id: socialAccountId },
      });
      if (error) throw new Error(error.message || "Failed to disconnect.");
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: () => {
      toast({ title: "WhatsApp disconnected" });
      queryClient.invalidateQueries({ queryKey: ["social_accounts"] });
      queryClient.invalidateQueries({ queryKey: ["messaging_accounts"] });
    },
    onError: (err: Error) => {
      toast({ title: "Disconnect failed", description: err.message, variant: "destructive" });
    },
  });
}
