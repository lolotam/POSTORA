import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SettingsSubTabs } from "@/components/admin/settings/SettingsSubTabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { clearWhatsAppSignupConfigCache } from "@/lib/whatsappEmbeddedSignup";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { WhatsAppTpStatus } from "@/hooks/useWhatsAppTpStatus";
import { WHATSAPP_TP_STATUS_KEY } from "@/hooks/useWhatsAppTpStatus";
import {
  Loader2,
  Save,
  TestTube,
  CheckCircle2,
  AlertCircle,
  Eye,
  EyeOff,
  KeyRound,
  XCircle,
} from "lucide-react";

interface PlatformConfig {
  key: string;
  label: string;
  icon: string;
  clientIdSecret: string;
  clientSecretSecret: string;
}

const PLATFORMS: PlatformConfig[] = [
  { key: "facebook", label: "Facebook", icon: "📘", clientIdSecret: "FACEBOOK_APP_ID", clientSecretSecret: "FACEBOOK_APP_SECRET" },
  { key: "instagram", label: "Instagram", icon: "📸", clientIdSecret: "INSTAGRAM_APP_ID", clientSecretSecret: "INSTAGRAM_APP_SECRET" },
  { key: "threads", label: "Threads", icon: "🧵", clientIdSecret: "THREADS_APP_ID", clientSecretSecret: "THREADS_APP_SECRET" },
  { key: "tiktok", label: "TikTok", icon: "🎵", clientIdSecret: "TIKTOK_CLIENT_KEY", clientSecretSecret: "TIKTOK_CLIENT_SECRET" },
  { key: "twitter", label: "Twitter / X", icon: "𝕏", clientIdSecret: "TWITTER_CLIENT_ID", clientSecretSecret: "TWITTER_CLIENT_SECRET" },
  { key: "linkedin", label: "LinkedIn", icon: "💼", clientIdSecret: "LINKEDIN_CLIENT_ID", clientSecretSecret: "LINKEDIN_CLIENT_SECRET" },
  { key: "pinterest", label: "Pinterest", icon: "📌", clientIdSecret: "PINTEREST_CLIENT_ID", clientSecretSecret: "PINTEREST_CLIENT_SECRET" },
  { key: "google", label: "YouTube / Google", icon: "🔴", clientIdSecret: "GOOGLE_CLIENT_ID", clientSecretSecret: "GOOGLE_CLIENT_SECRET" },
];

interface PlatformSecrets {
  clientId: string | null;
  clientSecret: string | null;
}

interface WaConfigCheck {
  mode: "cloud_api" | "coexistence";
  setting_key: string;
  config_id: string | null;
  valid: boolean;
  name?: string;
  feature_type?: string;
  error?: string;
  hint?: string;
}

interface WaTestResponse {
  cloud_api: WaConfigCheck;
  coexistence: WaConfigCheck;
  all_valid: boolean;
  facebook_app_id?: string;
}

const WA_CLOUD_KEY = "META_WHATSAPP_CONFIG_ID";
const WA_COEX_KEY = "META_WHATSAPP_COEXISTENCE_CONFIG_ID";

/** WhatsApp Embedded Signup is configured by Meta config ID, not by an app id/secret pair. */
const WA_PANEL = "WhatsApp";

type CredentialStatus = "configured" | "partial" | "not_set" | "unknown";

const STATUS_DOT: Record<CredentialStatus, string> = {
  configured: "bg-green-500",
  partial: "bg-yellow-500",
  not_set: "bg-muted-foreground/40",
  unknown: "bg-muted-foreground/40",
};

const STATUS_PILL: Record<CredentialStatus, { label: string; className: string } | null> = {
  configured: { label: "Configured", className: "text-green-600 bg-green-500/10" },
  partial: { label: "Partial", className: "text-yellow-600 bg-yellow-500/10" },
  not_set: { label: "Not Set", className: "text-muted-foreground bg-muted" },
  unknown: null,
};

