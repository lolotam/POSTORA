import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n";
import { Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useAiAgentTools, useAiToolAccountLinks, type AiAgentTool } from "@/hooks/useAiAgentTools";
import { useStoreWebhookBindings } from "@/hooks/useStoreWebhookBindings";
import { effectiveToolAccountIds, type SharingAccount, type ToolAccountLink } from "@/lib/accountSharing";
import { callMessagingApi } from "@/lib/messagingApi";
import {
  eventEnableRefusal,
  isEventProcedureKey,
  PROCEDURE_FIELDS,
  PROCEDURE_KEYS,
  PROCEDURE_LIMITS,
  showsEventTemplateStatus,
  type EventEnableRefusal,
  type EventProcedureKey,
  type ProcedureKey,
  type ProcedureSettings,
} from "@/lib/procedureTemplates";
import type { BehaviorCardProps } from "./types";
import { StoreWebhookSection } from "./StoreWebhookSection";

const FLOW_NAMES: Record<ProcedureKey, string> = {
  order_status: "Order status",
  lead_capture: "Lead capture",
  complaint_return: "Complaint or return",
  booking: "Booking",
  product_finder: "Product finder",
  cod_confirm: "COD order confirmation",
  review_request: "Review request",
  back_in_stock: "Back in stock",
};

const REFUSAL_TEXT: Record<EventEnableRefusal, string> = {
  agent_disabled: "Turn the agent on before enabling this flow.",
  human_first: "This flow stays off while replies are set to human first.",
  read_only: "COD confirmation needs a WooCommerce connection that can update orders. {{name}} is read-only.",
  consent_required: "Confirm that checkout collects consent for WhatsApp order updates.",
  qr_risk_required: "Confirm that you understand WhatsApp may restrict numbers that send unsolicited messages.",
  review_delay: "Delay must be a whole number of days from 0 to 14.",
  review_url: "The review link must start with https://.",
};

/** Longest legal comma-separated list: 20 services of 60 characters, joined by ", ". */
const SERVICES_INPUT_MAX =
  PROCEDURE_LIMITS.services * PROCEDURE_LIMITS.service + (PROCEDURE_LIMITS.services - 1) * 2;

function blank(key: ProcedureKey, current?: ProcedureSettings): ProcedureSettings {
  const next: ProcedureSettings = {
    enabled: true,
    prompts: current?.prompts ?? {},
    closing: current?.closing ?? "",
    ...(current?.services !== undefined ? { services: current.services } : {}),
    ...(current?.questions !== undefined ? { questions: current.questions } : {}),
    ...(current?.consent_attested_at ? { consent_attested_at: current.consent_attested_at } : {}),
    ...(current?.qr_risk_acknowledged_at ? { qr_risk_acknowledged_at: current.qr_risk_acknowledged_at } : {}),
    ...(current?.delay_days !== undefined ? { delay_days: current.delay_days } : {}),
    ...(current?.review_url !== undefined ? { review_url: current.review_url } : {}),
  };
  if (key === "product_finder" && (next.questions ?? []).length < PROCEDURE_LIMITS.questionsMin) {
    next.questions = ["", ""];
  }
  if (key === "review_request" && next.delay_days === undefined) next.delay_days = 3;
  return next;
}

/** Keeps a trailing comma editable, and drops empty names once the list is finished. */
function servicesFromInput(raw: string): string[] {
  const endsWithComma = raw.trimEnd().endsWith(",");
  const items = raw
    .split(",")
    .map((item) => item.trim().slice(0, PROCEDURE_LIMITS.service))
    .filter((item) => item.length > 0)
    .slice(0, PROCEDURE_LIMITS.services);
  if (endsWithComma && items.length < PROCEDURE_LIMITS.services) items.push("");
  return items;
}

/** Name of a bound WooCommerce connector that cannot update orders, if any. */
function readOnlyBoundConnector(
  accountId: string,
  tools: AiAgentTool[],
  links: ToolAccountLink[],
  linksReady: boolean,
  bindings: Array<{ social_account_id: string; connector_id: string }> | undefined,
): string | null {
  if (!linksReady || !bindings) return null;
  const account: SharingAccount = { id: accountId, platform: "whatsapp", platform_username: null, platform_user_id: null };
  const bound = new Set(bindings.filter((row) => row.social_account_id === accountId).map((row) => row.connector_id));
  const names = tools.flatMap((tool) => {
    if (tool.connector_type !== "woocommerce" || !bound.has(tool.id) || tool.read_only_mode === false) return [];
    const visible = effectiveToolAccountIds(
      { id: tool.id, scope: tool.scope, social_account_id: tool.social_account_id },
      [account],
      links,
    ).includes(accountId);
    if (!visible) return [];
    const label = tool.name.trim();
    return [label || tool.id];
  });
  return names.length > 0 ? names.join(", ") : null;
}

