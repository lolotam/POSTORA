import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { callMessagingApi } from "@/lib/messagingApi";

/** One WooCommerce connector's webhook address. The signing secret is never part of a read. */
export interface StoreWebhookBinding {
  id: string;
  social_account_id: string;
  connector_id: string;
  rotated_at: string | null;
  created_at: string;
}

/** Returned by create and rotate only: the one time the browser sees the secret. */
export interface IssuedWebhookSecret {
  binding: StoreWebhookBinding;
  secret: string;
}

export function storeWebhookUrl(bindingId: string): string {
  return `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/store-webhook/${bindingId}`;
}

export function useStoreWebhookBindings() {
  const { session, user } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = ["store-webhook-bindings", user?.id];

  const query = useQuery({
    queryKey,
    enabled: !!session,
    queryFn: async () => {
      const data = await callMessagingApi("list_store_webhook_bindings", {});
      return (data.bindings || []) as StoreWebhookBinding[];
    },
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const createBinding = useMutation({
    mutationFn: async (input: { social_account_id: string; connector_id: string }) =>
      (await callMessagingApi("create_store_webhook_binding", input)) as IssuedWebhookSecret,
    onSuccess: invalidate,
  });

  const rotateSecret = useMutation({
    mutationFn: async (bindingId: string) =>
      (await callMessagingApi("rotate_store_webhook_secret", { binding_id: bindingId })) as IssuedWebhookSecret,
    onSuccess: invalidate,
  });

  return {
    bindings: query.data,
    isLoading: query.isPending,
    isError: query.isError,
    refetch: query.refetch,
    createBinding,
    rotateSecret,
  };
}
