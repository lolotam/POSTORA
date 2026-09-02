import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Video } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";

const SETTING_KEY = "tiktok_sandbox_mode";

/**
 * Unlike the other switches on this page, this one swaps the credentials
 * `tiktok-oauth` uses for every connection attempt, so it is styled as a
 * destructive action and confirmed in both directions.
 */
export function TikTokSandboxToggle() {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [pendingValue, setPendingValue] = useState<boolean | null>(null);

  const { data: enabled = false, isLoading } = useQuery({
    queryKey: ["app-setting", SETTING_KEY],
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", SETTING_KEY)
        .maybeSingle();
      if (error) throw error;
      if (!data) return false;
      try {
        const parsed = typeof data.value === "string" ? JSON.parse(data.value) : data.value;
        return parsed === true || parsed === "true";
      } catch {
        return data.value === "true";
      }
    },
  });

  const toggle = useMutation({
    mutationFn: async (next: boolean) => {
      const { error } = await supabase
        .from("app_settings")
        .upsert(
          { key: SETTING_KEY, value: JSON.stringify(next), updated_at: new Date().toISOString() },
          { onConflict: "key" },
        );
      if (error) throw error;

      // A credential swap is worth an audit row even when the write succeeds silently.
      if (user?.id) {
        await supabase.from("feature_flag_audit_log").insert({
          feature_key: SETTING_KEY,
          old_value: enabled,
          new_value: next,
          changed_by: user.id,
          change_type: "manual",
        });
      }
    },
    onSuccess: (_data, next) => {
      queryClient.invalidateQueries({ queryKey: ["app-setting", SETTING_KEY] });
      queryClient.invalidateQueries({ queryKey: ["admin-settings"] });
      toast({
        title: next ? "Sandbox mode on" : "Production mode on",
        description: next
          ? "New TikTok connections will use sandbox credentials."
          : "New TikTok connections will use production credentials.",
      });
    },
    onError: (error) => {
      toast({
        title: "Could not switch mode",
        description: error instanceof Error ? error.message : "Try again.",
        variant: "destructive",
      });
    },
  });

  return (
    <>
      <Card className={enabled ? "border-destructive" : undefined}>
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3 min-w-0">
              <span
                className={`w-9 h-9 rounded-md flex items-center justify-center shrink-0 ${
                  enabled ? "bg-destructive/10" : "bg-muted"
                }`}
              >
                <Video className={`w-4 h-4 ${enabled ? "text-destructive" : "text-muted-foreground"}`} />
              </span>
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-medium">TikTok sandbox mode</p>
                  {enabled && <Badge variant="destructive">Sandbox</Badge>}
                </div>
                <p className="text-sm text-muted-foreground">
                  Swaps the credentials used for every new TikTok connection. While sandbox mode is on,
                  accounts connect to TikTok's test environment and posts do not reach real audiences.
                </p>
              </div>
            </div>
            {isLoading ? (
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground shrink-0" />
            ) : (
              <Switch
                checked={enabled}
                onCheckedChange={(next) => setPendingValue(next)}
                disabled={toggle.isPending}
                aria-label="TikTok sandbox mode"
                className="shrink-0"
              />
            )}
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={pendingValue !== null} onOpenChange={(open) => !open && setPendingValue(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-destructive" />
              {pendingValue ? "Switch to sandbox credentials?" : "Switch to production credentials?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingValue
                ? "New TikTok connections will use the sandbox app. Accounts connected in sandbox mode cannot publish to real TikTok profiles."
                : "New TikTok connections will use the production app and will publish to real TikTok profiles."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingValue !== null) toggle.mutate(pendingValue);
                setPendingValue(null);
              }}
            >
              {pendingValue ? "Turn on sandbox mode" : "Turn off sandbox mode"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
