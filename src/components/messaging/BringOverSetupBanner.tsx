import { Component, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowRightLeft } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useToast } from "@/hooks/use-toast";
import {
  useSetupMoveCandidates,
  type SetupMoveActiveAccount,
  type SetupMoveCandidate,
} from "@/hooks/useSetupMoveCandidates";
import { useWhatsAppSetupSummary } from "@/hooks/useWhatsAppSetupSummary";
import { supabase } from "@/integrations/supabase/client";

interface BringOverSetupBannerProps {
  activeAccount: (SetupMoveActiveAccount & { platform_username?: string | null }) | null;
}

/**
 * The banner is mounted on several surfaces and reads auth-backed hooks. A host
 * rendered outside the AuthProvider (unit tests, future compositions) must lose
 * only the banner, not the whole page, so the hook-consuming subtree is contained.
 */
class ContainedBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    // Contained, not hidden: the page keeps rendering, but the failure stays visible in the
    // console and in Sentry's console breadcrumbs.
    console.error("[BringOverSetupBanner] render failed", error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** "a, b and c" — the sentence the banner reads as one line. */
function joinAnd(parts: string[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function accountName(account: { platform_username?: string | null } | null | undefined): string {
  return account?.platform_username || "WhatsApp";
}

function SetupMoveCard({
  candidate,
  activeAccountId,
  activeName,
  activeHasAgent,
  onDismissed,
  onMoved,
}: {
  candidate: SetupMoveCandidate;
  activeAccountId: string;
  activeName: string;
  activeHasAgent: boolean;
  onDismissed: (id: string) => void;
  onMoved: (id: string) => void;
}) {
  const { t } = useTranslation("whatsapp");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // agent_config starts on "destination": the account being used right now keeps its
  // agent unless the owner explicitly asks for the old one.
  const [moveAgent, setMoveAgent] = useState(false);
  const [moveConnectors, setMoveConnectors] = useState(true);
  const [moveStoreWebhook, setMoveStoreWebhook] = useState(true);
  const [busy, setBusy] = useState(false);

  const fromName = accountName(candidate.from);
  const { summary } = candidate;

  const items: string[] = [];
  if (summary.agent_config > 0) items.push(t("bringOver.itemAgent", "an AI agent"));
  if (summary.connectors > 0) {
    items.push(t("bringOver.itemConnectors", "{{count}} WooCommerce connector", { count: summary.connectors }));
  }
  if (summary.store_bindings > 0) items.push(t("bringOver.itemStoreWebhook", "a store webhook"));
  if (summary.knowledge_sources > 0) {
    items.push(t("bringOver.itemKnowledge", "{{count}} knowledge sources", { count: summary.knowledge_sources }));
  }
  if ((summary.automation_handlers?.length ?? 0) > 0) {
    items.push(t("bringOver.itemAutomation", "automation settings"));
  }
  if (summary.test_cases > 0) {
    items.push(t("bringOver.itemTestCases", "{{count}} test cases", { count: summary.test_cases }));
  }
  if (summary.waitlist > 0) {
    items.push(t("bringOver.itemWaitlist", "{{count}} waitlist entries", { count: summary.waitlist }));
  }
  if (summary.templates > 0) {
    items.push(t("bringOver.itemTemplates", "{{count}} message templates", { count: summary.templates }));
  }
  if (summary.partner_keys_primary > 0) {
    items.push(t("bringOver.itemPartnerKeys", "{{count}} partner API keys", { count: summary.partner_keys_primary }));
  }
  if (summary.partner_webhooks > 0) {
    items.push(t("bringOver.itemPartnerWebhooks", "{{count}} partner webhooks", { count: summary.partner_webhooks }));
  }
  if (summary.n8n_subscriptions > 0) {
    items.push(t("bringOver.itemN8n", "{{count}} n8n automations", { count: summary.n8n_subscriptions }));
  }
  if (summary.scheduled_messages > 0) {
    items.push(t("bringOver.itemScheduled", "{{count}} scheduled messages", { count: summary.scheduled_messages }));
  }

  const connectorId = `bring-over-connectors-${candidate.from.id}`;
  const storeWebhookId = `bring-over-store-webhook-${candidate.from.id}`;
  const agentSourceId = `bring-over-agent-source-${candidate.from.id}`;
  const agentDestinationId = `bring-over-agent-destination-${candidate.from.id}`;

  const refreshAfterMove = () => {
    queryClient.invalidateQueries({ queryKey: ["whatsapp-setup-summary"] });
    queryClient.invalidateQueries({ queryKey: ["ai-agent-config"] });
    queryClient.invalidateQueries({ queryKey: ["ai-agent-tools"] });
  };

  const handleMove = async () => {
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("whatsapp-evolution-bridge", {
        body: {
          action: "move_setup",
          from: candidate.from.id,
          to: activeAccountId,
          choices: {
            agent_config: moveAgent ? ("source" as const) : ("destination" as const),
            connectors: {},
          },
        },
      });
      if (error || data?.error) throw new Error("move_setup_failed");
      toast({ title: t("bringOver.movedToast", "Setup moved") });
      refreshAfterMove();
      onMoved(candidate.from.id);
    } catch {
      toast({
        title: t("bringOver.moveFailed", "Couldn't move the setup. Try again in a minute."),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  const handleDismiss = async () => {
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("whatsapp-evolution-bridge", {
        body: {
          action: "dismiss_setup_move",
          from: candidate.from.id,
          to: activeAccountId,
        },
      });
      if (error || data?.error) throw new Error("dismiss_setup_move_failed");
      onDismissed(candidate.from.id);
    } catch {
      toast({
        title: t("bringOver.dismissFailed", "Couldn't save that. Try again in a minute."),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Alert>
      <ArrowRightLeft className="h-4 w-4" />
      <AlertTitle>
        {t("bringOver.explanation", "{{from}} has {{items}}. Move them to {{to}}?", {
          from: fromName,
          items: joinAnd(items),
          to: activeName,
        })}
      </AlertTitle>
      <AlertDescription className="space-y-3">
        <div className="space-y-2">
          <div className="flex items-center space-x-2">
            <Checkbox
              id={connectorId}
              checked={moveConnectors}
              disabled={busy}
              onCheckedChange={(checked) => setMoveConnectors(checked === true)}
            />
            <Label htmlFor={connectorId}>{t("bringOver.connectorLabel", "WooCommerce connector")}</Label>
          </div>
          {summary.store_bindings > 0 && (
            <>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id={storeWebhookId}
                  checked={moveStoreWebhook && moveConnectors}
                  disabled={!moveConnectors || busy}
                  onCheckedChange={(checked) => setMoveStoreWebhook(checked === true)}
                />
                <Label htmlFor={storeWebhookId}>{t("bringOver.storeWebhookLabel", "Store webhook")}</Label>
              </div>
              {!moveConnectors && (
                <p className="text-xs text-muted-foreground">
                  {t("bringOver.storeWebhookHint", "Moves with its WooCommerce connector")}
                </p>
              )}
            </>
          )}
        </div>
        {activeHasAgent && (
          <RadioGroup
            value={moveAgent ? "source" : "destination"}
            onValueChange={(value) => setMoveAgent(value === "source")}
          >
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="destination" id={agentDestinationId} disabled={busy} />
              <Label htmlFor={agentDestinationId}>
                {t("bringOver.keepActiveAgent", "Keep this account's AI agent")}
              </Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="source" id={agentSourceId} disabled={busy} />
              <Label htmlFor={agentSourceId}>
                {t("bringOver.useSourceAgent", "Use the one from {{from}}", { from: fromName })}
              </Label>
            </div>
          </RadioGroup>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={handleMove} disabled={busy}>
            {t("bringOver.move", "Move")}
          </Button>
          <Button size="sm" variant="ghost" onClick={handleDismiss} disabled={busy}>
            {t("bringOver.notNow", "Not now")}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

export function BringOverSetupBanner({ activeAccount }: BringOverSetupBannerProps) {
  return (
    <ContainedBoundary>
      <BringOverSetupBannerInner activeAccount={activeAccount} />
    </ContainedBoundary>
  );
}

function BringOverSetupBannerInner({ activeAccount }: BringOverSetupBannerProps) {
  const { t } = useTranslation("whatsapp");
  // The hook normally returns a query result; accept a bare array too, since both
  // shapes are used by tests and callers.
  const candidatesResult = useSetupMoveCandidates(activeAccount);
  const candidates = Array.isArray(candidatesResult) ? candidatesResult : candidatesResult?.data;
  const { data: activeSummary } = useWhatsAppSetupSummary(activeAccount?.id ?? null);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());

  if (!activeAccount) return null;
  const visible = (candidates ?? []).filter((candidate) => !hiddenIds.has(candidate.from.id));
  if (visible.length === 0) return null;

  const activeName = accountName(activeAccount);
  const activeHasAgent = (activeSummary?.agent_config ?? 0) > 0;

  return (
    <div className="space-y-3" aria-label={t("bringOver.title", "Bring over your setup")}>
      {visible.map((candidate) => (
        <SetupMoveCard
          key={candidate.from.id}
          candidate={candidate}
          activeAccountId={activeAccount.id}
          activeName={activeName}
          activeHasAgent={activeHasAgent}
          onDismissed={(id) => setHiddenIds((prev) => new Set(prev).add(id))}
          onMoved={(id) => setHiddenIds((prev) => new Set(prev).add(id))}
        />
      ))}
    </div>
  );
}
