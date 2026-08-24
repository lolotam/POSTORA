import { useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSocialAccounts } from "@/hooks/useSocialAccounts";
import {
  useAutomationHandlers,
  type CommentAutomationHandler,
  type MessageAutomationHandler,
} from "@/hooks/useAutomationHandlers";

interface AutomationHandlerCardProps {
  platform: "facebook" | "instagram" | "threads" | "whatsapp";
  // When the host page already owns an account selection, pass it in so a handler change
  // can never be saved against a different account than the one on screen.
  accountId?: string | null;
}

interface HandlerOption {
  value: string;
  label: string;
  disabled?: boolean;
  hint?: string;
}

const MESSAGE_OPTIONS: HandlerOption[] = [
  { value: "off", label: "Off (Disabled)" },
  { value: "internal", label: "Postora AI Agent" },
  { value: "n8n", label: "n8n Workflow" },
];

const COMMENT_OPTIONS: HandlerOption[] = [
  { value: "off", label: "Off" },
  { value: "internal", label: "Postora AI Agent" },
  { value: "n8n", label: "n8n" },
];

// Which agent answers this account. Messages and comments are chosen separately, and each is
// a single-choice dropdown rather than a set of toggles so two agents can never answer the
// same item.
export function AutomationHandlerCard({ platform, accountId: controlledAccountId }: AutomationHandlerCardProps) {
  const { data: socialAccounts = [] } = useSocialAccounts();
  const accounts = useMemo(
    () => socialAccounts.filter((account) => account.platform === platform && account.is_active),
    [socialAccounts, platform],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const isControlled = controlledAccountId !== undefined;
  const ownAccountId = selectedId && accounts.some((account) => account.id === selectedId)
    ? selectedId
    : accounts[0]?.id ?? null;
  const accountId = isControlled ? controlledAccountId : ownAccountId;

  const { handlers, isLoading, save } = useAutomationHandlers(accountId);

  if (accounts.length === 0) return null;

  const busy = isLoading || save.isPending;

  return (
    <Card className="mb-4">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Automation Handler</CardTitle>
        <CardDescription>
          {platform === "whatsapp"
            ? "Choose which engine automatically answers incoming messages for this account: the Postora AI Agent, an external n8n workflow, or nobody (Off)."
            : "Chooses which agent replies. Choosing n8n requires a Postora Comment Trigger (or Postora Trigger) workflow in n8n."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!isControlled && accounts.length > 1 && (
          <Select value={accountId ?? ""} onValueChange={setSelectedId}>
            <SelectTrigger className="w-full max-w-xs" data-testid="automation-account">
              <SelectValue placeholder="Select account" />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {account.platform_username || account.platform_user_id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {platform !== "threads" && (
          <HandlerRow
            label="Incoming Messages"
            testId="messages-handler"
            value={handlers?.automation_handler ?? "internal"}
            options={MESSAGE_OPTIONS}
            disabled={busy}
            onChange={(value) => save.mutate({ automation_handler: value as MessageAutomationHandler })}
          />
        )}

        {platform !== "whatsapp" && (
          <HandlerRow
            label="Comments"
            testId="comments-handler"
            value={handlers?.comment_automation_handler ?? "off"}
            options={COMMENT_OPTIONS}
            disabled={busy}
            onChange={(value) => save.mutate({ comment_automation_handler: value as CommentAutomationHandler })}
          />
        )}

        {platform === "whatsapp" ? (
          // WhatsApp routes each inbound message to exactly one handler: on "Postora AI Agent"
          // no n8n webhook fires, and on "n8n Workflow" the internal agent never answers.
          <p className="text-xs text-muted-foreground">
            Incoming messages reach only the handler selected here. <strong>Postora AI Agent</strong>{" "}
            answers from Postora and needs the AI agent enabled below.{" "}
            <strong>n8n Workflow</strong> sends the message to your subscribed n8n workflows
            instead, and Postora itself sends no reply.
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Comments reach n8n only while Comments is set to n8n. Messages are always sent to any
              subscribed n8n workflow so it can log or route them; this setting decides whether the
              Postora AI agent also replies.
            </p>
            <p className="text-xs text-muted-foreground">
              Postora AI Agent on Comments replies <strong>publicly</strong>, using your Auto Replies
              rules first and the AI agent for anything they do not match. Away rules post at most
              once per post per day.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

interface HandlerRowProps {
  label: string;
  testId: string;
  value: string;
  options: HandlerOption[];
  disabled: boolean;
  onChange: (value: string) => void;
}

function HandlerRow({ label, testId, value, options, disabled, onChange }: HandlerRowProps) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm font-medium">{label}</span>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className="w-48" data-testid={testId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
              {option.hint ? `${option.label} — ${option.hint}` : option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
