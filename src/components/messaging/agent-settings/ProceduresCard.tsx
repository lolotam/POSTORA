import { useCallback, useEffect, useRef, useState } from "react";
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

type CodAccess =
  | { state: "unresolved"; reason: "loading" | "error" }
  | { state: "read_only"; name: string }
  | { state: "writable" };

function codAccessEqual(prev: CodAccess, next: CodAccess): boolean {
  if (prev.state !== next.state) return false;
  if (prev.state === "unresolved" && next.state === "unresolved") return prev.reason === next.reason;
  return prev.state !== "read_only" || next.state !== "read_only" || prev.name === next.name;
}

/**
 * The read-only decision reads three queries: connector tools, the account
 * links those tools are shared through, and the store-webhook bindings.
 * Any one of them still loading or failed is unresolved. An empty successful
 * read is a real answer; it is the only shape that may enable the toggle.
 */
function resolveCodAccess(input: {
  accountId: string;
  tools: AiAgentTool[];
  toolsLoading: boolean;
  toolsError: unknown;
  links: ToolAccountLink[];
  linksReady: boolean;
  linksError: unknown;
  bindings: Array<{ social_account_id: string; connector_id: string }> | undefined;
  bindingsLoading: boolean;
  bindingsError: boolean;
}): CodAccess {
  if (input.toolsError || input.linksError || input.bindingsError) return { state: "unresolved", reason: "error" };
  if (input.toolsLoading || !input.linksReady || input.bindingsLoading || !input.bindings) {
    return { state: "unresolved", reason: "loading" };
  }
  const name = readOnlyBoundConnector(input.accountId, input.tools, input.links, true, input.bindings);
  return name ? { state: "read_only", name } : { state: "writable" };
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

function readTemplateStatus(data: unknown): string | null {
  if (!data || typeof data !== "object" || !("status" in data)) return null;
  const status = (data as { status?: unknown }).status;
  return typeof status === "string" && status.length > 0 ? status : null;
}

/** A created template can be pending review or already approved. Anything else leaves the flow off. */
function templateAllowsEnable(status: string): boolean {
  return status === "pending" || status === "approved";
}

function EventTemplateBadge({
  accountId,
  flow,
  pinnedStatus,
}: {
  accountId: string;
  flow: EventProcedureKey;
  pinnedStatus?: string;
}) {
  const { t } = useTranslation("agent");
  const [status, setStatus] = useState(pinnedStatus ?? "missing");
  const [busy, setBusy] = useState(false);
  const accountIdRef = useRef(accountId);
  accountIdRef.current = accountId;

  useEffect(() => {
    if (pinnedStatus) {
      setStatus(pinnedStatus);
      setBusy(false);
      return;
    }
    let cancelled = false;
    setBusy(true);
    void callMessagingApi("event_template_status", { social_account_id: accountId, flow })
      .then((data) => {
        if (!cancelled) setStatus(readTemplateStatus(data) ?? "missing");
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
  }, [accountId, flow, pinnedStatus]);

  const submit = () => {
    const forAccount = accountId;
    setBusy(true);
    void callMessagingApi("event_template_status", { social_account_id: forAccount, flow, create: true })
      .then((data) => {
        if (accountIdRef.current !== forAccount) return;
        setStatus(readTemplateStatus(data) ?? "pending");
      })
      .catch(() => {
        if (accountIdRef.current !== forAccount) return;
        setStatus("missing");
      })
      .finally(() => {
        if (accountIdRef.current === forAccount) setBusy(false);
      });
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
  const proceduresRef = useRef(procedures);
  proceduresRef.current = procedures;
  const storeAccountRef = useRef(storeAccountId);
  storeAccountRef.current = storeAccountId;
  const [codAccess, setCodAccess] = useState<CodAccess>({ state: "unresolved", reason: "loading" });
  const reportCodAccess = useCallback((next: CodAccess) => {
    setCodAccess((prev) => codAccessEqual(prev, next) ? prev : next);
  }, []);
  const retryCodCheck = useRef<() => void>(() => {});
  const rememberCodRetry = useCallback((retry: () => void) => {
    retryCodCheck.current = retry;
  }, []);
  const [refusal, setRefusal] = useState<Partial<Record<EventProcedureKey, EventEnableRefusal>>>({});
  const [templateFailed, setTemplateFailed] = useState<Partial<Record<EventProcedureKey, boolean>>>({});
  const [templateBusy, setTemplateBusy] = useState<Partial<Record<EventProcedureKey, boolean>>>({});
  const [submittedStatus, setSubmittedStatus] = useState<Partial<Record<EventProcedureKey, string>>>({});
  const enableGeneration = useRef<Partial<Record<EventProcedureKey, number>>>({});
  useEffect(() => {
    enableGeneration.current = {};
    setTemplateBusy({});
    setTemplateFailed({});
    setSubmittedStatus({});
    setRefusal({});
  }, [storeAccountId]);
  const keys = storeAccountId ? PROCEDURE_KEYS : PROCEDURE_KEYS.filter((key) => !isEventProcedureKey(key));

  const write = (key: ProcedureKey, settings: ProcedureSettings) =>
    updateBehavior("procedures", { ...proceduresRef.current, [key]: settings });

  const enableEvent = (key: EventProcedureKey, current: ProcedureSettings | undefined) => {
    const draft = blank(key, current);
    const blocked = eventEnableRefusal({
      key,
      agentEnabled: form.is_enabled === true,
      defaultMode: form.default_mode || "human_then_ai",
      connectionMode,
      wooReadOnly: codAccess.state === "read_only",
      consentAttested: Boolean(draft.consent_attested_at),
      qrRiskAcknowledged: Boolean(draft.qr_risk_acknowledged_at),
      delayDays: draft.delay_days ?? 3,
      reviewUrl: draft.review_url ?? "",
    });
    if (key === "cod_confirm" && codAccess.state === "unresolved") return;
    if (blocked) {
      setTemplateFailed((prev) => ({ ...prev, [key]: false }));
      setRefusal((prev) => ({ ...prev, [key]: blocked }));
      return;
    }
    const stamped = new Date().toISOString();
    const enabledSettings: ProcedureSettings = {
      ...draft,
      enabled: true,
      ...((key === "cod_confirm" || key === "review_request") && !draft.consent_attested_at
        ? { consent_attested_at: stamped }
        : {}),
      ...(connectionMode === "evolution_qr" && !draft.qr_risk_acknowledged_at
        ? { qr_risk_acknowledged_at: stamped }
        : {}),
    };
    const attempt = (enableGeneration.current[key] ?? 0) + 1;
    enableGeneration.current[key] = attempt;
    const stillCurrent = () => enableGeneration.current[key] === attempt;

    if (!showsEventTemplateStatus(connectionMode)) {
      setTemplateFailed((prev) => ({ ...prev, [key]: false }));
      setRefusal((prev) => ({ ...prev, [key]: undefined }));
      write(key, enabledSettings);
      return;
    }

    if (!storeAccountId) {
      setRefusal((prev) => ({ ...prev, [key]: undefined }));
      setTemplateFailed((prev) => ({ ...prev, [key]: true }));
      return;
    }

    const requestedAccount = storeAccountId;
    const sameAccount = () => stillCurrent() && storeAccountRef.current === requestedAccount;
    setRefusal((prev) => ({ ...prev, [key]: undefined }));
    setTemplateFailed((prev) => ({ ...prev, [key]: false }));
    setTemplateBusy((prev) => ({ ...prev, [key]: true }));
    void callMessagingApi("event_template_status", {
      social_account_id: requestedAccount,
      flow: key,
      create: true,
    })
      .then((data) => {
        if (!sameAccount()) return;
        const status = readTemplateStatus(data);
        if (!status || !templateAllowsEnable(status)) {
          setTemplateFailed((prev) => ({ ...prev, [key]: true }));
          return;
        }
        setSubmittedStatus((prev) => ({ ...prev, [key]: status }));
        setTemplateFailed((prev) => ({ ...prev, [key]: false }));
        write(key, enabledSettings);
      })
      .catch(() => {
        if (!sameAccount()) return;
        setTemplateFailed((prev) => ({ ...prev, [key]: true }));
      })
      .finally(() => {
        if (sameAccount()) setTemplateBusy((prev) => ({ ...prev, [key]: false }));
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
        {storeAccountId && (
          <StoreEventData accountId={storeAccountId} onAccess={reportCodAccess} onRetry={rememberCodRetry} />
        )}
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
                  disabled={
                    (key === "cod_confirm" && codAccess.state === "unresolved")
                    || (eventKey ? templateBusy[eventKey] === true : false)
                  }
                  onCheckedChange={(checked) => {
                    if (key === "cod_confirm" && checked && codAccess.state === "unresolved") return;
                    if (!checked) {
                      write(key, { ...(current ?? { prompts: {}, closing: "" }), enabled: false });
                      if (eventKey) {
                        enableGeneration.current[eventKey] = (enableGeneration.current[eventKey] ?? 0) + 1;
                        setRefusal((prev) => ({ ...prev, [eventKey]: undefined }));
                        setTemplateFailed((prev) => ({ ...prev, [eventKey]: false }));
                        setTemplateBusy((prev) => ({ ...prev, [eventKey]: false }));
                      }
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
                      name: codAccess.state === "read_only" ? codAccess.name : "",
                    })
                    : t(`procedures.refusal.${eventRefusal}`, REFUSAL_TEXT[eventRefusal])}
                </p>
              )}
              {!eventRefusal && eventKey && templateFailed[eventKey] && (
                <p className="text-xs text-destructive" role="alert">
                  {t(
                    "procedures.templateSubmitFailed",
                    "The WhatsApp template could not be submitted, so this flow stays off.",
                  )}
                </p>
              )}
              {key === "cod_confirm" && codAccess.state === "unresolved" && codAccess.reason === "loading" && (
                <p className="text-xs text-muted-foreground">
                  {t("procedures.codChecking", "Checking whether this store can update orders.")}
                </p>
              )}
              {key === "cod_confirm" && codAccess.state === "unresolved" && codAccess.reason === "error" && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-destructive" role="alert">
                  <span>
                    {t(
                      "procedures.codCheckFailed",
                      "The store connection could not be checked. Retry, then turn COD confirmation on.",
                    )}
                  </span>
                  <Button type="button" variant="outline" size="sm" onClick={() => retryCodCheck.current()}>
                    {t("procedures.retry", "Retry")}
                  </Button>
                </div>
              )}
              {eventKey && storeAccountId && (
                <EventFlowFields
                  flow={eventKey}
                  accountId={storeAccountId}
                  connectionMode={connectionMode}
                  current={current}
                  onChange={(settings) => write(eventKey, settings)}
                  pinnedStatus={submittedStatus[eventKey]}
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
  onAccess,
  onRetry,
}: {
  accountId: string;
  onAccess: (access: CodAccess) => void;
  onRetry: (retry: () => void) => void;
}) {
  const { tools, isLoading: toolsLoading, isError: toolsError, refetch: refetchTools } = useAiAgentTools();
  const { links, linksReady, linksError, refetchLinks } = useAiToolAccountLinks();
  const { bindings, isLoading, isError, refetch } = useStoreWebhookBindings();
  useEffect(() => {
    onAccess(resolveCodAccess({
      accountId,
      tools,
      toolsLoading,
      toolsError,
      links,
      linksReady,
      linksError,
      bindings,
      bindingsLoading: isLoading,
      bindingsError: isError,
    }));
  }, [accountId, tools, toolsLoading, toolsError, links, linksReady, linksError, bindings, isLoading, isError, onAccess]);
  useEffect(() => {
    onRetry(() => {
      void refetchTools();
      void refetchLinks();
      void refetch();
    });
  }, [onRetry, refetch, refetchLinks, refetchTools]);
  return null;
}

function EventFlowFields({
  flow,
  accountId,
  connectionMode,
  current,
  onChange,
  pinnedStatus,
}: {
  flow: EventProcedureKey;
  accountId: string;
  connectionMode: "cloud_api" | "coexistence" | "evolution_qr" | null;
  current: ProcedureSettings | undefined;
  onChange: (settings: ProcedureSettings) => void;
  pinnedStatus?: string;
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
      {showsEventTemplateStatus(connectionMode) && (
        <EventTemplateBadge accountId={accountId} flow={flow} pinnedStatus={pinnedStatus} />
      )}
    </div>
  );
}
