import { useTranslation } from "react-i18next";
import type { WhatsAppSetupSummary } from "@/hooks/useWhatsAppSetupSummary";

// One line per attached capability, in the same order the summary RPC builds them,
// so the disconnect dialogs read like the database's own inventory.
const SUMMARY_LINES: Array<{
  key: keyof Omit<WhatsAppSetupSummary, "automation_handlers">;
  fallback: string;
}> = [
  { key: "agent_config", fallback: "AI agent settings" },
  { key: "connectors", fallback: "{{count}} connector" },
  { key: "connector_links", fallback: "{{count}} linked connector" },
  { key: "store_bindings", fallback: "{{count}} store webhook" },
  { key: "knowledge_sources", fallback: "{{count}} knowledge sources" },
  { key: "test_cases", fallback: "{{count}} test case" },
  { key: "waitlist", fallback: "{{count}} waitlist entry" },
  { key: "templates", fallback: "{{count}} message template" },
  { key: "partner_keys_primary", fallback: "{{count}} partner API key" },
  { key: "partner_key_links", fallback: "{{count}} linked partner key" },
  { key: "partner_webhooks", fallback: "{{count}} partner webhook" },
  { key: "n8n_subscriptions", fallback: "{{count}} n8n automation" },
  { key: "scheduled_messages", fallback: "{{count}} scheduled message" },
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
          {t(`summary.${line.key}`, line.fallback, { count: summary[line.key] })}
        </li>
      ))}
      {hasAutomation && (
        <li>{t("summary.automation_handlers", "Automation settings")}</li>
      )}
    </ul>
  );
}
