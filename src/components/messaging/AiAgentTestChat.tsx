import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n";
import { Bot, Loader2, Send, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { callEdgeApi } from "@/lib/messagingApi";
import { SavedTestsPanel } from "@/features/agent-tests";
import { type AiAgentPlatform } from "@/hooks/useAiAgentConfig";

interface TestTurn {
  role: "user" | "assistant";
  content: string;
  toolCalls?: string[];
  escalated?: boolean;
  skipped?: string;
}

// Sandbox chat against ai-agent-reply: real knowledge and tools, but nothing
// is sent to WhatsApp and escalation/notification side effects are stubbed.
export function AiAgentTestChat({
  platform,
  accountId,
}: {
  platform: AiAgentPlatform;
  // The account whose agent is under test. Its config and its knowledge are
  // what the sandbox exercises, and its own sandbox thread is what it writes
  // to -- without it every account on a platform shared one test history.
  accountId?: string | null;
}) {
  const { t } = useTranslation("agent");
  const [turns, setTurns] = useState<TestTurn[]>([]);
  const [input, setInput] = useState("");
  const [actAsAdmin, setActAsAdmin] = useState(false);
  const [sending, setSending] = useState(false);
  const [prefillMessage, setPrefillMessage] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  // Bumped on every account or platform change so a send started for the
  // previous chat cannot append its reply after the switch.
  const invocationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  // A saved case is one customer message. Switching account must not keep the
  // previous account's turns, or "Save as test" would file the wrong message.
  useEffect(() => {
    invocationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setTurns([]);
    setInput("");
    setPrefillMessage(null);
    setSending(false);
  }, [accountId, platform]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    const invocation = invocationRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setInput("");
    setTurns((current) => [...current, { role: "user", content: text }]);
    setSending(true);
    try {
      const data = await callEdgeApi("ai-agent-reply", "test", {
        platform,
        social_account_id: accountId ?? undefined,
        inbound_text: text,
        act_as_admin: actAsAdmin,
      }, { signal: controller.signal });
      if (invocationRef.current !== invocation) return;
      const turn: TestTurn = data.reply
        ? {
            role: "assistant",
            content: data.reply,
            toolCalls: (data.tool_calls || []).map((call: { name: string }) => call.name),
            escalated: data.escalated,
          }
        : { role: "assistant", content: "", skipped: data.skipped || data.error || t("test.fallbackNoReply", "no reply") };
      setTurns((current) => [...current, turn]);
    } catch (error) {
      if (invocationRef.current !== invocation) return;
      if (error instanceof Error && error.name === "AbortError") return;
      setTurns((current) => [
        ...current,
        { role: "assistant", content: "", skipped: error instanceof Error ? error.message : t("test.requestFailed", "Request failed") },
      ]);
    } finally {
      if (invocationRef.current === invocation) {
        setSending(false);
        setTimeout(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
      }
    }
  };

  return (
    <div className="space-y-4">
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>{t("test.title", "Test the agent")}</CardTitle>
            <CardDescription>
              {t("test.description", "Uses your real knowledge base and settings. Nothing is sent to customers.")}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            <Label htmlFor="act-as-admin" className="text-sm">{t("test.actAsAdmin", "Act as admin")}</Label>
            <Switch id="act-as-admin" checked={actAsAdmin} onCheckedChange={setActAsAdmin} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="max-h-96 min-h-40 space-y-3 overflow-y-auto rounded-md border p-3">
          {turns.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t("test.empty", "Send a message the way a customer would — in Arabic or English.")}
            </p>
          )}
          {turns.map((turn, index) => (
            <div key={index} className={turn.role === "user" ? "flex justify-end" : "flex justify-start"}>
              <div
                className={
                  turn.role === "user"
                    ? "max-w-[80%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground"
                    : "max-w-[80%] rounded-lg bg-muted px-3 py-2 text-sm"
                }
              >
                {turn.role === "assistant" && (
                  <div className="mb-1 flex flex-wrap items-center gap-1.5">
                    <Bot className="h-3.5 w-3.5 text-muted-foreground" />
                    {(turn.toolCalls || []).map((name, toolIndex) => (
                      <Badge key={toolIndex} variant="outline" className="text-[10px]">{name}</Badge>
                    ))}
                    {turn.escalated && <Badge variant="secondary" className="text-[10px]">{t("test.escalated", "escalated")}</Badge>}
                  </div>
                )}
                {turn.skipped ? (
                  <span className="italic text-muted-foreground">{t("test.noReply", "No reply — {{reason}}", { reason: turn.skipped })}</span>
                ) : (
                  <span className="whitespace-pre-wrap">{turn.content}</span>
                )}
                {turn.role === "assistant" && (
                  <div className="mt-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const customer = turns.slice(0, index).reverse().find((item) => item.role === "user");
                        if (customer) setPrefillMessage(customer.content);
                      }}
                    >
                      {t("test.saved.saveAsTest", "Save as test")}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ))}
          {sending && (
            <div className="flex justify-start">
              <div className="rounded-lg bg-muted px-3 py-2">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>
        <div className="flex gap-2">
          <Input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                send();
              }
            }}
            placeholder={t("test.placeholder", "e.g. كم سعر التوصيل؟ or How much is delivery?")}
            disabled={sending}
          />
          <Button onClick={send} disabled={sending || !input.trim()}>
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
    <SavedTestsPanel
      platform={platform}
      accountId={accountId}
      prefillMessage={prefillMessage}
      onPrefillHandled={() => setPrefillMessage(null)}
    />
    </div>
  );
}
