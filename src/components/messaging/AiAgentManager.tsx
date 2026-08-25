import { useEffect, useState } from "react";
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
import { normalizeE164Phone } from "@/lib/phone";
import { AutomationHandlerCard } from "@/components/messaging/AutomationHandlerCard";
import { AiKnowledgeManager } from "@/components/messaging/AiKnowledgeManager";
import { AiAgentLogsView } from "@/components/messaging/AiAgentLogsView";
import { AiAgentTestChat } from "@/components/messaging/AiAgentTestChat";
import { DatabaseConnectorsManager } from "@/components/automation/DatabaseConnectorsManager";

const defaultConfig: Required<Pick<AiAgentConfigInput,
  "is_enabled" | "default_mode" | "language_mode" | "model" | "daily_message_cap" | "reply_cooldown_seconds"
>> & AiAgentConfigInput = {
  is_enabled: false,
  default_mode: "human_then_ai",
  language_mode: "auto",
  model: "gpt-4o-mini",
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
}

export function AiAgentManager({ platform = "whatsapp", activeTab, onTabChange }: AiAgentManagerProps = {}) {
  const { config, isLoading, upsertConfig } = useAiAgentConfig(platform);
  const [form, setForm] = useState<AiAgentConfigInput>(defaultConfig);
  const [phoneInput, setPhoneInput] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);

  useEffect(() => {
    if (!config) return;
    setForm({
      is_enabled: config.is_enabled,
      default_mode: config.default_mode,
      persona_instructions: config.persona_instructions || "",
      business_profile_text: config.business_profile_text || "",
      language_mode: config.language_mode,
      model: config.model,
      fallback_model_1: config.fallback_model_1 || null,
      fallback_model_2: config.fallback_model_2 || null,
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

  if (isLoading) {
    return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

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
          {/* Only WhatsApp reaches its handler picker from here. The Facebook, Instagram and
              Threads pages already render this card in their own tab, and a second copy would
              put two independent account selectors for one setting on the same page. */}
          {platform === "whatsapp" && <AutomationHandlerCard platform={platform} />}

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

          <div className="flex justify-end"><Button onClick={save} disabled={upsertConfig.isPending}>{upsertConfig.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save settings</Button></div>
        </div>
      </TabsContent>
      <TabsContent value="knowledge" className="mt-0"><AiKnowledgeManager platform={platform} /></TabsContent>
      <TabsContent value="tools" className="mt-0"><AiToolsManager /></TabsContent>
      <TabsContent value="test" className="mt-0"><AiAgentTestChat platform={platform} /></TabsContent>
      <TabsContent value="logs" className="mt-0"><AiAgentLogsView platform={platform} /></TabsContent>
    </Tabs>
  );
}