function EventTemplateBadge({ accountId, flow }: { accountId: string; flow: EventProcedureKey }) {
  const { t } = useTranslation("agent");
  const [status, setStatus] = useState("missing");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void callMessagingApi("event_template_status", { social_account_id: accountId, flow })
      .then((data) => {
        const next = data && typeof data === "object" && typeof (data as { status?: unknown }).status === "string"
          ? (data as { status: string }).status
          : "missing";
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        if (!cancelled) setStatus("missing");
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, flow]);

  const submit = () => {
    setBusy(true);
    void callMessagingApi("event_template_status", { social_account_id: accountId, flow, create: true })
      .then((data) => {
        const next = data && typeof data === "object" && typeof (data as { status?: unknown }).status === "string"
          ? (data as { status: string }).status
          : "pending";
        setStatus(next);
      })
      .catch(() => setStatus("missing"))
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid={`template-status-${flow}`}>
      <Badge variant="outline">{t(`procedures.templateStatus.${status}`, status)}</Badge>
      {status !== "approved" && status !== "unsupported" && (
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={submit}>
          {t("procedures.submitTemplate", "Submit template")}
        </Button>
      )}
    </div>
  );
}

interface ProceduresCardProps extends BehaviorCardProps {
  /** The WhatsApp account being edited; store-event flows and the webhook section need it. */
  storeAccountId?: string | null;
  /** Cloud API and coexistence show template status. QR asks for the ban-risk acknowledgement. */
  connectionMode?: "cloud_api" | "coexistence" | "evolution_qr" | null;
}

