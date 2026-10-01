import { useTranslation } from "react-i18next";
import type { WhatsAppSetupSummary } from "@/hooks/useWhatsAppSetupSummary";

// One line per attached capability, in the same order the summary RPC builds them,
// so the disconnect dialogs read like the database's own inventory. `one`/`other` are
// i18next plural defaults for English; the Arabic bundle carries its own six forms.
const SUMMARY_LINES: Array<{
  key: keyof Omit<WhatsAppSetupSummary, "automation_handlers">;
  fallback: string;
  one: string;
  other: string;
}> = [
  { key: "agent_config", fallback: "AI agent settings", one: "AI agent settings", other: "AI agent settings" },
  { key: "connectors", fallback: "{{count}} connector", one: "{{count}} connector", other: "{{count}} connectors" },
  { key: "connector_links", fallback: "{{count}} linked connector", one: "{{count}} linked connector", other: "{{count}} linked connectors" },
  { key: "store_bindings", fallback: "{{count}} store webhook", one: "{{count}} store webhook", other: "{{count}} store webhooks" },
  { key: "knowledge_sources", fallback: "{{count}} knowledge sources", one: "{{count}} knowledge source", other: "{{count}} knowledge sources" },
  { key: "test_cases", fallback: "{{count}} test case", one: "{{count}} test case", other: "{{count}} test cases" },
  { key: "waitlist", fallback: "{{count}} waitlist entry", one: "{{count}} waitlist entry", other: "{{count}} waitlist entries" },
  { key: "templates", fallback: "{{count}} message template", one: "{{count}} message template", other: "{{count}} message templates" },
  { key: "partner_keys_primary", fallback: "{{count}} partner API key", one: "{{count}} partner API key", other: "{{count}} partner API keys" },
  { key: "partner_key_links", fallback: "{{count}} linked partner key", one: "{{count}} linked partner key", other: "{{count}} linked partner keys" },
  { key: "partner_webhooks", fallback: "{{count}} partner webhook", one: "{{count}} partner webhook", other: "{{count}} partner webhooks" },
  { key: "n8n_subscriptions", fallback: "{{count}} n8n automation", one: "{{count}} n8n automation", other: "{{count}} n8n automations" },
  { key: "scheduled_messages", fallback: "{{count}} scheduled message", one: "{{count}} scheduled message", other: "{{count}} scheduled messages" },
];

interface AccountSetupSummaryListProps {
  summary: WhatsAppSetupSummary | null | undefined;
}

export function AccountSetupSummaryList({ summary }: AccountSetupSummaryListProps) {
  const { t } = useTranslation("whatsapp");
  if (!summary) return null;

  const lines = SUMMARY_LINES.filter((line) => (summary[line.key] ?? 0) > 0);
  const hasAutomation = (summary.automation_handlers?.length ?? 0) > 0;
  if (lines.length === 0 && !hasAutomation) return null;

  return (
    <ul className="list-disc space-y-1 ps-5 text-sm">
      {lines.map((line) => (
        <li key={line.key}>
          {t(`summary.${line.key}`, line.fallback, {
            count: summary[line.key],
            defaultValue_one: line.one,
            defaultValue_other: line.other,
          })}
        </li>
      ))}
      {hasAutomation && (
        <li>{t("summary.automation_handlers", "Automation settings")}</li>
      )}
    </ul>
  );
}
