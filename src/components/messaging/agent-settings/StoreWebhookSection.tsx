import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n";
import { toast } from "sonner";
import { AlertTriangle, Copy } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAiAgentTools, useAiToolAccountLinks } from "@/hooks/useAiAgentTools";
import { effectiveToolAccountIds, type SharingAccount } from "@/lib/accountSharing";
import { storeWebhookUrl, useStoreWebhookBindings } from "@/hooks/useStoreWebhookBindings";

const TOPICS = [
  { key: "orderCreated", label: "Order created" },
  { key: "orderUpdated", label: "Order updated" },
  { key: "productUpdated", label: "Product updated" },
] as const;

/** Where WooCommerce sends store events for this WhatsApp account's WooCommerce connector. */
export function StoreWebhookSection({ accountId }: { accountId: string }) {
  const { t } = useTranslation("agent");
  const { tools } = useAiAgentTools();
  const { links, linksReady } = useAiToolAccountLinks();
  const { bindings, isLoading, isError, refetch, createBinding, rotateSecret } = useStoreWebhookBindings();
  // Shown once, straight from the create/rotate response; a later list read does not restore it.
  const [secret, setSecret] = useState<string | null>(null);
  useEffect(() => setSecret(null), [accountId]);

  const account: SharingAccount = {
    id: accountId,
    platform: "whatsapp",
    platform_username: null,
    platform_user_id: null,
  };
  // Same rule the agent uses: the owning account, an all-accounts connector, or
  // an explicit ai_agent_tool_accounts share. An unread link list must not look
  // like "not shared", so shares wait until that read succeeds. Ownership and
  // all-accounts do not need the link rows.
  const connector = tools.find((tool) => {
    if (tool.connector_type !== "woocommerce") return false;
    return effectiveToolAccountIds(
      { id: tool.id, scope: tool.scope, social_account_id: tool.social_account_id },
      [account],
      linksReady ? links : [],
    ).includes(accountId);
  });
  if (!connector) return null;
  const listReady = bindings !== undefined && !isLoading && !isError;
  const binding = listReady
    ? bindings.find((row) => row.connector_id === connector.id && row.social_account_id === accountId)
    : undefined;
  const linkedElsewhere = !isLoading && !isError && bindings !== undefined && bindings.some((row) =>
    row.connector_id === connector.id && row.social_account_id !== accountId
  );
  const pending = createBinding.isPending || rotateSecret.isPending;

  const issue = async () => {
    try {
      const issued = binding
        ? await rotateSecret.mutateAsync(binding.id)
        : await createBinding.mutateAsync({ social_account_id: accountId, connector_id: connector.id });
      setSecret(issued.secret);
    } catch {
      toast.error(t("procedures.store.issueFailed", "The webhook secret could not be created. Try again."));
    }
  };

  const copy = async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      toast.success(t("procedures.store.copied", "Secret copied"));
    } catch {
      toast.error(t("procedures.store.copyFailed", "Copy failed. Select the secret and copy it manually."));
    }
  };

  return (
    <div className="space-y-3 rounded-md border p-3" data-testid="store-webhook-section">
      <div className="space-y-1">
        <p className="text-sm font-medium">{t("procedures.store.title", "Store events (WooCommerce)")}</p>
        <p className="text-xs text-muted-foreground">
          {t(
            "procedures.store.description",
            "In WooCommerce → Settings → Advanced → Webhooks, add one webhook per topic below with this delivery URL and secret.",
          )}
        </p>
      </div>
      {isLoading && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("procedures.store.loading", "Loading the store webhook…")}
        </p>
      )}
      {!isLoading && (isError || bindings === undefined) && (
        <div className="space-y-2">
          <p role="alert" className="text-xs text-destructive">
            {t("procedures.store.loadFailed", "The store webhook could not be loaded.")}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
            {t("procedures.store.retry", "Retry")}
          </Button>
        </div>
      )}
      {binding && (
        <div className="space-y-2">
          <Label htmlFor="store-webhook-url">{t("procedures.store.url", "Delivery URL")}</Label>
          <Input
            id="store-webhook-url"
            readOnly
            className="font-mono text-xs"
            value={storeWebhookUrl(binding.id)}
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
      )}
      <div className="space-y-1">
        <p className="text-xs font-medium">{t("procedures.store.topics", "Topics")}</p>
        <ul className="list-disc ps-5 text-xs text-muted-foreground">
          {TOPICS.map((topic) => (
            <li key={topic.key}>{t(`procedures.store.topic.${topic.key}`, topic.label)}</li>
          ))}
        </ul>
      </div>
      {secret && (
        <div className="space-y-2">
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{t("procedures.store.secretOnce", "Copy this secret now")}</AlertTitle>
            <AlertDescription>
              {t("procedures.store.secretOnceHint", "It will not be shown again. Rotate it if it is lost.")}
            </AlertDescription>
          </Alert>
          <div className="flex gap-2">
            <Input
              readOnly
              className="font-mono text-xs"
              aria-label={t("procedures.store.secret", "Webhook secret")}
              value={secret}
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button type="button" variant="outline" onClick={copy}>
              <Copy className="me-1 h-4 w-4" /> {t("procedures.store.copy", "Copy")}
            </Button>
          </div>
        </div>
      )}
      {linkedElsewhere && !binding && (
        <p className="text-xs text-muted-foreground">
          {t(
            "procedures.store.linkedElsewhere",
            "This store connection is already linked to another WhatsApp account",
          )}
        </p>
      )}
      {listReady && !linkedElsewhere && (
        <Button type="button" variant="outline" size="sm" disabled={pending} onClick={issue}>
          {binding
            ? t("procedures.store.rotate", "Rotate secret")
            : t("procedures.store.generate", "Generate webhook URL and secret")}
        </Button>
      )}
      {binding && (
        <p className="text-xs text-muted-foreground">
          {t("procedures.store.rotateHint", "After rotating, the old secret keeps working for 24 hours.")}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {t("procedures.store.disabled", "If WooCommerce shows the webhook as disabled, re-enable it.")}
      </p>
    </div>
  );
}
