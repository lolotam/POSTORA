import { useEffect, useMemo, useState } from "react";
import { Bot, Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { type AiAgentConfigInput, type AiAgentLanguageMode, type AiAgentMode, type AiAgentPlatform, useAiAgentConfig } from "@/hooks/useAiAgentConfig";
import { useSocialAccounts } from "@/hooks/useSocialAccounts";
import { normalizeE164Phone } from "@/lib/phone";
import { AutomationHandlerCard } from "@/components/messaging/AutomationHandlerCard";
import { AutoReplyManager } from "@/components/messaging/AutoReplyManager";
import { AiKnowledgeManager } from "@/components/messaging/AiKnowledgeManager";
import { AiAgentLogsView } from "@/components/messaging/AiAgentLogsView";
import { AiAgentTestChat } from "@/components/messaging/AiAgentTestChat";
import { DatabaseConnectorsManager } from "@/components/automation/DatabaseConnectorsManager";

const defaultConfig: Required<Pick<AiAgentConfigInput,
  "is_enabled" | "default_mode" | "language_mode" | "daily_message_cap" | "reply_cooldown_seconds"
>> & AiAgentConfigInput = {
  is_enabled: false,
  default_mode: "human_then_ai",
  language_mode: "auto",
  daily_message_cap: 50,
  reply_cooldown_seconds: 0,
  persona_instructions: "",
  business_profile_text: "",
  admin_phone_numbers: [],
};

const modeDescriptions: Record<AiAgentMode, string> = {
  ai_first: "The assistant replies first and hands off when needed.",
  human_first: "A team member replies first; the assistant stays on standby.",
  human_then_ai: "A team member gets the first chance, then AI handles the fallback.",
};

export const AI_AGENT_TABS = ["settings", "knowledge", "tools", "test", "logs"] as const;
export type AiAgentTab = (typeof AI_AGENT_TABS)[number];

interface AiAgentManagerProps {
  platform?: AiAgentPlatform;
  /** When provided (with onTabChange), the tab bar is URL-controlled for deep links. */
  activeTab?: AiAgentTab;
  onTabChange?: (tab: AiAgentTab) => void;
  surface?: "dms" | "comments" | "both";
}

export function AiAgentManager({ platform = "whatsapp", activeTab, onTabChange, surface = "both" }: AiAgentManagerProps = {}) {
  const { data: socialAccounts = [] } = useSocialAccounts();
  // Same selection pattern as AutomationHandlerCard: the first active account
  // on the platform until the user chooses, and never an id that is not in
  // the list (a disconnected account must deselect itself, not linger).
  const accounts = useMemo(
    () => socialAccounts.filter((account) => account.platform === platform && account.is_active),
    [socialAccounts, platform],
  );
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const accountId = selectedAccountId && accounts.some((account) => account.id === selectedAccountId)
    ? selectedAccountId
    : accounts[0]?.id ?? null;

  const { config, isLoading, error, upsertConfig } = useAiAgentConfig(platform, accountId);
  const [form, setForm] = useState<AiAgentConfigInput>(defaultConfig);
  const [phoneInput, setPhoneInput] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);

  // The form must refuse to submit a config it never loaded. On 2026-08-28 a
  // read that returned nothing rendered a blank form whose Save then wrote
  // the blank defaults over a live persona. `config` is undefined until a
  // read settles -- null means "no config yet", which is a legitimate save
  // that creates the first one -- so while it is undefined Save stays
  // disabled and says why.
  // `error` is checked too: React Query keeps the previously cached data when a
  // refetch fails, so config alone can be a stale account's config while the
  // read for THIS one errored -- Save would then write it to the wrong account.
  const configLoaded = config !== undefined && !error;

  useEffect(() => {
    // A settled null is "this account has no config yet", and the form must
    // show that rather than whatever the previously selected account had in
    // it. Returning early here let account A's persona sit in the fields
    // while account B was selected -- and since null counts as loaded, Save
    // was enabled and would have written A's brand voice into B.
    if (config === null) {
      setForm(defaultConfig);
      return;
    }
    if (!config) return;
    setForm({
      is_enabled: config.is_enabled,
      default_mode: config.default_mode,
      persona_instructions: config.persona_instructions || "",
      business_profile_text: config.business_profile_text || "",
      language_mode: config.language_mode,
      temperature: config.temperature,
      admin_phone_numbers: config.admin_phone_numbers || [],
      daily_message_cap: config.daily_message_cap,
      reply_cooldown_seconds: config.reply_cooldown_seconds,
      max_tool_iterations: config.max_tool_iterations,
      handoff_on_request: config.handoff_on_request,
      handoff_on_low_confidence: config.handoff_on_low_confidence,
    });
  }, [config]);

  const update = <K extends keyof AiAgentConfigInput>(key: K, value: AiAgentConfigInput[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const addPhone = () => {
    const phone = normalizeE164Phone(phoneInput);
    if (!phone) {
      setPhoneError("Enter a valid international number starting with +.");
      return;
    }
    if ((form.admin_phone_numbers || []).includes(phone)) {
      setPhoneError("This phone number is already listed.");
      return;
    }
    update("admin_phone_numbers", [...(form.admin_phone_numbers || []), phone]);
    setPhoneInput("");
    setPhoneError(null);
  };

  const save = () => {
    const invalid = (form.admin_phone_numbers || []).filter((phone) => !normalizeE164Phone(phone));
    if (invalid.length > 0) {
      setPhoneError(`Invalid phone number: ${invalid[0]}`);
      return;
    }
    upsertConfig.mutate(form, {
      onSuccess: () => toast.success("AI agent settings saved"),
      onError: (error) => toast.error(error.message || "Could not save AI agent settings"),
    });
  };

  // No loading spinner here on purpose: the blank form plus the disabled Save
  // below IS the unloaded state ("a blank form is an unloaded form, not a
  // save"). A spinner would also unmount the account selector mid-switch,
  // taking away the very control the user just used.
  const selectedMode = (form.default_mode || "human_then_ai") as AiAgentMode;

  return (
    <Tabs
      defaultValue="settings"
      value={activeTab}
      onValueChange={onTabChange ? (value) => onTabChange(value as AiAgentTab) : undefined}
      className="space-y-4"
    >
      <TabsList className="h-auto flex-wrap justify-start">
        <TabsTrigger value="settings">Settings</TabsTrigger>
        <TabsTrigger value="knowledge">Knowledge</TabsTrigger>
        <TabsTrigger value="tools">Tools</TabsTrigger>
        <TabsTrigger value="test">Test</TabsTrigger>
        <TabsTrigger value="logs">Logs</TabsTrigger>
      </TabsList>

      <TabsContent value="settings" className="mt-0">
        <div className="space-y-4">
          {/* One selection drives the handler card, this form and the
              knowledge tab; AutomationHandlerCard's own selector is
              suppressed by passing accountId down. Markup matches that
              card's selector so the two pages read as one control. */}
          {accounts.length > 1 && (
            <Select value={accountId ?? ""} onValueChange={setSelectedAccountId}>
              <SelectTrigger className="w-full max-w-xs" data-testid="agent-account">
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

          {/* Automation Handler selector (Incoming Messages and/or Comments based on surface) */}
          <AutomationHandlerCard platform={platform} accountId={accountId} surface={surface} />

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Bot className="h-5 w-5" /> AI agent settings</CardTitle>
              <CardDescription>Set the default behavior for customer conversations on this platform.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
                <div>
                  <Label htmlFor="ai-agent-enabled" className="text-base">Enable AI agent</Label>
                  <p className="text-sm text-muted-foreground">Allow this agent to participate according to the selected mode.</p>
                </div>
                <Switch id="ai-agent-enabled" checked={Boolean(form.is_enabled)} onCheckedChange={(checked) => update("is_enabled", checked)} />
              </div>

              <div className="grid gap-5 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Default engagement mode</Label>
                  <Select value={selectedMode} onValueChange={(value) => update("default_mode", value as AiAgentMode)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ai_first">AI First</SelectItem>
                      <SelectItem value="human_first">Human First</SelectItem>
                      <SelectItem value="human_then_ai">Human then AI fallback</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-sm text-muted-foreground">{modeDescriptions[selectedMode]}</p>
                </div>
                <div className="space-y-2">
                  <Label>Language</Label>
                  <Select value={form.language_mode || "auto"} onValueChange={(value) => update("language_mode", value as AiAgentLanguageMode)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">Auto-detect (Arabic/English)</SelectItem>
                      <SelectItem value="ar">Arabic only</SelectItem>
                      <SelectItem value="en">English only</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-sm text-muted-foreground">Choose whether replies follow the customer&apos;s language automatically.</p>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="persona-instructions">Persona and instructions</Label>
                <Textarea id="persona-instructions" value={form.persona_instructions || ""} onChange={(event) => update("persona_instructions", event.target.value)} placeholder="Describe your tone, policies, and how the assistant should help customers." rows={5} />
              </div>

              <div className="space-y-2">
                <Label>Admin phone numbers</Label>
                <div className="flex flex-wrap gap-2 rounded-md border p-3">
                  {(form.admin_phone_numbers || []).map((phone) => (
                    <Badge key={phone} variant="secondary" className="gap-1 pr-1">
                      {phone}
                      <button type="button" aria-label={`Remove ${phone}`} className="rounded-sm p-0.5 hover:bg-muted" onClick={() => update("admin_phone_numbers", (form.admin_phone_numbers || []).filter((number) => number !== phone))}>
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                  {(form.admin_phone_numbers || []).length === 0 && <span className="text-sm text-muted-foreground">No admin numbers added.</span>}
                </div>
                <div className="flex gap-2">
                  <Input value={phoneInput} onChange={(event) => { setPhoneInput(event.target.value); setPhoneError(null); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addPhone(); } }} placeholder="+96550000000" />
                  <Button type="button" variant="outline" onClick={addPhone}><Plus className="mr-1 h-4 w-4" /> Add</Button>
                </div>
                <p className="text-sm text-muted-foreground">These numbers receive access to operational tools during customer conversations.</p>
                {phoneError && <p className="text-sm text-destructive">{phoneError}</p>}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Advanced</CardTitle>
              <CardDescription>Daily conversation limits and response cooldown settings.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-5 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="daily-cap">Daily message cap</Label>
                  <Input
                    id="daily-cap"
                    type="number"
                    min={1}
                    value={form.daily_message_cap ?? 50}
                    onChange={(event) => update("daily_message_cap", Number(event.target.value))}
                  />
                  <p className="text-xs text-muted-foreground">Maximum automated replies sent per day.</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="cooldown">Reply cooldown (seconds)</Label>
                  <Input
                    id="cooldown"
                    type="number"
                    min={0}
                    value={form.reply_cooldown_seconds ?? 0}
                    onChange={(event) => update("reply_cooldown_seconds", Number(event.target.value))}
                  />
                  <p className="text-xs text-muted-foreground">Wait time between consecutive AI replies (0 for instant).</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Auto-Reply Rules */}
          <AutoReplyManager platform={platform === "whatsapp" ? undefined : platform} />

          <div className="flex flex-col items-end gap-2">
            <Button onClick={save} disabled={!configLoaded || upsertConfig.isPending}>
              {(upsertConfig.isPending || isLoading) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save settings
            </Button>
            {!configLoaded && (
              <p className="text-sm text-muted-foreground" data-testid="save-blocked-reason">
                {error
                  ? `The agent configuration could not be loaded, so saving is disabled — a blank form must not overwrite the stored persona. (${error instanceof Error ? error.message : "read failed"})`
                  : "Loading the agent configuration — saving is disabled until it loads."}
              </p>
            )}
          </div>
        </div>
      </TabsContent>
      <TabsContent value="knowledge" className="mt-0"><AiKnowledgeManager platform={platform} accountId={accountId} /></TabsContent>
      <TabsContent value="tools" className="mt-0"><DatabaseConnectorsManager /></TabsContent>
      <TabsContent value="test" className="mt-0"><AiAgentTestChat platform={platform} accountId={accountId} /></TabsContent>
      <TabsContent value="logs" className="mt-0"><AiAgentLogsView platform={platform} /></TabsContent>
    </Tabs>
  );
}
