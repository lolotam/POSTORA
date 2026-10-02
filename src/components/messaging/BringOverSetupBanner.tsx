import { useContext, useState } from "react";
import { QueryClientContext, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowRightLeft } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useToast } from "@/hooks/use-toast";
import { useSetupMoveCandidates, type SetupMoveCandidate } from "@/hooks/useSetupMoveCandidates";
import { useSetupMovePreview } from "@/hooks/useSetupMovePreview";
import { supabase } from "@/integrations/supabase/client";

interface BannerAccount {
  id: string;
  platform_username: string | null;
}

interface BringOverSetupBannerProps {
  activeAccount: BannerAccount | null;
}

type AgentChoice = "source" | "destination";

/**
 * "a, b and c" — Intl.ListFormat so the join follows the active language. The
 * constructor is typed locally because tsconfig targets ES2020, whose lib
 * predates it; every supported browser and Node ships the runtime.
 */
function formatList(parts: string[], language: string): string {
  type ListFormatter = { format(parts: string[]): string };
  const ListFormat = (
    Intl as unknown as {
      ListFormat: new (locale: string, options: { type: "conjunction" }) => ListFormatter;
    }
  ).ListFormat;
  return new ListFormat(language || "en-GB", { type: "conjunction" }).format(parts);
}

/**
 * Renders nothing until the query layer exists and an account is chosen. Hosts
 * mount the banner on several surfaces, some of which can render before (or
 * without) the app's providers; losing the banner must never take the page
 * down with it, and there is nothing to offer without those inputs anyway.
 */
export function BringOverSetupBanner({ activeAccount }: BringOverSetupBannerProps) {
  const queryClient = useContext(QueryClientContext);
  if (!queryClient || !activeAccount?.id) return null;
  return <BringOverSetupBannerInner activeAccount={activeAccount} />;
}

function BringOverSetupBannerInner({ activeAccount }: BringOverSetupBannerProps & { activeAccount: BannerAccount }) {
  const { t } = useTranslation("whatsapp");
  const { data: candidates } = useSetupMoveCandidates(activeAccount.id);
  const [handledIds, setHandledIds] = useState<Set<string>>(new Set());
  const candidate = (candidates ?? []).find((item) => !handledIds.has(item.id));
  if (!candidate) return null;
  return (
    <div className="space-y-3" aria-label={t("bringOver.title", "Bring over your setup")}>
      <SetupMoveCard
        candidate={candidate}
        activeAccount={activeAccount}
        onHandled={(id) => setHandledIds((prev) => new Set(prev).add(id))}
      />
    </div>
  );
}

