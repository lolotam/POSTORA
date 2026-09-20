import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Bell, Mail, Loader2, Volume2, EyeOff } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";

export function NotificationsSection() {
  const { t } = useTranslation("accounts");
  const { profile, refreshProfile } = useAuth();
  const { toast } = useToast();
  const { flags } = useFeatureFlags();
  const [emailNotificationsEnabled, setEmailNotificationsEnabled] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [postSuccessEnabled, setPostSuccessEnabled] = useState(false);
  const [postFailureEnabled, setPostFailureEnabled] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingSound, setIsSavingSound] = useState(false);
  const [isSavingPostSuccess, setIsSavingPostSuccess] = useState(false);
  const [isSavingPostFailure, setIsSavingPostFailure] = useState(false);

  useEffect(() => {
    if (profile) {
      setEmailNotificationsEnabled(profile.email_notifications_enabled ?? false);
      setSoundEnabled(profile.notification_sound_enabled ?? false);
      setPostSuccessEnabled(profile.post_success_notifications_enabled ?? false);
      setPostFailureEnabled(profile.post_failure_notifications_enabled ?? false);
    }
  }, [profile]);

  const handleEmailNotificationsChange = async (enabled: boolean) => {
    if (!profile) return;

    setIsSaving(true);
    setEmailNotificationsEnabled(enabled);

    const { error } = await supabase
      .from("profiles")
      .update({ email_notifications_enabled: enabled })
      .eq("id", profile.id);

    if (error) {
      setEmailNotificationsEnabled(!enabled);
      toast({
        title: t("common:error", "Error"),
        description: t("notifications.toast.emailFailed", "Failed to update email preferences."),
        variant: "destructive",
      });
    } else {
      await refreshProfile();
      toast({
        title: enabled ? t("notifications.toast.emailOn", "Email notifications enabled") : t("notifications.toast.emailOff", "Email notifications disabled"),
        description: enabled
          ? t("notifications.toast.emailOnDesc", "You'll receive emails about new updates.")
          : t("notifications.toast.emailOffDesc", "You won't receive update emails anymore."),
      });
    }

    setIsSaving(false);
  };

  const handleSoundChange = async (enabled: boolean) => {
    if (!profile) return;

    setIsSavingSound(true);
    setSoundEnabled(enabled);

    const { error } = await supabase
      .from("profiles")
      .update({ notification_sound_enabled: enabled })
      .eq("id", profile.id);

    if (error) {
      setSoundEnabled(!enabled);
      toast({
        title: t("common:error", "Error"),
        description: t("notifications.toast.soundFailed", "Failed to update sound preferences."),
        variant: "destructive",
      });
    } else {
      await refreshProfile();
      toast({
        title: enabled ? t("notifications.toast.soundOn", "Sound notifications enabled") : t("notifications.toast.soundOff", "Sound notifications disabled"),
        description: enabled
          ? t("notifications.toast.soundOnDesc", "You'll hear sounds when posts publish.")
          : t("notifications.toast.soundOffDesc", "Sound notifications are now muted."),
      });
    }

    setIsSavingSound(false);
  };

  const handlePostSuccessChange = async (enabled: boolean) => {
    if (!profile) return;

    setIsSavingPostSuccess(true);
    setPostSuccessEnabled(enabled);

    const { error } = await supabase
      .from("profiles")
      .update({ post_success_notifications_enabled: enabled })
      .eq("id", profile.id);

    if (error) {
      setPostSuccessEnabled(!enabled);
      toast({
        title: t("common:error", "Error"),
        description: t("notifications.toast.successFailed", "Failed to update post success preferences."),
        variant: "destructive",
      });
    } else {
      await refreshProfile();
      toast({
        title: enabled ? t("notifications.toast.successOn", "Post success notifications enabled") : t("notifications.toast.successOff", "Post success notifications disabled"),
        description: enabled
          ? t("notifications.toast.successOnDesc", "You'll be notified when posts are published.")
          : t("notifications.toast.successOffDesc", "Post success notifications are now disabled."),
      });
    }

    setIsSavingPostSuccess(false);
  };

  const handlePostFailureChange = async (enabled: boolean) => {
    if (!profile) return;

    setIsSavingPostFailure(true);
    setPostFailureEnabled(enabled);

    const { error } = await supabase
      .from("profiles")
      .update({ post_failure_notifications_enabled: enabled })
      .eq("id", profile.id);

    if (error) {
      setPostFailureEnabled(!enabled);
      toast({
        title: t("common:error", "Error"),
        description: t("notifications.toast.failureFailed", "Failed to update post failure preferences."),
        variant: "destructive",
      });
    } else {
      await refreshProfile();
      toast({
        title: enabled ? t("notifications.toast.failureOn", "Post failure notifications enabled") : t("notifications.toast.failureOff", "Post failure notifications disabled"),
        description: enabled
          ? t("notifications.toast.failureOnDesc", "You'll be notified when posts fail.")
          : t("notifications.toast.failureOffDesc", "Post failure notifications are now disabled."),
      });
    }

    setIsSavingPostFailure(false);
  };

  const emailNotificationsAvailable = flags.emailNotifications;

  return (
    <div className="rounded-xl border border-border bg-card/50 p-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
          <Bell className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h2 className="font-semibold">{t("notifications.header.title", "Notifications")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("notifications.header.subtitle", "Configure how you receive updates")}
          </p>
        </div>
      </div>

      <div className="space-y-4">
        {/* Sound Notifications Section */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Volume2 className="w-4 h-4 text-muted-foreground" />
            <div>
              <p className="font-medium text-sm">{t("notifications.sound.title", "Sound Notifications")}</p>
              <p className="text-xs text-muted-foreground">
                {t("notifications.sound.desc", "Play sounds when posts publish or fail")}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isSavingSound && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
            <Switch
              checked={soundEnabled}
              onCheckedChange={handleSoundChange}
              disabled={isSavingSound}
            />
          </div>
        </div>
        <Separator />

        {/* Email Notifications Section - gated by feature flag */}
        {emailNotificationsAvailable ? (
          <>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Mail className="w-4 h-4 text-muted-foreground" />
                <div>
                  <p className="font-medium text-sm">{t("notifications.email.title", "Email Notifications")}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("notifications.email.desc", "Token expiry warnings, connection alerts & announcements")}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {isSaving && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
                <Switch
                  checked={emailNotificationsEnabled}
                  onCheckedChange={handleEmailNotificationsChange}
                  disabled={isSaving}
                />
              </div>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-sm">{t("notifications.postSuccess.title", "Post Success")}</p>
                <p className="text-xs text-muted-foreground">
                  {t("notifications.postSuccess.desc", "Get notified when posts are published")}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {isSavingPostSuccess && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
                <Switch
                  checked={postSuccessEnabled}
                  onCheckedChange={handlePostSuccessChange}
                  disabled={isSavingPostSuccess}
                />
              </div>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-sm">{t("notifications.postFailure.title", "Post Failures")}</p>
                <p className="text-xs text-muted-foreground">
                  {t("notifications.postFailure.desc", "Get notified when posts fail")}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {isSavingPostFailure && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
                <Switch
                  checked={postFailureEnabled}
                  onCheckedChange={handlePostFailureChange}
                  disabled={isSavingPostFailure}
                />
              </div>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-sm">{t("notifications.weekly.title", "Weekly Summary")}</p>
                <p className="text-xs text-muted-foreground">
                  {t("notifications.weekly.desc", "Receive a weekly report of your activity")}
                </p>
              </div>
              <Switch />
            </div>
          </>
        ) : (
          <div className="flex items-center gap-3 py-2">
            <EyeOff className="w-4 h-4 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {t("notifications.email.unavailable", "Email notifications are currently not available.")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
