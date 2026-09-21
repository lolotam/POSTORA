import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/docs";
import { Download, Bell } from "lucide-react";
import { Icon3D, GradientHeading, GradientRingCard, Reveal } from "@/components/fx";

const API_BASE = "https://api.postora.cloud/functions/v1/n8n-api";

const registerWebhookExample = `curl -X POST \\
  "${API_BASE}/api/v1/webhooks" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "webhook_url": "https://your-n8n.cloud/webhook/postora-webhook",
    "events": ["post.failed", "post.completed"]
  }'`;

interface FailureAlertsSectionProps {
  onDownloadAlerts: () => void;
  onDownloadSlackOnly: () => void;
}

export function FailureAlertsSection({ onDownloadAlerts, onDownloadSlackOnly }: FailureAlertsSectionProps) {
  return (
    <section className="container mx-auto px-6 py-20 border-t border-border/40">
      <Reveal className="text-center mb-12">
        <div className="flex flex-col items-center gap-4">
          <Icon3D icon={Bell} variant="amber" size="md" />
          <GradientHeading as="h2" preset="amber-rose-violet" size="lg">Failure Alerts Workflow</GradientHeading>
          <p className="text-muted-foreground max-w-2xl">
            Get instant Slack and/or email notifications when your posts fail to publish.
          </p>
        </div>
      </Reveal>

      <div className="max-w-4xl mx-auto space-y-6">
        <Reveal>
          <GradientRingCard variant="amber" ringIntensity="subtle">
            <h3 className="font-semibold mb-4 flex items-center gap-3">
              <span className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-400 via-orange-500 to-rose-500 text-white flex items-center justify-center text-sm font-bold shadow-md">1</span>
              Download the Alerts Workflow
            </h3>
            <p className="text-muted-foreground mb-4">Choose the workflow that fits your needs:</p>
            <div className="flex flex-wrap gap-3">
              <Button onClick={onDownloadAlerts} className="bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500 text-white shadow-md shadow-amber-500/30 hover:opacity-90">
                <Download className="w-4 h-4 me-2" />
                Slack + Email (Recommended)
              </Button>
              <Button onClick={onDownloadSlackOnly} variant="outline" className="border-amber-500/50 hover:bg-amber-500/10">
                <Download className="w-4 h-4 me-2" />
                Slack Only
              </Button>
            </div>
          </GradientRingCard>
        </Reveal>

        <Reveal delay={120}>
          <GradientRingCard variant="amber" ringIntensity="subtle">
            <h3 className="font-semibold mb-4 flex items-center gap-3">
              <span className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-400 via-orange-500 to-rose-500 text-white flex items-center justify-center text-sm font-bold shadow-md">2</span>
              Register Your Webhook in Postora
            </h3>
            <p className="text-muted-foreground mb-4">Copy the webhook URL from n8n and register it:</p>
            <CodeBlock id="register-alerts-webhook" language="bash" code={registerWebhookExample} />
          </GradientRingCard>
        </Reveal>
      </div>
    </section>
  );
}