function SetupMoveCard({
  candidate,
  activeAccount,
  onHandled,
}: {
  candidate: SetupMoveCandidate;
  activeAccount: BannerAccount;
  onHandled: (id: string) => void;
}) {
  const { t, i18n } = useTranslation("whatsapp");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fromName = candidate.platform_username || "WhatsApp";
  const toName = activeAccount.platform_username || "WhatsApp";
  // agent_config starts on "destination": the account in use keeps its agent
  // unless the owner explicitly asks for the old one.
  const [agentChoice, setAgentChoice] = useState<AgentChoice>("destination");
  const [connectorChecked, setConnectorChecked] = useState<Record<string, boolean>>({});
  const [clashChoice, setClashChoice] = useState<Record<string, "replace" | "skip">>({});
  const [movePartner, setMovePartner] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: preview } = useSetupMovePreview(candidate.id, activeAccount.id);
  if (!preview) return null;

  const { summary } = candidate;
  const agentMoves = preview.source_has_agent
    && (!preview.destination_has_agent || agentChoice === "source");

  const items: string[] = [];
  if (summary.agent_config > 0) items.push(t("bringOver.itemAgent", "an AI agent"));
  if (summary.connectors > 0) {
    items.push(t(
      "bringOver.itemConnectors",
      summary.connectors === 1 ? "1 WooCommerce connector" : "{{count}} WooCommerce connectors",
      { count: summary.connectors },
    ));
  }
  if (summary.store_bindings > 0) {
    items.push(t(
      "bringOver.itemStoreWebhook",
      summary.store_bindings === 1 ? "a store webhook" : "{{count}} store webhooks",
      { count: summary.store_bindings },
    ));
  }
  if (summary.knowledge_sources > 0) {
    items.push(t(
      "bringOver.itemKnowledge",
      summary.knowledge_sources === 1 ? "1 knowledge source" : "{{count}} knowledge sources",
      { count: summary.knowledge_sources },
    ));
  }
  const sentence = t("bringOver.explanation", "{{from}} has {{items}}. Move them to {{to}}?", {
    from: fromName,
    items: items.length > 0
      ? formatList(items, i18n?.language || "en-GB")
      : t("bringOver.savedSetup", "saved setup"),
    to: toName,
  });

  const refusalCopy: Record<string, string> = {
    accounts_not_compatible: t(
      "bringOver.errorAccounts",
      "These two connections can't share setup (different workspace or not finished connecting)",
    ),
    connector_name_clash: t(
      "bringOver.errorClash",
      "A connector with the same name already exists here. Choose replace or skip for it.",
    ),
    store_connector_left_behind: t(
      "bringOver.errorStoreLeft",
      "A store connector with a webhook can't stay behind without the agent. Move them together or keep both here.",
    ),
    replaced_connector_has_store_webhook: t(
      "bringOver.errorReplacedWebhook",
      "The connector already on this account owns a store webhook and can't be replaced.",
    ),
    order_in_flight: t(
      "bringOver.errorOrderInFlight",
      "An order message is being sent right now. Try again in a minute.",
    ),
  };

  const buildChoices = () => {
    const connectors: Record<string, "skip" | "replace"> = {};
    for (const connector of preview.connectors) {
      if (connector.name_clash) {
        // The connector already on this account owns the store webhook, so it
        // can't be replaced — the incoming one is skipped unless overridden.
        connectors[connector.name] = clashChoice[connector.name]
          ?? (connector.destination_has_store_webhook ? "skip" : "replace");
      } else {
        const disabled = connector.has_store_webhook && agentMoves;
        const effectiveChecked = disabled || (connectorChecked[connector.name] ?? true);
        if (!effectiveChecked) {
          connectors[connector.name] = "skip";
        }
      }
      // An unchecked box means skip; anything left checked simply moves and
      // names nothing in choices.
    }
    return {
      agent_config: agentMoves ? ("source" as const) : ("destination" as const),
      connectors,
      partner: movePartner,
    };
  };

  const handleMove = async () => {
    setBusy(true);
    setErrorText(null);
    try {
      const { data, error } = await supabase.functions.invoke("whatsapp-evolution-bridge", {
        body: {
          action: "move_setup",
          from: candidate.id,
          to: activeAccount.id,
          choices: buildChoices(),
        },
      });
      let code = typeof data?.error === "string" ? data.error : null;
      if (!code && error) {
        // A non-2xx reply arrives as FunctionsHttpError with `data` null; the
        // mover's stable refusal code rides on the JSON body of its Response.
        const envelope = error.context instanceof Response
          ? await error.context.clone().json().catch(() => null)
          : null;
        if (envelope && typeof envelope.error === "string") code = envelope.error;
      }
      if (error || code) {
        setErrorText(
          (code && refusalCopy[code])
            || t("bringOver.moveFailed", "Couldn't move the setup. Try again in a minute."),
        );
        return;
      }
      toast({ title: t("bringOver.movedToast", "Setup moved") });
      queryClient.invalidateQueries({ queryKey: ["whatsapp-setup-move-candidates"] });
      queryClient.invalidateQueries({ queryKey: ["whatsapp-setup-summary"] });
      queryClient.invalidateQueries({ queryKey: ["ai-agent-config"] });
      queryClient.invalidateQueries({ queryKey: ["ai-agent-tools"] });
      onHandled(candidate.id);
    } catch {
      setErrorText(t("bringOver.moveFailed", "Couldn't move the setup. Try again in a minute."));
    } finally {
      setBusy(false);
    }
  };

  const handleDismiss = async () => {
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("whatsapp-evolution-bridge", {
        body: { action: "dismiss_setup_move", from: candidate.id, to: activeAccount.id },
      });
      if (error || data?.error) {
        toast({
          title: t("bringOver.dismissFailed", "Couldn't save that. Try again in a minute."),
          variant: "destructive",
        });
        return;
      }
      onHandled(candidate.id);
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
      <AlertTitle>{sentence}</AlertTitle>
      <AlertDescription className="space-y-3">
        <div className="space-y-2">
          {preview.connectors.map((connector) => {
            const checkId = `bring-over-connector-${candidate.id}-${connector.name}`;
            if (connector.name_clash) {
              const value = clashChoice[connector.name]
                ?? (connector.destination_has_store_webhook ? "skip" : "replace");
              const replaceDisabled = connector.destination_has_store_webhook === true;
              // The agent is leaving, so a webhook-bearing connector cannot
              // stay behind as "skip" — it must move (replace) or nothing moves.
              const skipDisabled = connector.has_store_webhook === true && agentMoves;
              return (
                <div key={connector.name} className="space-y-2 rounded-md border p-2">
                  <p className="text-sm font-medium">{connector.name}</p>
                  <RadioGroup
                    value={value}
                    onValueChange={(next) =>
                      setClashChoice((prev) => ({ ...prev, [connector.name]: next as "replace" | "skip" }))}
                    className="space-y-1"
                  >
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem
                        value="replace"
                        id={`${checkId}-replace`}
                        disabled={busy || replaceDisabled}
                      />
                      <Label htmlFor={`${checkId}-replace`}>
                        {t("bringOver.replaceHere", "Replace the one here")}
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem
                        value="skip"
                        id={`${checkId}-skip`}
                        disabled={busy || skipDisabled}
                      />
                      <Label htmlFor={`${checkId}-skip`}>
                        {t("bringOver.keepHere", "Keep the one here (skip)")}
                      </Label>
                    </div>
                  </RadioGroup>
                </div>
              );
            }
            const disabled = connector.has_store_webhook && agentMoves;
            const effectiveChecked = disabled || (connectorChecked[connector.name] ?? true);
            return (
              <div key={connector.name} className="space-y-1">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id={checkId}
                    checked={effectiveChecked}
                    disabled={disabled || busy}
                    onCheckedChange={(next) =>
                      setConnectorChecked((prev) => ({ ...prev, [connector.name]: next === true }))}
                  />
                  <Label htmlFor={checkId}>{connector.name}</Label>
                </div>
                {disabled && (
                  <p className="text-xs text-muted-foreground">
                    {t(
                      "bringOver.storeWebhookHint",
                      "The agent moves, so its store connector must move too",
                    )}
                  </p>
                )}
              </div>
            );
          })}
          {preview.partner_items > 0 && (
            <div className="flex items-center space-x-2">
              <Checkbox
                id={`bring-over-partner-${candidate.id}`}
                checked={movePartner}
                disabled={busy}
                onCheckedChange={(next) => setMovePartner(next === true)}
              />
              <Label htmlFor={`bring-over-partner-${candidate.id}`}>
                {t("bringOver.partnerLabel", "Partner API keys and webhooks ({{count}})", {
                  count: preview.partner_items,
                })}
              </Label>
            </div>
          )}
        </div>
        {preview.source_has_agent && preview.destination_has_agent && (
          <RadioGroup
            value={agentChoice}
            onValueChange={(value) => setAgentChoice(value as AgentChoice)}
            className="space-y-1"
          >
            <div className="flex items-center space-x-2">
              <RadioGroupItem
                value="destination"
                id={`bring-over-agent-destination-${candidate.id}`}
                disabled={busy}
              />
              <Label htmlFor={`bring-over-agent-destination-${candidate.id}`}>
                {t("bringOver.keepActiveAgent", "Keep this account's AI agent")}
              </Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem
                value="source"
                id={`bring-over-agent-source-${candidate.id}`}
                disabled={busy}
              />
              <Label htmlFor={`bring-over-agent-source-${candidate.id}`}>
                {t("bringOver.useSourceAgent", "Use the one from {{from}}", { from: fromName })}
              </Label>
            </div>
          </RadioGroup>
        )}
        {!preview.waitlist_moves && preview.waitlist_count > 0 && (
          <p className="text-xs text-muted-foreground">
            {t(
              "bringOver.waitlistStays",
              "{{count}} waitlisted customers stay — they agreed to messages from the old number",
              { count: preview.waitlist_count },
            )}
          </p>
        )}
        {!preview.templates_move && preview.template_count > 0 && (
          <p className="text-xs text-muted-foreground">
            {t(
              "bringOver.templatesStay",
              "{{count}} message templates must be recreated on this account",
              { count: preview.template_count },
            )}
          </p>
        )}
        {errorText && <p className="text-sm text-destructive">{errorText}</p>}
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
