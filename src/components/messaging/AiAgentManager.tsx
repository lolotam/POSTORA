import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type AiAgentConfigInput, type AiAgentPlatform, useAiAgentConfig } from "@/hooks/useAiAgentConfig";
import { useSocialAccounts } from "@/hooks/useSocialAccounts";
import { normalizeE164Phone } from "@/lib/phone";
import { AutomationHandlerCard } from "@/components/messaging/AutomationHandlerCard";
import { AutoReplyManager } from "@/components/messaging/AutoReplyManager";
import { AiKnowledgeManager } from "@/components/messaging/AiKnowledgeManager";
import { AiAgentLogsView } from "@/components/messaging/AiAgentLogsView";
import { AgentDashboardView } from "@/features/agent-dashboard";
import { AiAgentTestChat } from "@/components/messaging/AiAgentTestChat";
import { DatabaseConnectorsManager } from "@/components/automation/DatabaseConnectorsManager";
import { UnsavedChangesDialog } from "@/components/ui/UnsavedChangesDialog";
import { useDirtyForm } from "@/hooks/useDirtyForm";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import type { AgentBehavior } from "@/lib/agentProfile";
import { AgentIdentityCard } from "@/components/messaging/agent-settings/AgentIdentityCard";
import { AdvancedCard } from "@/components/messaging/agent-settings/AdvancedCard";
import { BusinessGoalsCard } from "@/components/messaging/agent-settings/BusinessGoalsCard";
import { GuardrailsCard } from "@/components/messaging/agent-settings/GuardrailsCard";
import { InstructionBlocksCard } from "@/components/messaging/agent-settings/InstructionBlocksCard";
import { ProceduresCard } from "@/components/messaging/agent-settings/ProceduresCard";
import { supportsProcedures } from "@/lib/procedureTemplates";
import { HumanHandoffCard } from "@/components/messaging/agent-settings/HumanHandoffCard";

const defaultConfig: Required<Pick<AiAgentConfigInput,
  "is_enabled" | "default_mode" | "language_mode" | "daily_message_cap" | "reply_cooldown_seconds"
  | "escalation_timeout_minutes"
>> & AiAgentConfigInput = {
  is_enabled: false,
  default_mode: "human_then_ai",
  language_mode: "auto",
  daily_message_cap: 50,
  reply_cooldown_seconds: 0,
  escalation_timeout_minutes: 240,
  persona_instructions: "",
  agent_behavior: {},
  admin_phone_numbers: [],
};

/** The stored config as the form holds it. One definition, so a first load and a
 *  refresh can never disagree about a field's shape. */
function toFormValues(config: NonNullable<ReturnType<typeof useAiAgentConfig>["config"]>): AiAgentConfigInput {
  return {
    is_enabled: config.is_enabled,
    default_mode: config.default_mode,
    persona_instructions: config.persona_instructions || "",
    agent_behavior: config.agent_behavior ?? {},
    language_mode: config.language_mode,
    temperature: config.temperature,
    admin_phone_numbers: config.admin_phone_numbers || [],
    daily_message_cap: config.daily_message_cap,
    escalation_timeout_minutes: config.escalation_timeout_minutes ?? 240,
    reply_cooldown_seconds: config.reply_cooldown_seconds,
    max_tool_iterations: config.max_tool_iterations,
    handoff_on_request: config.handoff_on_request,
    handoff_on_low_confidence: config.handoff_on_low_confidence,
  };
}

/**
 * `current`, with every field the user has NOT edited replaced by the server's
 * latest value.
 *
 * A field is "edited" when it differs from the baseline it was loaded with, so
 * the user's own changes survive a refresh and everything else follows the
 * server. Both extremes are lossy: replacing the whole form discards what they
 * typed (the 2026-08-30 outage), and keeping the whole form carries a stale
 * server value that the next save would write back over a fresher one -- the
 * hazard that made this function necessary, when this form still echoed the
 * knowledge tab's business_profile_text back on every save.
 *
 * Compared with JSON.stringify to match useDirtyForm exactly -- admin_phone_numbers
 * is an array, and two definitions of "changed" in one component would eventually
 * disagree.
 */
function mergeUntouchedFields(
  current: AiAgentConfigInput,
  baseline: AiAgentConfigInput,
  refreshed: AiAgentConfigInput,
): AiAgentConfigInput {
  const merged: Record<string, unknown> = { ...current };
  for (const key of Object.keys(refreshed) as (keyof AiAgentConfigInput)[]) {
    const untouched = JSON.stringify(current[key]) === JSON.stringify(baseline[key]);
    if (untouched) merged[key] = refreshed[key];
  }
  return merged as AiAgentConfigInput;
}

