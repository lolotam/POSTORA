import { useTranslation } from "react-i18next";
import "@/i18n";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  isEventProcedureKey,
  PROCEDURE_FIELDS,
  PROCEDURE_KEYS,
  PROCEDURE_LIMITS,
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

/** Store-event flows have no toggle yet: the server refuses them on save (Spec B PR 1). */
const CARD_KEYS = PROCEDURE_KEYS.filter((key) => !isEventProcedureKey(key));

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
  };
  if (key === "product_finder" && (next.questions ?? []).length < PROCEDURE_LIMITS.questionsMin) {
    next.questions = ["", ""];
  }
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

interface ProceduresCardProps extends BehaviorCardProps {
  /** The WhatsApp account being edited; the store-events section needs it. */
  storeAccountId?: string | null;
}

export function ProceduresCard({ behavior, updateBehavior, storeAccountId = null }: ProceduresCardProps) {
  const { t } = useTranslation("agent");
  const procedures = behavior.procedures ?? {};

  const write = (key: ProcedureKey, settings: ProcedureSettings) =>
    updateBehavior("procedures", { ...procedures, [key]: settings });

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
        {CARD_KEYS.map((key) => {
          const current = procedures[key];
          const enabled = current?.enabled ?? false;
          const name = t(`procedures.flows.${key}`, FLOW_NAMES[key]);
          const questions = current?.questions ?? ["", ""];
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
                      return;
                    }
                    write(key, blank(key, current));
                  }}
                />
              </div>
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