function StatusPill({ status }: { status: CredentialStatus }) {
  const pill = STATUS_PILL[status];
  if (!pill) return null;
  return (
    <span className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full ${pill.className}`}>
      {status === "configured" && <CheckCircle2 className="w-3 h-3" />}
      {status === "partial" && <AlertCircle className="w-3 h-3" />}
      {pill.label}
    </span>
  );
}

function extractWaValue(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (typeof raw === "object" && "value" in (raw as Record<string, unknown>)) {
    const inner = (raw as Record<string, unknown>).value;
    if (typeof inner === "string") return inner;
  }
  try {
    return JSON.stringify(raw).replace(/^"|"$/g, "");
  } catch {
    return "";
  }
}

export function AppCredentialsSettings() {
  const { toast } = useToast();
  const [secrets, setSecrets] = useState<Record<string, PlatformSecrets>>({});
  const [unavailableMessage, setUnavailableMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingPlatform, setEditingPlatform] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<{ clientId: string; clientSecret: string }>({ clientId: "", clientSecret: "" });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; message: string }>>({});
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({});
  // Which platform's panel is open. Local rather than in the URL: these panels are one
  // settings section as far as the page's tab and search params are concerned.
  const [activePanel, setActivePanel] = useState<string>(PLATFORMS[0].label);

  // WhatsApp Embedded Signup config
  const [waCloudId, setWaCloudId] = useState("");
  const [waCoexId, setWaCoexId] = useState("");
  const [waLoading, setWaLoading] = useState(true);
  const [waSaving, setWaSaving] = useState(false);
  const [waTesting, setWaTesting] = useState(false);
  const [waTestResult, setWaTestResult] = useState<WaTestResponse | null>(null);
  const [tpStatus, setTpStatus] = useState<WhatsAppTpStatus>("approved");
  const [tpSaving, setTpSaving] = useState(false);

  const fetchSecrets = async () => {
    try {
      setLoading(true);
      setUnavailableMessage(null);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      const { data, error } = await supabase.functions.invoke("manage-app-secrets", {
        body: { action: "list" },
      });

      if (error) throw error;
      if (data?.success) {
        setSecrets(data.data);
      } else if (data?.error_code === "management_api_unavailable") {
        // Self-hosted: secrets are managed via host .env / Dokploy.
        setSecrets({});
        setUnavailableMessage(data?.message || "Remote secret management is unavailable on self-hosted Supabase.");
      } else {
        throw new Error(data?.error || data?.message || "Failed to fetch");
      }
    } catch (err: any) {
      toast({ title: "Error loading credentials", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const fetchWaConfig = async () => {
    try {
      setWaLoading(true);
      const { data, error } = await supabase
        .from("app_settings")
        .select("key, value")
        .in("key", [WA_CLOUD_KEY, WA_COEX_KEY, WHATSAPP_TP_STATUS_KEY]);
      if (error) throw error;
      for (const row of data || []) {
        const v = extractWaValue((row as { value: unknown }).value);
        if (row.key === WA_CLOUD_KEY) setWaCloudId(v);
        if (row.key === WA_COEX_KEY) setWaCoexId(v);
        if (row.key === WHATSAPP_TP_STATUS_KEY) {
          if (v === "approved" || v === "pending" || v === "not_started") {
            setTpStatus(v);
          }
        }
      }
    } catch (err: any) {
      toast({ title: "Error loading WhatsApp config", description: err.message, variant: "destructive" });
    } finally {
      setWaLoading(false);
    }
  };

  const handleTpStatusChange = async (next: WhatsAppTpStatus) => {
    const prev = tpStatus;
    setTpStatus(next);
    setTpSaving(true);
    try {
      const { error } = await supabase
        .from("app_settings")
        .upsert(
          {
            key: WHATSAPP_TP_STATUS_KEY,
            value: next,
            description: "WhatsApp Embedded Signup Tech Provider approval status (pending | approved | not_started)",
          },
          { onConflict: "key" }
        );
      if (error) throw error;
      toast({ title: "Tech Provider status updated" });
    } catch (err: any) {
      setTpStatus(prev);
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    } finally {
      setTpSaving(false);
    }
  };

  const handleWaSave = async () => {
    try {
      setWaSaving(true);
      setWaTestResult(null);
      const { error } = await supabase.from("app_settings").upsert(
        [
          { key: WA_CLOUD_KEY, value: waCloudId.trim(), description: "Meta FB Login for Business config ID — WhatsApp Cloud API" },
          { key: WA_COEX_KEY, value: waCoexId.trim(), description: "Meta FB Login for Business config ID — WhatsApp Coexistence" },
        ],
        { onConflict: "key" }
      );
      if (error) throw error;
      clearWhatsAppSignupConfigCache();
      toast({ title: "WhatsApp config saved" });
    } catch (err: any) {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    } finally {
      setWaSaving(false);
    }
  };

  const handleWaTest = async () => {
    try {
      setWaTesting(true);
      setWaTestResult(null);
      const { data, error } = await supabase.functions.invoke<WaTestResponse>("whatsapp-config-test", { body: {} });
      if (error) throw error;
      if (!data) throw new Error("Empty response");
      setWaTestResult(data);
      toast({
        title: data.all_valid ? "Test passed" : "Test failed",
        description: data.all_valid ? "Both configurations are valid." : "One or more configurations failed validation.",
        variant: data.all_valid ? "default" : "destructive",
      });
    } catch (err: any) {
      toast({ title: "Test error", description: err.message, variant: "destructive" });
    } finally {
      setWaTesting(false);
    }
  };

  const getWaStatus = (): "configured" | "partial" | "not_set" => {
    const c = waCloudId.trim();
    const x = waCoexId.trim();
    if (c && x) return "configured";
    if (c || x) return "partial";
    return "not_set";
  };

  useEffect(() => {
    fetchSecrets();
    fetchWaConfig();
  }, []);

  const handleEdit = (platform: PlatformConfig) => {
    setEditingPlatform(platform.key);
    setEditValues({ clientId: "", clientSecret: "" });
  };

  const handleSave = async (platform: PlatformConfig) => {
    const updates: Array<{ name: string; value: string }> = [];
    if (editValues.clientId.trim()) {
      updates.push({ name: platform.clientIdSecret, value: editValues.clientId.trim() });
    }
    if (editValues.clientSecret.trim()) {
      updates.push({ name: platform.clientSecretSecret, value: editValues.clientSecret.trim() });
    }

    if (updates.length === 0) {
      toast({ title: "No changes", description: "Enter at least one value to update" });
      return;
    }

    try {
      setSaving(true);
      const { data, error } = await supabase.functions.invoke("manage-app-secrets", {
        body: { action: "update", updates },
      });

      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || "Update failed");

      toast({ title: "Credentials updated", description: `${platform.label} secrets saved successfully` });
      setEditingPlatform(null);
      setEditValues({ clientId: "", clientSecret: "" });
      // Clear test result for this platform
      setTestResults(prev => {
        const next = { ...prev };
        delete next[platform.key];
        return next;
      });
      await fetchSecrets();
    } catch (err: any) {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (platform: PlatformConfig) => {
    try {
      setTesting(platform.key);
      const { data, error } = await supabase.functions.invoke("manage-app-secrets", {
        body: { action: "test", platform: platform.key },
      });

      if (error) throw error;
      const result = data?.data || { success: false, message: "Unknown error" };
      setTestResults(prev => ({ ...prev, [platform.key]: result }));

      toast({
        title: result.success ? "Test passed" : "Test failed",
        description: result.message,
        variant: result.success ? "default" : "destructive",
      });
    } catch (err: any) {
      setTestResults(prev => ({ ...prev, [platform.key]: { success: false, message: err.message } }));
      toast({ title: "Test error", description: err.message, variant: "destructive" });
    } finally {
      setTesting(null);
    }
  };

  const getStatus = (platformKey: string): CredentialStatus => {
    const s = secrets[platformKey];
    if (!s) return "unknown";
    if (s.clientId && s.clientSecret) return "configured";
    if (s.clientId || s.clientSecret) return "partial";
    return "not_set";
  };

  const panelLabels = [...PLATFORMS.map((p) => p.label), WA_PANEL];
  const statusByLabel: Record<string, CredentialStatus> = {
    ...Object.fromEntries(PLATFORMS.map((p) => [p.label, getStatus(p.key)])),
    [WA_PANEL]: getWaStatus(),
  };
  const configuredCount = panelLabels.filter((label) => statusByLabel[label] === "configured").length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
              <KeyRound className="w-4 h-4 text-primary" />
            </div>
            <div>
              <CardTitle className="text-base">App Credentials</CardTitle>
              <CardDescription>
                OAuth app id and secret per platform, plus WhatsApp Embedded Signup
              </CardDescription>
            </div>
          </div>
          {!loading && (
            <span className="text-xs text-muted-foreground whitespace-nowrap pt-1">
              {configuredCount} of {panelLabels.length} configured
            </span>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {unavailableMessage && !loading && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            {unavailableMessage}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <SettingsSubTabs
              labels={panelLabels}
              active={activePanel}
              onSelect={setActivePanel}
              icons={Object.fromEntries([
                ...PLATFORMS.map((p) => [p.label, <span key={p.key} className="text-base leading-none">{p.icon}</span>]),
                [WA_PANEL, <span key="wa" className="text-base leading-none">💬</span>],
              ])}
              badges={Object.fromEntries(
                panelLabels.map((label) => [
                  label,
                  <span
                    key={label}
                    className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[statusByLabel[label]]}`}
                    aria-hidden
                  />,
                ]),
              )}
            />

            {PLATFORMS.map((platform) => {
              const status = getStatus(platform.key);
              const isEditing = editingPlatform === platform.key;
              const testResult = testResults[platform.key];
              const platformSecrets = secrets[platform.key];

              return (
                // Panels stay mounted so a half-typed secret survives a look at another
                // platform — the accordion this replaced behaved the same way.
                <div
                  key={platform.key}
                  className={
                    platform.label === activePanel
                      ? "rounded-lg border border-border p-3 space-y-2"
                      : "hidden"
                  }
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-lg">{platform.icon}</span>
                      <span className="text-sm font-medium">{platform.label}</span>
                    </div>
                    <StatusPill status={status} />
                  </div>
                  {/* Current values (masked) */}
                  {!isEditing && platformSecrets && (
                    <div className="space-y-1 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Client ID:</span>
                        <code className="text-foreground/70 font-mono text-[11px]">
                          {platformSecrets.clientId || "—"}
                        </code>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Secret:</span>
                        <code className="text-foreground/70 font-mono text-[11px]">
                          {platformSecrets.clientSecret || "—"}
                        </code>
                      </div>
                    </div>
                  )}

                  {/* Edit mode */}
                  {isEditing && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div>
                        <label className="text-[11px] text-muted-foreground mb-0.5 block">
                          Client ID ({platform.clientIdSecret})
                        </label>
                        <Input
                          type="text"
                          className="h-7 text-xs font-mono"
                          placeholder="Leave empty to keep current"
                          value={editValues.clientId}
                          onChange={(e) => setEditValues((prev) => ({ ...prev, clientId: e.target.value }))}
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-muted-foreground mb-0.5 block">
                          Client Secret ({platform.clientSecretSecret})
                        </label>
                        <div className="relative">
                          <Input
                            type={showSecret[platform.key] ? "text" : "password"}
                            className="h-7 text-xs font-mono pr-8"
                            placeholder="Leave empty to keep current"
                            value={editValues.clientSecret}
                            onChange={(e) => setEditValues((prev) => ({ ...prev, clientSecret: e.target.value }))}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            className="absolute right-0 top-0 h-7 w-7 p-0"
                            onClick={() => setShowSecret((prev) => ({ ...prev, [platform.key]: !prev[platform.key] }))}
                          >
                            {showSecret[platform.key] ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Test result */}
                  {testResult && (
                    <div
                      className={`text-[11px] px-2 py-1 rounded ${
                        testResult.success
                          ? "bg-green-500/10 text-green-700"
                          : "bg-destructive/10 text-destructive"
                      }`}
                    >
                      {testResult.message}
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex items-center gap-1.5 pt-1">
                    {isEditing ? (
                      <>
                        <Button
                          size="sm"
                          className="h-7 text-xs gap-1"
                          onClick={() => handleSave(platform)}
                          disabled={saving}
                        >
                          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                          Save
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => setEditingPlatform(null)}
                          disabled={saving}
                        >
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => handleEdit(platform)}
                        >
                          {status === "not_set" ? "Add" : "Update"}
                        </Button>
                        {status !== "not_set" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs gap-1"
                            onClick={() => handleTest(platform)}
                            disabled={testing === platform.key}
                          >
                            {testing === platform.key ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <TestTube className="w-3 h-3" />
                            )}
                            Test
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}

            {/* WhatsApp Embedded Signup */}
            <div
              className={
                WA_PANEL === activePanel
                  ? "rounded-lg border border-border p-3 space-y-2"
                  : "hidden"
              }
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-lg">💬</span>
                  <span className="text-sm font-medium">WhatsApp Embedded Signup</span>
                </div>
                <StatusPill status={getWaStatus()} />
              </div>
              {waLoading ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
                </div>
              ) : (
                <>
                  <p className="text-[11px] text-muted-foreground">
                    Configuration IDs from Meta → App Dashboard → Facebook Login for Business → Configurations.
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div>
                      <label className="text-[11px] text-muted-foreground mb-0.5 block">
                        Cloud API Configuration ID ({WA_CLOUD_KEY})
                      </label>
                      <Input
                        type="text"
                        inputMode="numeric"
                        className="h-7 text-xs font-mono"
                        placeholder="e.g. 1663110164872480"
                        value={waCloudId}
                        onChange={(e) => setWaCloudId(e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-muted-foreground mb-0.5 block">
                        Coexistence Configuration ID ({WA_COEX_KEY})
                      </label>
                      <Input
                        type="text"
                        inputMode="numeric"
                        className="h-7 text-xs font-mono"
                        placeholder="e.g. 978825294740266"
                        value={waCoexId}
                        onChange={(e) => setWaCoexId(e.target.value)}
                      />
                    </div>
                  </div>

                  {/* Tech Provider approval status */}
                  <div className="rounded-md border border-border/60 bg-muted/30 p-2 space-y-1.5">
                    <label className="text-[11px] font-medium text-foreground block">
                      Tech Provider Approval Status
                    </label>
                    <p className="text-[10px] text-muted-foreground leading-snug">
                      Meta requires Tech Provider (or BSP) approval before Embedded Signup will load for users.
                      Set this once approval is granted.
                    </p>
                    <Select
                      value={tpStatus}
                      onValueChange={(v) => handleTpStatusChange(v as WhatsAppTpStatus)}
                      disabled={tpSaving}
                    >
                      <SelectTrigger className="h-7 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="not_started" className="text-xs">
                          Not started — hide Connect buttons
                        </SelectItem>
                        <SelectItem value="pending" className="text-xs">
                          Pending — show banner, buttons clickable
                        </SelectItem>
                        <SelectItem value="approved" className="text-xs">
                          Approved — normal flow
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <div className="flex flex-col gap-0.5 pt-1 text-[10px]">
                      <a
                        href="https://business.facebook.com/wa/manage/home/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        → Apply for Tech Provider program
                      </a>
                      <a
                        href="https://developers.facebook.com/docs/whatsapp/solution-providers/get-started-for-tech-providers"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        → Tech Provider documentation
                      </a>
                      <a
                        href="https://developers.facebook.com/docs/whatsapp/solution-providers/get-started-for-solution-partners"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        → BSP documentation (reference)
                      </a>
                    </div>
                  </div>

                  {waTestResult && (
                    <div className="space-y-1.5">
                      {waTestResult.facebook_app_id && (
                        <div className="text-[11px] px-2 py-1.5 rounded bg-muted/50 text-muted-foreground">
                          <span className="font-medium text-foreground">Active Facebook App ID:</span>{" "}
                          <span className="font-mono">{waTestResult.facebook_app_id}</span>
                          <div className="opacity-80 mt-0.5">
                            The Configuration IDs above must be created under this exact Meta App. If they were created in a different app or Business Manager, Meta will return "Unsupported get request".
                          </div>
                        </div>
                      )}
                      {(["cloud_api", "coexistence"] as const).map((mode) => {
                        const c = waTestResult[mode];
                        const label = mode === "cloud_api" ? "Cloud API" : "Coexistence";
                        return (
                          <div
                            key={mode}
                            className={`text-[11px] px-2 py-1.5 rounded flex items-start gap-1.5 ${
                              c.valid ? "bg-green-500/10 text-green-700" : "bg-destructive/10 text-destructive"
                            }`}
                          >
                            {c.valid ? (
                              <CheckCircle2 className="w-3 h-3 mt-0.5 shrink-0" />
                            ) : (
                              <XCircle className="w-3 h-3 mt-0.5 shrink-0" />
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="font-medium">
                                {label}{" "}
                                <span className="opacity-70 font-normal">
                                  {c.config_id ? `(${c.config_id})` : "(not set)"}
                                </span>
                              </div>
                              <div className="opacity-80 break-words">
                                {c.valid ? `${c.name ?? ""}${c.feature_type ? ` · ${c.feature_type}` : ""}` : c.error}
                              </div>
                              {!c.valid && c.hint && (
                                <div className="mt-1 text-[10px] opacity-90 break-words border-t border-destructive/20 pt-1">
                                  {c.hint}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <div className="flex items-center gap-1.5 pt-1">
                    <Button
                      size="sm"
                      className="h-7 text-xs gap-1"
                      onClick={handleWaSave}
                      disabled={waSaving}
                    >
                      {waSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                      Save
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs gap-1"
                      onClick={handleWaTest}
                      disabled={waTesting || getWaStatus() === "not_set"}
                    >
                      {waTesting ? <Loader2 className="w-3 h-3 animate-spin" /> : <TestTube className="w-3 h-3" />}
                      Test
                    </Button>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
