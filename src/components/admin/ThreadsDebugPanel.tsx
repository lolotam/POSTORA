import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, ShieldCheck, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface ThreadsAccount {
  id: string;
  platform_username: string | null;
}

interface ThreadsDebugPanelProps {
  accounts: ThreadsAccount[];
}

export function ThreadsDebugPanel({ accounts }: ThreadsDebugPanelProps) {
  const { toast } = useToast();
  const [accountId, setAccountId] = useState<string>(accounts[0]?.id || "");
  const [hypothetical, setHypothetical] = useState<"text" | "image" | "video" | "carousel">("image");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);

  if (accounts.length === 0) return null;

  const runDryRun = async () => {
    if (!accountId) return;
    setLoading(true);
    setResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("threads-debug-publish-check", {
        body: { account_id: accountId, hypothetical },
      });
      if (error) throw error;
      setResult(data);
    } catch (e: any) {
      toast({
        title: "Debug check failed",
        description: e?.message || String(e),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="border-dashed border-primary/30 bg-muted/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <ShieldCheck className="w-4 h-4" />
          Threads diagnostic (admin only)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2 items-center">
          <Select value={accountId} onValueChange={setAccountId}>
            <SelectTrigger className="w-[220px]">
              <SelectValue placeholder="Select Threads account" />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  @{a.platform_username || a.id.slice(0, 6)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={hypothetical} onValueChange={(v: any) => setHypothetical(v)}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="text">Text post</SelectItem>
              <SelectItem value="image">Image post</SelectItem>
              <SelectItem value="video">Video post</SelectItem>
              <SelectItem value="carousel">Carousel</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" onClick={runDryRun} disabled={loading || !accountId}>
            {loading ? <Loader2 className="w-3.5 h-3.5 me-1 animate-spin" /> : null}
            Run dry-run
          </Button>
        </div>

        {result && (
          <div className="space-y-2 text-xs">
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="outline">
                token len: {result.token?.length} prefix: {result.token?.prefix}
              </Badge>
              <Badge variant="outline">/me status: {result.meEndpointStatus}</Badge>
              {result.crossShareWouldBeSent ? (
                <Badge className="bg-emerald-500/10 text-emerald-600">cross-share would be sent</Badge>
              ) : (
                <Badge className="bg-amber-500/10 text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="w-3 h-3 me-1" />
                  cross-share skipped: {result.crossShareSkipReason || "n/a"}
                </Badge>
              )}
            </div>

            <div>
              <div className="font-medium mb-1">Granted scopes:</div>
              <div className="flex flex-wrap gap-1">
                {Array.isArray(result.scopes) && result.scopes.length > 0 ? (
                  result.scopes.map((s: string) => (
                    <Badge key={s} variant="secondary" className="text-[10px]">
                      {s}
                    </Badge>
                  ))
                ) : (
                  <span className="text-muted-foreground italic">none recorded (token may pre-date probe)</span>
                )}
              </div>
            </div>

            <div>
              <div className="font-medium mb-1">Capabilities:</div>
              <pre className="bg-background border rounded p-2 overflow-x-auto text-[11px]">
                {JSON.stringify(result.capabilities, null, 2)}
              </pre>
            </div>

            <div>
              <div className="font-medium mb-1">Sample payload (redacted):</div>
              <pre className="bg-background border rounded p-2 overflow-x-auto text-[11px]">
                {JSON.stringify(result.samplePayload, null, 2)}
              </pre>
            </div>

            <div>
              <div className="font-medium mb-1">/me echo:</div>
              <pre className="bg-background border rounded p-2 overflow-x-auto text-[11px]">
                {JSON.stringify(result.meEndpointBody, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
