import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Loader2, Shield, Users } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface EmailToggle {
  key: string;
  label: string;
  description: string;
  defaultValue: boolean;
}

const ADMIN_EMAIL_TOGGLES: EmailToggle[] = [
  { key: "admin_email_observability_alerts", label: "Observability Alerts", description: "Health score, error rate, and performance alerts", defaultValue: true },
  { key: "admin_email_token_health_alerts", label: "Token Health Alerts", description: "Overall token health drops below threshold", defaultValue: true },
  { key: "admin_email_token_failure_alerts", label: "Token Refresh Failure Alerts", description: "Individual token refresh failures summary", defaultValue: true },
  { key: "admin_email_ai_override_expiry", label: "AI Override Expiry Alerts", description: "AI model overrides expiring in 3 days", defaultValue: true },
  { key: "admin_email_scheduled_flags", label: "Scheduled Flag Notifications", description: "Scheduled feature flag changes executed", defaultValue: true },
  { key: "admin_email_whatsapp_disconnect_alerts", label: "WhatsApp Disconnect Alerts", description: "A user's WhatsApp account lost its connection and needs a new QR code", defaultValue: true },
];

const USER_EMAIL_TOGGLES: EmailToggle[] = [
  { key: "user_email_post_success", label: "Post Success", description: "Notification when a post is published successfully", defaultValue: false },
  { key: "user_email_post_failure", label: "Post Failure", description: "Notification when a post fails to publish", defaultValue: false },
  { key: "user_email_token_expiry", label: "Token Expiry Warnings", description: "Warning when social account tokens are expiring", defaultValue: false },
  { key: "user_email_expiry_reminders", label: "Subscription Expiry Reminders", description: "Reminder 7 days before subscription expires", defaultValue: false },
  { key: "user_email_subscription_changes", label: "Subscription Changes", description: "Confirmation emails for subscription events", defaultValue: false },
  { key: "user_email_weekly_summary", label: "Weekly Summary", description: "Weekly analytics summary email", defaultValue: false },
  { key: "user_email_blog_notifications", label: "Blog Post Notifications", description: "New blog post published notifications", defaultValue: false },
];

const ALL_KEYS = [...ADMIN_EMAIL_TOGGLES, ...USER_EMAIL_TOGGLES].map(t => t.key);

function parseSettingValue(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return null; }
  }
  return null;
}

export function AdminNotificationSettings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery({
    queryKey: ["admin-notification-email-settings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("app_settings")
        .select("key, value")
        .in("key", ALL_KEYS);
      if (error) throw error;
      const map: Record<string, boolean | null> = {};
      for (const row of data || []) {
        map[row.key] = parseSettingValue(row.value);
      }
      return map;
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: boolean }) => {
      const { error } = await supabase
        .from("app_settings")
        .upsert(
          { key, value: JSON.stringify(value) as any, updated_at: new Date().toISOString() },
          { onConflict: "key" }
        );
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-notification-email-settings"] });
    },
    onError: (error) => {
      toast({ title: "Error", description: error instanceof Error ? error.message : "Failed to update", variant: "destructive" });
    },
  });

  const getToggleValue = (toggle: EmailToggle): boolean => {
    const val = settings?.[toggle.key];
    return val !== null && val !== undefined ? val : toggle.defaultValue;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ToggleSection
        icon={<Shield className="w-5 h-5" />}
        title="Admin Notification Emails"
        description="Emails sent to admin accounts for system monitoring"
        toggles={ADMIN_EMAIL_TOGGLES}
        getToggleValue={getToggleValue}
        onToggle={(key, value) => toggleMutation.mutate({ key, value })}
        isPending={toggleMutation.isPending}
      />
      <ToggleSection
        icon={<Users className="w-5 h-5" />}
        title="User Notification Emails"
        description="Emails sent to user accounts — admin can globally enable/disable each type"
        toggles={USER_EMAIL_TOGGLES}
        getToggleValue={getToggleValue}
        onToggle={(key, value) => toggleMutation.mutate({ key, value })}
        isPending={toggleMutation.isPending}
      />
    </div>
  );
}

function ToggleSection({
  icon,
  title,
  description,
  toggles,
  getToggleValue,
  onToggle,
  isPending,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  toggles: EmailToggle[];
  getToggleValue: (t: EmailToggle) => boolean;
  onToggle: (key: string, value: boolean) => void;
  isPending: boolean;
}) {
  return (
    <div className="border rounded-xl overflow-hidden">
      <div className="px-5 py-4 bg-muted/30 border-b flex items-center gap-3">
        {icon}
        <div>
          <h3 className="font-semibold">{title}</h3>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="divide-y">
        {toggles.map((toggle) => (
          <div key={toggle.key} className="flex items-center justify-between px-5 py-4">
            <div className="space-y-0.5">
              <Label htmlFor={toggle.key} className="font-medium cursor-pointer">
                {toggle.label}
              </Label>
              <p className="text-xs text-muted-foreground">{toggle.description}</p>
            </div>
            <Switch
              id={toggle.key}
              checked={getToggleValue(toggle)}
              onCheckedChange={(checked) => onToggle(toggle.key, checked)}
              disabled={isPending}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
