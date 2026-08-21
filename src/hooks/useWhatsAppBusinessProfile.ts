import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";

export interface WhatsAppBusinessProfile {
  about?: string;
  address?: string;
  description?: string;
  email?: string;
  websites?: string[];
  vertical?: string;
  profile_picture_url?: string;
}

const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

async function getAuthHeaders() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    await supabase.auth.refreshSession();
    const { data: refreshed } = await supabase.auth.getSession();
    if (!refreshed.session?.access_token) throw new Error("Not authenticated");
    return {
      Authorization: `Bearer ${refreshed.session.access_token}`,
      apikey: anonKey,
    };
  }
  return {
    Authorization: `Bearer ${session.access_token}`,
    apikey: anonKey,
  };
}

const BASE_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/whatsapp-profile`;

/** Codes describing account state rather than a transient failure, so retrying cannot help. */
const TERMINAL_PROFILE_CODES = new Set(["PROFILE_REQUIRES_CLOUD_API", "NO_WHATSAPP_ACCOUNT"]);

/** Carries the backend's machine-readable code so callers can branch without matching on prose. */
export class WhatsAppProfileError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "WhatsAppProfileError";
    this.code = code;
  }
}

async function profileRequestError(res: Response, fallback: string): Promise<WhatsAppProfileError> {
  const body = await res.json().catch(() => null);
  // Meta explains the real cause in `details`; dropping it made an expired token
  // indistinguishable from a wrong phone number once it reached the toast.
  const metaMessage = body?.details?.error?.message;
  const message = [body?.error || fallback, metaMessage].filter(Boolean).join(" — ");
  return new WhatsAppProfileError(message, body?.code);
}

export function useWhatsAppBusinessProfile() {
  const queryClient = useQueryClient();

  const query = useQuery<WhatsAppBusinessProfile>({
    queryKey: ["whatsapp-business-profile"],
    queryFn: async () => {
      const headers = await getAuthHeaders();
      const res = await fetch(BASE_URL, { headers });
      if (!res.ok) {
        throw await profileRequestError(res, "Failed to fetch profile");
      }
      return res.json();
    },
    // A connection mode without profiles is a permanent state, not a blip; retrying it three
    // times only delays the explanation the page is ready to show.
    retry: (failureCount, error) =>
      !(error instanceof WhatsAppProfileError && TERMINAL_PROFILE_CODES.has(error.code ?? "")) &&
      failureCount < 3,
  });

  const updateMutation = useMutation({
    mutationFn: async (profile: Omit<WhatsAppBusinessProfile, "profile_picture_url">) => {
      const headers = await getAuthHeaders();
      const res = await fetch(BASE_URL, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      });
      if (!res.ok) {
        throw await profileRequestError(res, "Failed to update profile");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-business-profile"] });
      toast({ title: "Profile updated", description: "Your WhatsApp Business profile has been saved." });
    },
    onError: (error: Error) => {
      toast({ title: "Update failed", description: error.message, variant: "destructive" });
    },
  });

  return { profile: query.data, isLoading: query.isLoading, error: query.error, updateProfile: updateMutation.mutate, isUpdating: updateMutation.isPending };
}