export function ProceduresCard({
  form,
  behavior,
  updateBehavior,
  storeAccountId = null,
  connectionMode = null,
}: ProceduresCardProps) {
  const { t } = useTranslation("agent");
  const procedures = behavior.procedures ?? {};
  const [readOnlyConnector, setReadOnlyConnector] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Partial<Record<EventProcedureKey, EventEnableRefusal>>>({});
  const keys = storeAccountId ? PROCEDURE_KEYS : PROCEDURE_KEYS.filter((key) => !isEventProcedureKey(key));

  const write = (key: ProcedureKey, settings: ProcedureSettings) =>
    updateBehavior("procedures", { ...procedures, [key]: settings });

  const enableEvent = (key: EventProcedureKey, current: ProcedureSettings | undefined) => {
    const draft = blank(key, current);
    const blocked = eventEnableRefusal({
      key,
      agentEnabled: form.is_enabled === true,
      defaultMode: form.default_mode || "human_then_ai",
      connectionMode,
      wooReadOnly: readOnlyConnector !== null,
      consentAttested: Boolean(draft.consent_attested_at),
      qrRiskAcknowledged: Boolean(draft.qr_risk_acknowledged_at),
      delayDays: draft.delay_days ?? 3,
      reviewUrl: draft.review_url ?? "",
    });
    if (blocked) {
      setRefusal((prev) => ({ ...prev, [key]: blocked }));
      return;
    }
    setRefusal((prev) => ({ ...prev, [key]: undefined }));
    const stamped = new Date().toISOString();
    write(key, {
      ...draft,
      enabled: true,
      ...((key === "cod_confirm" || key === "review_request") && !draft.consent_attested_at
        ? { consent_attested_at: stamped }
        : {}),
      ...(connectionMode === "evolution_qr" && !draft.qr_risk_acknowledged_at
        ? { qr_risk_acknowledged_at: stamped }
        : {}),
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("procedures.title", "Guided flows")}</CardTitle>
        <CardDescription>
          {t(
            "procedures.description",
            "Fixed conversations the assistant can walk a customer through. Each one stays off until you turn it on.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {storeAccountId && <StoreEventData accountId={storeAccountId} onReadOnly={setReadOnlyConnector} />}
        {keys.map((key) => {
          const current = procedures[key];
          const enabled = current?.enabled ?? false;
          const name = t(`procedures.flows.${key}`, FLOW_NAMES[key]);
          const questions = current?.questions ?? ["", ""];
          const eventKey = isEventProcedureKey(key) ? key : null;
          const eventRefusal = eventKey ? refusal[eventKey] : undefined;
          return (
            <div key={key} className="space-y-3 rounded-md border p-3">
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor={`procedure-${key}`} className="font-normal">
                  {name}
                </Label>
                <Switch
                  id={`procedure-${key}`}
                  aria-label={name}
                  checked={enabled}
                  onCheckedChange={(checked) => {
                    if (!checked) {
                      write(key, { ...(current ?? { prompts: {}, closing: "" }), enabled: false });
                      if (eventKey) setRefusal((prev) => ({ ...prev, [eventKey]: undefined }));
                      return;
                    }
                    if (eventKey) {
                      enableEvent(eventKey, current);
                      return;
                    }
                    write(key, blank(key, current));
                  }}
                />
              </div>
              {eventRefusal && (
                <p className="text-xs text-destructive" role="alert">
                  {eventRefusal === "read_only"
                    ? t("procedures.refusal.read_only", {
                      defaultValue: REFUSAL_TEXT.read_only,
                      name: readOnlyConnector ?? "",
                    })
                    : t(`procedures.refusal.${eventRefusal}`, REFUSAL_TEXT[eventRefusal])}
                </p>
              )}
              {eventKey && storeAccountId && (
                <EventFlowFields
                  flow={eventKey}
                  accountId={storeAccountId}
                  connectionMode={connectionMode}
                  current={current}
                  onChange={(settings) => write(eventKey, settings)}
                />
              )}
              {enabled && current && (
                <>
                  {PROCEDURE_FIELDS[key].map((field) => (
                    <div key={field} className="space-y-2">
                      <Label htmlFor={`procedure-${key}-${field}`}>
                        {t(`procedures.fields.${field}`, `How to ask for ${field}`)}
                      </Label>
                      <Input
                        id={`procedure-${key}-${field}`}
                        maxLength={PROCEDURE_LIMITS.text}
                        value={current.prompts[field] ?? ""}
                        onChange={(event) =>
                          write(key, {
                            ...current,
                            prompts: { ...current.prompts, [field]: event.target.value },
                          })
                        }
                      />
                    </div>
                  ))}
                  {key === "product_finder" && (
                    <div className="space-y-2">
                      {questions.map((question, index) => (
                        <div key={index} className="flex items-start gap-2">
                          <div className="flex-1 space-y-2">
                            <Label htmlFor={`procedure-${key}-question-${index}`}>
                              {t("procedures.questionLabel", "Question {{n}}", { n: index + 1 })}
                            </Label>
                            <Input
                              id={`procedure-${key}-question-${index}`}
                              maxLength={PROCEDURE_LIMITS.text}
                              value={question}
                              onChange={(event) =>
                                write(key, {
                                  ...current,
                                  questions: questions.map((item, i) => (i === index ? event.target.value : item)),
                                })
                              }
                            />
                          </div>
                          {questions.length > PROCEDURE_LIMITS.questionsMin && (
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="mt-6"
                              aria-label={t("procedures.removeQuestion", "Remove question {{n}}", { n: index + 1 })}
                              onClick={() =>
                                write(key, {
                                  ...current,
                                  questions: questions.filter((_, i) => i !== index),
                                })
                              }
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      ))}
                      {questions.some((question) => question.trim() === "") && (
                        <p className="text-xs text-muted-foreground">
                          {t("procedures.questionsHint", "Fill in 2–3 questions")}
                        </p>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={questions.length >= PROCEDURE_LIMITS.questionsMax}
                        onClick={() => write(key, { ...current, questions: [...questions, ""] })}
                      >
                        <Plus className="me-1 h-4 w-4" /> {t("procedures.addQuestion", "Add a question")}
                      </Button>
                    </div>
                  )}
                  {key === "booking" && (
                    <div className="space-y-2">
                      <Label htmlFor={`procedure-${key}-services`}>
                        {t("procedures.services", "Services, separated by commas")}
                      </Label>
                      <Input
                        id={`procedure-${key}-services`}
                        maxLength={SERVICES_INPUT_MAX}
                        value={(current.services ?? []).join(", ")}
                        onChange={(event) =>
                          write(key, { ...current, services: servicesFromInput(event.target.value) })
                        }
                        onBlur={() => {
                          const cleaned = (current.services ?? []).map((item) => item.trim()).filter(Boolean);
                          if (cleaned.length !== (current.services ?? []).length) {
                            write(key, { ...current, services: cleaned });
                          }
                        }}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t("procedures.servicesHint", "Up to {{count}} services, {{length}} characters each.", {
                          count: PROCEDURE_LIMITS.services,
                          length: PROCEDURE_LIMITS.service,
                        })}
                      </p>
                    </div>
                  )}
                  <div className="space-y-2">
                    <Label htmlFor={`procedure-${key}-closing`}>{t("procedures.closing", "Closing line")}</Label>
                    <Textarea
                      id={`procedure-${key}-closing`}
                      maxLength={PROCEDURE_LIMITS.text}
                      rows={2}
                      value={current.closing}
                      placeholder={t("procedures.closingPlaceholder", "Thanks — I'll take it from here.")}
                      onChange={(event) => write(key, { ...current, closing: event.target.value })}
                    />
                  </div>
                </>
              )}
            </div>
          );
        })}
        {storeAccountId && <StoreWebhookSection accountId={storeAccountId} />}
      </CardContent>
    </Card>
  );
}

function StoreEventData({
  accountId,
  onReadOnly,
}: {
  accountId: string;
  onReadOnly: (connectorName: string | null) => void;
}) {
  const { tools } = useAiAgentTools();
  const { links, linksReady } = useAiToolAccountLinks();
  const { bindings } = useStoreWebhookBindings();
  useEffect(() => {
    onReadOnly(readOnlyBoundConnector(accountId, tools, links, linksReady, bindings));
  }, [accountId, tools, links, linksReady, bindings, onReadOnly]);
  return null;
}

function EventFlowFields({
  flow,
  accountId,
  connectionMode,
  current,
  onChange,
}: {
  flow: EventProcedureKey;
  accountId: string;
  connectionMode: "cloud_api" | "coexistence" | "evolution_qr" | null;
  current: ProcedureSettings | undefined;
  onChange: (settings: ProcedureSettings) => void;
}) {
  const { t } = useTranslation("agent");
  const base: ProcedureSettings = current ?? { enabled: false, prompts: {}, closing: "" };
  const stamp = (patch: Partial<ProcedureSettings>) => onChange({ ...base, ...patch });

  return (
    <div className="space-y-3">
      {(flow === "cod_confirm" || flow === "review_request") && (
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={Boolean(base.consent_attested_at)}
            onCheckedChange={(checked) => stamp({
              consent_attested_at: checked === true ? (base.consent_attested_at ?? new Date().toISOString()) : undefined,
              enabled: checked === true ? base.enabled : false,
            })}
            aria-label={t(
              "procedures.consent",
              "My checkout collects customer consent for WhatsApp order updates",
            )}
          />
          <span>{t("procedures.consent", "My checkout collects customer consent for WhatsApp order updates")}</span>
        </label>
      )}
      {connectionMode === "evolution_qr" && (
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={Boolean(base.qr_risk_acknowledged_at)}
            onCheckedChange={(checked) => stamp({
              qr_risk_acknowledged_at: checked === true ? (base.qr_risk_acknowledged_at ?? new Date().toISOString()) : undefined,
              enabled: checked === true ? base.enabled : false,
            })}
            aria-label={t(
              "procedures.qrRisk",
              "I understand WhatsApp may restrict numbers that send unsolicited messages",
            )}
          />
          <span>
            {t("procedures.qrRisk", "I understand WhatsApp may restrict numbers that send unsolicited messages")}
          </span>
        </label>
      )}
      {flow === "review_request" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="procedure-review-delay">{t("procedures.reviewDelay", "Days after delivery (0–14)")}</Label>
            <Input
              id="procedure-review-delay"
              type="number"
              min={0}
              max={14}
              value={base.delay_days ?? 3}
              onChange={(event) => {
                const parsed = Number(event.target.value);
                stamp({ delay_days: Number.isInteger(parsed) ? parsed : base.delay_days ?? 3 });
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="procedure-review-url">{t("procedures.reviewUrl", "Review link (https)")}</Label>
            <Input
              id="procedure-review-url"
              type="url"
              value={base.review_url ?? ""}
              placeholder="https://"
              onChange={(event) => stamp({ review_url: event.target.value })}
            />
          </div>
        </div>
      )}
      {showsEventTemplateStatus(connectionMode) && <EventTemplateBadge accountId={accountId} flow={flow} />}
    </div>
  );
}
