import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import {
  Key,
  Copy,
  RefreshCw,
  Check,
} from "lucide-react";

export function ApiKeySection() {
  const { t } = useTranslation("accounts");
  const { toast } = useToast();
  const { profile, refreshProfile } = useAuth();
  const [copied, setCopied] = useState(false);

  const apiKey = profile?.api_key || t("apiKey.notAvailable", "Not available");

  const handleCopyApiKey = () => {
    navigator.clipboard.writeText(apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast({
      title: t("apiKey.toast.copied", "API Key copied"),
      description: t("apiKey.toast.copiedDesc", "The API key has been copied to your clipboard."),
    });
  };

  const handleRegenerateApiKey = async () => {
    if (!profile) return;

    const newApiKey = `postora-${crypto.randomUUID()}`;
    const { error } = await supabase
      .from("profiles")
      .update({ api_key: newApiKey })
      .eq("id", profile.id);

    if (error) {
      toast({
        title: t("common:error", "Error"),
        description: t("apiKey.toast.regenFailed", "Failed to regenerate API key."),
        variant: "destructive",
      });
    } else {
      await refreshProfile();
      toast({
        title: t("apiKey.toast.regenerated", "API Key regenerated"),
        description: t("apiKey.toast.regeneratedDesc", "Your new API key is ready to use."),
      });
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card/50 p-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
          <Key className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h2 className="font-semibold">{t("apiKey.header.title", "API Access")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("apiKey.header.subtitle", "Use this key to integrate with n8n or other tools")}
          </p>
        </div>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label>{t("apiKey.form.label", "API Key")}</Label>
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <Input
                value={apiKey}
                readOnly
                className="pe-20 font-mono text-sm"
              />
              <Button
                variant="ghost"
                size="sm"
                className="absolute end-1 top-1/2 -translate-y-1/2"
                onClick={handleCopyApiKey}
              >
                {copied ? (
                  <Check className="w-4 h-4 text-emerald-400" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </Button>
            </div>
            <Button variant="outline" size="icon" onClick={handleRegenerateApiKey}>
              <RefreshCw className="w-4 h-4" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("apiKey.form.secretHint", "Keep this key secret. Never share it publicly.")}
          </p>
        </div>

        <div className="p-4 rounded-lg bg-secondary/50">
          <p className="text-sm font-medium mb-2">{t("apiKey.endpoints.title", "API Endpoints")}</p>
          <code className="text-xs text-muted-foreground block">
            POST https://api.postora.cloud/functions/v1/api/post
          </code>
          <code className="text-xs text-muted-foreground block mt-1">
            GET https://api.postora.cloud/functions/v1/api/accounts
          </code>
        </div>
      </div>
    </div>
  );
}