export const AI_AGENT_TABS = ["settings", "knowledge", "tools", "test", "logs"] as const;
export type AiAgentTab = (typeof AI_AGENT_TABS)[number];

interface AiAgentManagerProps {
  platform?: AiAgentPlatform;
  /** Account selected by an overview deep link. It is still validated against
   *  the active accounts before any account-scoped read or write uses it. */
  initialAccountId?: string | null;
  /** When provided (with onTabChange), the tab bar is URL-controlled for deep links. */
  activeTab?: AiAgentTab;
  onTabChange?: (tab: AiAgentTab) => void;
  surface?: "dms" | "comments" | "both";
  onDirtyChange?: (isDirty: boolean) => void;
}

export function AiAgentManager({ platform = "whatsapp", initialAccountId = null, activeTab, onTabChange, surface = "both", onDirtyChange }: AiAgentManagerProps = {}) {
  const { t } = useTranslation("agent");
  const { data: socialAccounts = [] } = useSocialAccounts();
  // Same selection pattern as AutomationHandlerCard: the first active account
  // on the platform until the user chooses, and never an id that is not in
  // the list (a disconnected account must deselect itself, not linger).
  const accounts = useMemo(
    () => socialAccounts.filter((account) => account.platform === platform && account.is_active),
    [socialAccounts, platform],
  );
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(initialAccountId);
  const accountId = selectedAccountId && accounts.some((account) => account.id === selectedAccountId)
    ? selectedAccountId
    : accounts[0]?.id ?? null;

  const { config, isLoading, error, upsertConfig } = useAiAgentConfig(platform, accountId);
  const [form, setForm] = useState<AiAgentConfigInput>(defaultConfig);
  const [baseline, setBaseline] = useState<AiAgentConfigInput | null>(null);
  // undefined = nothing loaded yet; null = loaded for "no account". These must stay
  // distinguishable: accountId is legitimately null while the accounts query is in
  // flight and whenever the platform has no active account, so collapsing the two
  // would make the guard in the effect below fire on the very first render and
  // leave the form permanently empty.
  const [loadedAccountId, setLoadedAccountId] = useState<string | null | undefined>(undefined);
  const [phoneInput, setPhoneInput] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  // Read by the populate effect without being depended on -- see the comment there.
  const baselineRef = useRef<AiAgentConfigInput | null>(null);
  baselineRef.current = baseline;

  // The form must refuse to submit a config it never loaded. On 2026-08-28 a
  // read that returned nothing rendered a blank form whose Save then wrote
  // the blank defaults over a live persona. `config` is undefined until a
  // read settles -- null means "no config yet", which is a legitimate save
  // that creates the first one -- so while it is undefined Save stays
  // disabled and says why.
  // `error` is checked too: React Query keeps the previously cached data when a
  // refetch fails, so config alone can be a stale account's config while the
  // read for THIS one errored -- Save would then write it to the wrong account.
  const configLoaded = config !== undefined && !error && loadedAccountId === accountId;

  useEffect(() => {
    // A repeat read of the SAME account refreshes untouched fields and leaves
    // edited ones alone. Resetting everything is how a typed persona became a
    // blank save on 2026-08-30; freezing everything is the opposite mistake, and
    // just as lossy -- the knowledge tab's save refreshes this same query, so a
    // frozen form would carry stale server values and the next Settings save
    // would silently revert what another surface had just written.
    //
    // A field counts as edited when it has diverged from the baseline, so the
    // user's own changes always win and everything else takes the server's value.
    // The undefined check is load-bearing: without it `null === null` matches on
    // the first render and the form never populates at all.
    if (loadedAccountId !== undefined && loadedAccountId === accountId) {
      // Through a ref, not the dependency array. toFormValues builds a fresh
      // object every call, so depending on `baseline` would re-run this effect
      // on the state it just set, forever.
      const previous = baselineRef.current;
      if (!config || !previous) return;
      const refreshed = toFormValues(config);
      // A read that brought nothing new must do NOTHING. Both setters below
      // produce fresh objects, so an unconditional merge re-renders, and any
      // caller whose `config` identity changes per render then re-enters this
      // effect forever. React Query's structural sharing happens to keep that
      // identity stable for equal data, but termination must not depend on an
      // upstream optimisation -- it hung a CI run for two hours before this
      // guard existed.
      if (JSON.stringify(refreshed) === JSON.stringify(previous)) return;
      setForm((current) => mergeUntouchedFields(current, previous, refreshed));
      setBaseline(refreshed);
      return;
    }
    // A settled null is "this account has no config yet", and the form must
    // show that rather than whatever the previously selected account had in
    // it. Returning early here let account A's persona sit in the fields
    // while account B was selected -- and since null counts as loaded, Save
    // was enabled and would have written A's brand voice into B.
    if (config === null) {
      setForm(defaultConfig);
      setBaseline(defaultConfig);
      setLoadedAccountId(accountId);
      return;
    }
    if (!config) return;
    const loaded = toFormValues(config);
    setForm(loaded);
    setBaseline(loaded);
    setLoadedAccountId(accountId);
  }, [accountId, config, loadedAccountId]);

  // Read inside the save callback, which closes over the account that started the
  // mutation rather than the one selected when it resolves.
  const accountIdRef = useRef(accountId);
  useEffect(() => { accountIdRef.current = accountId; }, [accountId]);

  const formDirty = useDirtyForm(form, baseline);
  const isDirty = formDirty || phoneInput.trim().length > 0;
  const { guard, pending, confirmDiscard, cancel } = useUnsavedChangesGuard(isDirty);

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  const update = <K extends keyof AiAgentConfigInput>(key: K, value: AiAgentConfigInput[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  // Merges rather than replaces. agent_behavior is ONE column written by four
  // different cards; a replacing setter would make whichever card the user
  // touched last silently erase the other three.
  const behavior = form.agent_behavior ?? {};
  const updateBehavior = <K extends keyof AgentBehavior>(key: K, value: AgentBehavior[K]) => {
    setForm((current) => ({
      ...current,
      agent_behavior: { ...(current.agent_behavior ?? {}), [key]: value },
    }));
  };

  const addPhone = () => {
    const phone = normalizeE164Phone(phoneInput);
    if (!phone) {
      setPhoneError(t("manager.phoneInvalid", "Enter a valid international number starting with +."));
      return;
    }
    if ((form.admin_phone_numbers || []).includes(phone)) {
      setPhoneError(t("manager.phoneDuplicate", "This phone number is already listed."));
      return;
    }
    update("admin_phone_numbers", [...(form.admin_phone_numbers || []), phone]);
    setPhoneInput("");
    setPhoneError(null);
  };

  const save = () => {
    const invalid = (form.admin_phone_numbers || []).filter((phone) => !normalizeE164Phone(phone));
    if (invalid.length > 0) {
      setPhoneError(t("manager.phoneInvalidListed", "Invalid phone number: {{phone}}", { phone: invalid[0] }));
      return;
    }
    // Both are captured now, because the callback runs later and the user may have moved
    // on. A save for account A that lands after a switch to B must not write A's values
    // into B's baseline -- B's untouched fields would then read as dirty and prompt.
    const savedAccountId = accountId;
    const savedForm = form;
    // The server refuses a write that empties a stored persona or business profile
    // unless the clear is declared. A reset form cannot reach here saying yes: a
    // reset sets form AND baseline to defaultConfig together, so the baseline is
    // blank too and this comparison is false. Only a user who saw a value and
    // deleted it produces a non-empty baseline against an empty form -- which is
    // what makes the flag a real signal rather than a rubber stamp.
    const clearedAField = (["persona_instructions"] as const).some(
      (field) =>
        String(form[field] ?? "").trim() === "" &&
        String(baseline?.[field] ?? "").trim() !== "",
    );
    upsertConfig.mutate({ ...form, confirm_clear: clearedAField || undefined }, {
      onSuccess: () => {
        if (accountIdRef.current === savedAccountId) setBaseline(savedForm);
        toast.success(t("toast.saved", "AI agent settings saved"));
      },
      onError: (error) =>
        toast.error(
          // The 409 names database columns; users get a sentence instead.
          error.message?.includes("Refusing to clear")
            ? t("toast.clearRefused", "That would erase the saved persona or business profile. Clear the field and save again to confirm.")
            : error.message || t("toast.saveError", "Could not save AI agent settings"),
        ),
    });
  };

  // No loading spinner here on purpose: the blank form plus the disabled Save
  // below IS the unloaded state ("a blank form is an unloaded form, not a
  // save"). A spinner would also unmount the account selector mid-switch,
  // taking away the very control the user just used.

  return (
    <Tabs
      defaultValue="settings"
      value={activeTab}
      onValueChange={onTabChange ? (value) => onTabChange(value as AiAgentTab) : undefined}
      className="space-y-4"
    >
      <TabsList className="h-auto flex-wrap justify-start">
        <TabsTrigger value="settings">{t("tabs.settings", "Settings")}</TabsTrigger>
        <TabsTrigger value="knowledge">{t("tabs.knowledge", "Knowledge")}</TabsTrigger>
        <TabsTrigger value="tools">{t("tabs.tools", "Tools")}</TabsTrigger>
        <TabsTrigger value="test">{t("tabs.test", "Test")}</TabsTrigger>
        <TabsTrigger value="dashboard">{t("tabs.dashboard", "Dashboard")}</TabsTrigger>
        <TabsTrigger value="logs">{t("tabs.logs", "Logs")}</TabsTrigger>
      </TabsList>

      <TabsContent value="settings" className="mt-0">
        <div className="space-y-4">
          {/* One selection drives the handler card, this form and the
              knowledge tab; AutomationHandlerCard's own selector is
              suppressed by passing accountId down. Markup matches that
              card's selector so the two pages read as one control. */}
          {accounts.length > 1 && (
            <Select value={accountId ?? ""} onValueChange={(next) => guard(() => setSelectedAccountId(next))}>
              <SelectTrigger className="w-full max-w-xs" data-testid="agent-account">
                <SelectValue placeholder={t("manager.selectAccount", "Select account")} />
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

          {/* Until THIS account's config has arrived, the fields still show the previous
              account's values and Save is already disabled. Leaving them editable let a
              user type into a form they could not save, whose contents the arriving config
              would then silently replace -- and because the baseline is null during that
              window, useDirtyForm read those edits as clean, so neither the transition
              guard nor beforeunload protected them. `contents` keeps the fieldset out of
              the layout; the disabled state still propagates down the DOM tree. */}
          <fieldset disabled={!configLoaded} className="contents" data-testid="agent-form-fields">
          <AgentIdentityCard form={form} update={update} behavior={behavior} updateBehavior={updateBehavior} />
          <BusinessGoalsCard form={form} update={update} behavior={behavior} updateBehavior={updateBehavior} />
          <GuardrailsCard form={form} update={update} behavior={behavior} updateBehavior={updateBehavior} />
          <HumanHandoffCard
            form={form}
            update={update}
            phoneInput={phoneInput}
            phoneError={phoneError}
            onPhoneInputChange={(next) => { setPhoneInput(next); setPhoneError(null); }}
            onAddPhone={addPhone}
            onRemovePhone={(phone) =>
              update("admin_phone_numbers", (form.admin_phone_numbers || []).filter((number) => number !== phone))
            }
          />
          <InstructionBlocksCard form={form} update={update} behavior={behavior} updateBehavior={updateBehavior} />
          {supportsProcedures(platform, surface) && (
            <ProceduresCard
              form={form}
              update={update}
              behavior={behavior}
              updateBehavior={updateBehavior}
              storeAccountId={platform === "whatsapp" ? accountId : null}
              connectionMode={accounts.find((account) => account.id === accountId)?.connection_mode ?? null}
            />
          )}
          <AdvancedCard form={form} update={update} />
          </fieldset>

          {/* Auto-Reply Rules */}
          <AutoReplyManager platform={platform === "whatsapp" ? undefined : platform} />

          <div className="flex flex-col items-end gap-2">
            <Button onClick={save} disabled={!configLoaded || upsertConfig.isPending}>
              {(upsertConfig.isPending || isLoading) && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
              {t("manager.saveSettings", "Save settings")}
            </Button>
            {!configLoaded && (
              <p className="text-sm text-muted-foreground" data-testid="save-blocked-reason">
                {error
                  ? t("manager.saveBlockedError", "The agent configuration could not be loaded, so saving is disabled — a blank form must not overwrite the stored persona. ({{message}})", { message: error instanceof Error ? error.message : t("manager.readFailed", "read failed") })
                  : t("manager.saveBlockedLoading", "Loading this account's agent configuration — saving is disabled until it loads.")}
              </p>
            )}
          </div>
        </div>
      </TabsContent>
      <TabsContent value="knowledge" className="mt-0"><AiKnowledgeManager platform={platform} accountId={accountId} /></TabsContent>
      <TabsContent value="tools" className="mt-0">
        <DatabaseConnectorsManager
          platform={platform}
          accountId={accountId}
          onAccountIdChange={(nextAccountId) => guard(() => setSelectedAccountId(nextAccountId))}
        />
      </TabsContent>
      <TabsContent value="test" className="mt-0"><AiAgentTestChat platform={platform} accountId={accountId} /></TabsContent>
      <TabsContent value="dashboard" className="mt-0"><AgentDashboardView platform={platform} /></TabsContent>
      <TabsContent value="logs" className="mt-0"><AiAgentLogsView platform={platform} /></TabsContent>
      <UnsavedChangesDialog
        open={pending}
        onCancel={cancel}
        onDiscard={() => {
          setBaseline(null);
          setLoadedAccountId(null);
          setPhoneInput("");
          confirmDiscard();
        }}
      />
    </Tabs>
  );
}
