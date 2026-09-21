import { useMemo, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSocialAccounts } from "@/hooks/useSocialAccounts";
import {
  useAutomationHandlers,
  type CommentAutomationHandler,
  type MessageAutomationHandler,
  type MediaUnderstandingMode,
} from "@/hooks/useAutomationHandlers";

interface AutomationHandlerCardProps {
  platform: "facebook" | "instagram" | "threads" | "youtube" | "whatsapp";
  // When the host page already owns an account selection, pass it in so a handler change
  // can never be saved against a different account than the one on screen.
  accountId?: string | null;
  surface?: "dms" | "comments" | "both";
}

interface HandlerOption {
  value: string;
  label: string;
  disabled?: boolean;
  hint?: string;
}

// Which agent answers this account. Messages and comments are chosen separately, and each is
// a single-choice dropdown rather than a set of toggles so two agents can never answer the
// same item.
export function AutomationHandlerCard({
  platform,
  accountId: controlledAccountId,
  surface = "both",
}: AutomationHandlerCardProps) {
  const { t } = useTranslation("inbox");
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
  // A rejected save used to be invisible: the Select snapped back to the stored value and
  // nothing said why, which read as "the dropdown refuses to change".
  const saveHandlers = (patch: Parameters<typeof save.mutate>[0]) =>
    save.mutate(patch, {
      onError: (error) =>
        toast.error(t("handler.changeFailed", "Could not change the automation handler"), {
          description: error instanceof Error ? error.message : t("errors.unknown", "Unknown error"),
        }),
    });

  const messageOptions: HandlerOption[] = [
    { value: "off", label: t("handler.offDisabled", "Off (Disabled)") },
    { value: "internal", label: t("handler.internal", "Postora AI Agent") },
    { value: "n8n", label: t("handler.n8nWorkflow", "n8n Workflow") },
  ];

  // Voice notes, photos and PDFs a customer sends are only read when this is on. It
  // costs money per inbound item, so "off" is the default and the labels say what
  // each level actually spends on. Until this existed the mode could only be set by
  // editing account_metadata by hand, and a QR re-pair silently lost it.
  const mediaUnderstandingOptions: HandlerOption[] = [
    { value: "off", label: t("handler.mediaOff", "Off — media is not read") },
    { value: "audio", label: t("handler.audio", "Voice notes only") },
    { value: "audio+image", label: t("handler.audioImage", "Voice notes and images") },
    { value: "audio+image+document", label: t("handler.audioImageDoc", "Voice notes, images and documents") },
  ];

  const commentOptions: HandlerOption[] = [
    { value: "off", label: t("handler.off", "Off") },
    { value: "internal", label: t("handler.internal", "Postora AI Agent") },
    { value: "n8n", label: t("handler.n8n", "n8n") },
  ];

  if (accounts.length === 0) return null;

  const busy = isLoading || save.isPending;
  // YouTube has no inbox, so its Messages handler would configure nothing.
  const showMessages = (surface === "dms" || surface === "both") && platform !== "youtube";
  const showComments = (surface === "comments" || surface === "both") && platform !== "whatsapp";

  const description =
    platform === "whatsapp"
      ? t("handler.descWhatsApp", "Choose which engine automatically answers incoming messages for this account: the Postora AI Agent, an external n8n workflow, or nobody (Off).")
      : platform === "youtube"
      ? t("handler.descYouTube", "Chooses which agent replies to comments on this channel's videos. Choosing n8n requires a Postora Trigger workflow in n8n.")
      : t("handler.descDefault", "Chooses which agent replies. Choosing n8n requires a Postora Comment Trigger (or Postora Trigger) workflow in n8n.");

  return (
    <Card className="mb-4">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t("handler.title", "Automation Handler")}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!isControlled && accounts.length > 1 && (
          <Select value={accountId ?? ""} onValueChange={setSelectedId}>
            <SelectTrigger className="w-full max-w-xs" data-testid="automation-account">
              <SelectValue placeholder={t("accounts.selectAccount", "Select account")} />
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

        {showMessages && (
          <HandlerRow
            label={t("handler.incoming", "Incoming Messages")}
            testId="messages-handler"
            value={handlers?.automation_handler ?? "internal"}
            options={messageOptions}
            disabled={busy}
            onChange={(value) => saveHandlers({ automation_handler: value as MessageAutomationHandler })}
          />
        )}

        {showComments && (
          <HandlerRow
            label={t("handler.comments", "Comments")}
            testId="comments-handler"
            value={handlers?.comment_automation_handler ?? "off"}
            options={commentOptions}
            disabled={busy}
            onChange={(value) => saveHandlers({ comment_automation_handler: value as CommentAutomationHandler })}
          />
        )}

        <HandlerRow
          label={t("handler.understandMedia", "Understand media")}
          testId="media-understanding"
          value={handlers?.media_understanding ?? "off"}
          options={mediaUnderstandingOptions}
          disabled={busy}
          onChange={(value) => saveHandlers({ media_understanding: value as MediaUnderstandingMode })}
        />

        {platform === "whatsapp" ? (
          // WhatsApp routes each inbound message to exactly one handler: on "Postora AI Agent"
          // no n8n webhook fires, and on "n8n Workflow" the internal agent never answers.
          <p className="text-xs text-muted-foreground">
            <Trans
              ns="inbox"
              i18nKey="handler.onlySelected"
              components={{ strong: <strong /> }}
            >
              Incoming messages reach only the handler selected here. <strong>Postora AI Agent</strong>{" "}
              answers from Postora and needs the AI agent enabled below.{" "}
              <strong>n8n Workflow</strong> sends the message to your subscribed n8n workflows
              instead, and Postora itself sends no reply.
            </Trans>
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {t("handler.reachN8n", "Comments reach n8n only while Comments is set to n8n.")}
              {showMessages && (
                <>
                  {" "}{t("handler.messagesAlsoN8n", "Messages are always sent to any subscribed n8n workflow so it can log or route them; this setting decides whether the Postora AI agent also replies.")}
                </>
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              <Trans
                ns="inbox"
                i18nKey="handler.commentsPublic"
                components={{ strong: <strong /> }}
              >
                Postora AI Agent on Comments replies <strong>publicly</strong>, using your Auto Replies
                rules first and the AI agent for anything they do not match. Away rules post at most
                once per post per day.
              </Trans>
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
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <span className="text-sm font-medium">{label}</span>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className="w-full sm:w-48" data-testid={testId}>
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
