import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, ChevronUp, Bug, Copy, Check, AlertTriangle, CheckCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface TikTokDebugInfo {
  environment: "sandbox" | "production";
  requestedScopes: string[];
  redirectUri: string;
  clientKeyPrefix: string;
  lastError: string | null;
  lastErrorTimestamp: string | null;
}

export function TikTokDebugPanel() {
  const [isOpen, setIsOpen] = useState(false);
  const [debugInfo, setDebugInfo] = useState<TikTokDebugInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const { toast } = useToast();

  const fetchDebugInfo = async () => {
    setLoading(true);
    try {
      // Fetch sandbox mode setting
      const { data: settings } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", "tiktok_sandbox_mode")
        .single();

      const isSandbox = settings?.value === true || settings?.value === "true" || JSON.parse(String(settings?.value || "false"));

      // Get last OAuth error from session storage
      const lastError = sessionStorage.getItem("tiktok_last_error");
      const lastErrorTimestamp = sessionStorage.getItem("tiktok_last_error_timestamp");

      const productionDomain = "https://postora.cloud";
      const redirectUri = `${productionDomain}/tiktok-callback`;

      setDebugInfo({
        environment: isSandbox ? "sandbox" : "production",
        requestedScopes: ["user.info.basic", "user.info.profile", "video.upload", "video.publish"],
        redirectUri,
        clientKeyPrefix: isSandbox ? "sb..." : "aw...",
        lastError,
        lastErrorTimestamp,
      });
    } catch (error) {
      console.error("Error fetching TikTok debug info:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && !debugInfo) {
      fetchDebugInfo();
    }
  }, [isOpen]);

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
    toast({ platform: "tiktok", title: "Copied!", description: `${label} copied to clipboard` });
  };

  const clearLastError = () => {
    sessionStorage.removeItem("tiktok_last_error");
    sessionStorage.removeItem("tiktok_last_error_timestamp");
    setDebugInfo(prev => prev ? { ...prev, lastError: null, lastErrorTimestamp: null } : null);
    toast({ platform: "tiktok", title: "Cleared", description: "Last error cleared" });
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <Card className="border-dashed border-muted-foreground/30">
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors py-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Bug className="w-4 h-4 text-muted-foreground" />
                <CardTitle className="text-sm font-medium">TikTok OAuth Debug</CardTitle>
              </div>
              {isOpen ? (
                <ChevronUp className="w-4 h-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="w-4 h-4 text-muted-foreground" />
              )}
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0 space-y-4">
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : debugInfo ? (
              <>
                {/* Environment */}
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Environment</span>
                  <Badge variant={debugInfo.environment === "sandbox" ? "secondary" : "default"}>
                    {debugInfo.environment === "sandbox" ? "🧪 Sandbox" : "🚀 Production"}
                  </Badge>
                </div>

                {/* Client Key Prefix */}
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Client Key</span>
                  <code className="text-xs bg-muted px-2 py-1 rounded">
                    {debugInfo.clientKeyPrefix}
                  </code>
                </div>

                {/* Redirect URI */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Redirect URI</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2"
                      onClick={() => copyToClipboard(debugInfo.redirectUri, "Redirect URI")}
                    >
                      {copied === "Redirect URI" ? (
                        <Check className="w-3 h-3" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                    </Button>
                  </div>
                  <code className="text-xs bg-muted px-2 py-1 rounded block break-all">
                    {debugInfo.redirectUri}
                  </code>
                </div>

                {/* Requested Scopes */}
                <div className="space-y-1">
                  <span className="text-sm text-muted-foreground">Requested Scopes</span>
                  <div className="flex flex-wrap gap-1">
                    {debugInfo.requestedScopes.map((scope) => (
                      <Badge key={scope} variant="outline" className="text-xs">
                        {scope}
                      </Badge>
                    ))}
                  </div>
                </div>

                {/* Last Error */}
                {debugInfo.lastError && (
                  <div className="space-y-2 p-3 bg-destructive/10 rounded-lg border border-destructive/20">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 text-destructive" />
                        <span className="text-sm font-medium text-destructive">Last Error</span>
                      </div>
                      <Button variant="ghost" size="sm" className="h-6 px-2" onClick={clearLastError}>
                        Clear
                      </Button>
                    </div>
                    <code className="text-xs block break-all text-destructive">
                      {debugInfo.lastError}
                    </code>
                    {debugInfo.lastErrorTimestamp && (
                      <p className="text-xs text-muted-foreground">
                        {new Date(debugInfo.lastErrorTimestamp).toLocaleString()}
                      </p>
                    )}
                  </div>
                )}

                {!debugInfo.lastError && (
                  <div className="flex items-center gap-2 p-3 bg-green-500/10 rounded-lg border border-green-500/20">
                    <CheckCircle className="w-4 h-4 text-green-600" />
                    <span className="text-sm text-green-600">No recent errors</span>
                  </div>
                )}

                {/* Refresh Button */}
                <Button variant="outline" size="sm" onClick={fetchDebugInfo} className="w-full">
                  Refresh Debug Info
                </Button>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No debug info available</p>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
