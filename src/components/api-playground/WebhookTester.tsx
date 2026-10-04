import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Webhook, Loader2, TestTube, Eye } from "lucide-react";
import { cn } from "@/lib/utils";

interface WebhookTesterProps {
  webhookUrl: string;
  setWebhookUrl: (url: string) => void;
  apiKey: string;
  isTestingWebhook: boolean;
  webhookTestResult: any;
  onTest: () => void;
}

export function WebhookTester({
  webhookUrl, setWebhookUrl, apiKey, isTestingWebhook, webhookTestResult, onTest,
}: WebhookTesterProps) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Webhook className="w-5 h-5" /> Webhook Testing Tool
          </CardTitle>
          <CardDescription>Test your webhook endpoint by sending a sample payload</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="test-webhook-url">Webhook URL</Label>
            <Input
              id="test-webhook-url"
              placeholder="https://your-domain.com/webhook/postora"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              className="mt-1.5"
            />
          </div>
          <div className="p-4 rounded-lg bg-muted/50 border">
            <h4 className="font-medium mb-2">Test Payload Preview</h4>
            <pre className="text-xs bg-background p-3 rounded overflow-x-auto">
              <code>{JSON.stringify({
                event: "test",
                timestamp: new Date().toISOString(),
                data: {
                  message: "This is a test webhook from Postora",
                  post: { id: "test-post-id", caption: "Test post caption", platforms: ["facebook", "instagram"], status: "completed" },
                },
              }, null, 2)}</code>
            </pre>
          </div>
          <Button onClick={onTest} disabled={isTestingWebhook || !apiKey || !webhookUrl} className="w-full gap-2">
            {isTestingWebhook ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Sending Test...</>
            ) : (
              <><TestTube className="w-4 h-4" /> Send Test Webhook</>
            )}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Eye className="w-5 h-5" /> Test Result
            {webhookTestResult && (
              <Badge variant={webhookTestResult.success ? "default" : "destructive"}>
                {webhookTestResult.success ? "Success" : "Failed"}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[400px]">
            {webhookTestResult ? (
              <pre className={cn(
                "text-sm p-4 rounded-lg overflow-x-auto",
                webhookTestResult.success ? "bg-green-500/10 border border-green-500/20" : "bg-red-500/10 border border-red-500/20"
              )}>
                <code>{JSON.stringify(webhookTestResult, null, 2)}</code>
              </pre>
            ) : (
              <div className="flex flex-col items-center justify-center h-[380px] text-muted-foreground">
                <Webhook className="w-12 h-12 mb-4 opacity-50" />
                <p className="text-sm">Test result will appear here</p>
                <p className="text-xs mt-1">Enter a webhook URL and click "Send Test Webhook"</p>
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
