import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n";
import { toast } from "sonner";
import { AlertTriangle, Copy } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAiAgentTools, useAiToolAccountLinks, type AiAgentTool } from "@/hooks/useAiAgentTools";
import { effectiveToolAccountIds, type SharingAccount, type ToolAccountLink } from "@/lib/accountSharing";
import {
  storeWebhookUrl,
  useStoreWebhookBindings,
  type StoreWebhookBinding,
} from "@/hooks/useStoreWebhookBindings";

const TOPICS = [
  { key: "orderCreated", label: "Order created" },
  { key: "orderUpdated", label: "Order updated" },
  { key: "productUpdated", label: "Product updated" },
] as const;

/** The account and connector that asked for a secret. A late response is shown only while both are still selected. */
type ShownSecret = {
  accountId: string;
  connectorId: string;
  secret: string;
};

function eligibleWooConnectors(
  tools: AiAgentTool[],
  accountId: string,
  links: ToolAccountLink[],
  linksReady: boolean,
): AiAgentTool[] {
  const account: SharingAccount = {
    id: accountId,
    platform: "whatsapp",
    platform_username: null,
    platform_user_id: null,
  };
  // Same rule the agent uses: the owning account, an all-accounts connector, or
  // an explicit ai_agent_tool_accounts share. An unread link list must not look
  // like "not shared", so shares wait until that read succeeds. Ownership and
  // all-accounts do not need the link rows. Input order is kept, which is the
  // name-sorted tool list.
  return tools.filter((tool) => {
    if (tool.connector_type !== "woocommerce") return false;
    return effectiveToolAccountIds(
      { id: tool.id, scope: tool.scope, social_account_id: tool.social_account_id },
      [account],
      linksReady ? links : [],
    ).includes(accountId);
  });
}

function ConnectorWebhookRow({
  connector,
  binding,
  linkedElsewhere,
  pending,
  secret,
  onIssue,
  onCopy,
}: {
  connector: AiAgentTool;
  binding: StoreWebhookBinding | undefined;
  linkedElsewhere: boolean;
  pending: boolean;
  secret: string | null;
  onIssue: (connectorId: string, bindingId: string | undefined) => void;
  onCopy: (secret: string) => void;
}) {
  const { t } = useTranslation("agent");
  const urlId = `store-webhook-url-${connector.id}`;

  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="store-webhook-connector">
      <p className="text-xs font-medium">{connector.name}</p>
      {binding && (
        <div className="space-y-2">
          <Label htmlFor={urlId}>{t("procedures.store.url", "Delivery URL")}</Label>
          <Input
            id={urlId}
            readOnly
            className="font-mono text-xs"
            value={storeWebhookUrl(binding.id)}
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
      )}
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
            <Button type="button" variant="outline" onClick={() => onCopy(secret)}>
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
      {!linkedElsewhere && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => onIssue(connector.id, binding?.id)}
        >
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
    </div>
  );
}

/** Where WooCommerce sends store events for this WhatsApp account's WooCommerce connectors. */
export function StoreWebhookSection({ accountId }: { accountId: string }) {
  const { t } = useTranslation("agent");
  const { tools } = useAiAgentTools();
  const { links, linksReady } = useAiToolAccountLinks();
  const { bindings, isLoading, isError, refetch, createBinding, rotateSecret } = useStoreWebhookBindings();
  // Shown once, straight from the create/rotate response; a later list read does not restore it.
  const [shown, setShown] = useState<ShownSecret | null>(null);
  const accountIdRef = useRef(accountId);
  const mountedRef = useRef(true);
  accountIdRef.current = accountId;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => setShown(null), [accountId]);

  const connectors = eligibleWooConnectors(tools, accountId, links, linksReady);
  if (connectors.length === 0) return null;
  const listReady = bindings !== undefined && !isLoading && !isError;
  const pending = createBinding.isPending || rotateSecret.isPending;

  const issue = (connectorId: string, bindingId: string | undefined) => {
    const forAccount = accountId;
    void (async () => {
      try {
        const issued = bindingId
          ? await rotateSecret.mutateAsync(bindingId)
          : await createBinding.mutateAsync({ social_account_id: forAccount, connector_id: connectorId });
        if (!mountedRef.current || accountIdRef.current !== forAccount) return;
        setShown({ accountId: forAccount, connectorId, secret: issued.secret });
      } catch {
        if (!mountedRef.current || accountIdRef.current !== forAccount) return;
        toast.error(t("procedures.store.issueFailed", "The webhook secret could not be created. Try again."));
      }
    })();
  };

  const copy = async (secret: string) => {
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
      <div className="space-y-1">
        <p className="text-xs font-medium">{t("procedures.store.topics", "Topics")}</p>
        <ul className="list-disc ps-5 text-xs text-muted-foreground">
          {TOPICS.map((topic) => (
            <li key={topic.key}>{t(`procedures.store.topic.${topic.key}`, topic.label)}</li>
          ))}
        </ul>
      </div>
      {listReady && connectors.map((connector) => {
        const binding = bindings.find((row) =>
          row.connector_id === connector.id && row.social_account_id === accountId
        );
        const linkedElsewhere = bindings.some((row) =>
          row.connector_id === connector.id && row.social_account_id !== accountId
        );
        const secret = shown?.accountId === accountId && shown.connectorId === connector.id ? shown.secret : null;
        return (
          <ConnectorWebhookRow
            key={connector.id}
            connector={connector}
            binding={binding}
            linkedElsewhere={linkedElsewhere}
            pending={pending}
            secret={secret}
            onIssue={issue}
            onCopy={(value) => void copy(value)}
          />
        );
      })}
      <p className="text-xs text-muted-foreground">
        {t("procedures.store.disabled", "If WooCommerce shows the webhook as disabled, re-enable it.")}
      </p>
    </div>
  );
}
