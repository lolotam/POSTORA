import { Link } from "react-router-dom";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/useAuth";
import {
  Webhook, Copy, Check, AlertCircle, CheckCircle2, Clock, 
  ArrowRight, Code, RefreshCw, Shield, Zap, Bell, Terminal,
  FileJson, ExternalLink, AlertTriangle, Info
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { toast } from "sonner";

export default function WebhookGuide() {
  const { user } = useAuth();
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const copyCode = async (code: string, id: string) => {
    await navigator.clipboard.writeText(code);
    setCopiedCode(id);
    setTimeout(() => setCopiedCode(null), 2000);
    toast.success("Copied to clipboard");
  };

  const webhookEvents = [
    {
      event: "post.created",
      description: "Fired when a new post is created",
      payload: `{
  "event": "post.created",
  "timestamp": "2025-01-10T12:00:00Z",
  "data": {
    "post_id": "abc123-uuid",
    "platforms": ["instagram", "facebook"],
    "status": "pending",
    "scheduled_at": null
  }
}`
    },
    {
      event: "post.processing",
      description: "Fired when post processing begins",
      payload: `{
  "event": "post.processing",
  "timestamp": "2025-01-10T12:00:05Z",
  "data": {
    "post_id": "abc123-uuid",
    "platform": "instagram",
    "status": "processing"
  }
}`
    },
    {
      event: "post.success",
      description: "Fired when a post is successfully published",
      payload: `{
  "event": "post.success",
  "timestamp": "2025-01-10T12:00:15Z",
  "data": {
    "post_id": "abc123-uuid",
    "platform": "instagram",
    "platform_post_id": "17841478425635377",
    "platform_post_url": "https://instagram.com/p/...",
    "posted_at": "2025-01-10T12:00:15Z"
  }
}`
    },
    {
      event: "post.failed",
      description: "Fired when a post fails to publish",
      payload: `{
  "event": "post.failed",
  "timestamp": "2025-01-10T12:00:15Z",
  "data": {
    "post_id": "abc123-uuid",
    "platform": "instagram",
    "error": "Invalid media format",
    "error_code": "INVALID_MEDIA"
  }
}`
    },
    {
      event: "post.completed",
      description: "Fired when all platforms for a post are done",
      payload: `{
  "event": "post.completed",
  "timestamp": "2025-01-10T12:00:20Z",
  "data": {
    "post_id": "abc123-uuid",
    "status": "completed",
    "results": {
      "instagram": { "success": true, "post_id": "..." },
      "facebook": { "success": true, "post_id": "..." }
    }
  }
}`
    }
  ];

  const n8nWebhookExample = `{
  "nodes": [
    {
      "name": "Webhook",
      "type": "n8n-nodes-base.webhook",
      "parameters": {
        "httpMethod": "POST",
        "path": "postora-webhook",
        "responseMode": "responseNode"
      }
    },
    {
      "name": "Filter Success",
      "type": "n8n-nodes-base.if",
      "parameters": {
        "conditions": {
          "string": [{
            "value1": "={{ $json.event }}",
            "operation": "equals",
            "value2": "post.success"
          }]
        }
      }
    },
    {
      "name": "Send Slack Notification",
      "type": "n8n-nodes-base.slack",
      "parameters": {
        "channel": "#social-media",
        "text": "✅ Post published on {{ $json.data.platform }}"
      }
    }
  ]
}`;

  const expressWebhookHandler = `const express = require('express');
const crypto = require('crypto');
const app = express();

// Verify webhook signature
function verifySignature(payload, signature, secret) {
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(\`sha256=\${expectedSignature}\`)
  );
}

app.post('/webhook/postora', express.json(), (req, res) => {
  const signature = req.headers['x-postora-signature'];
  
  // Verify signature if secret is configured
  if (process.env.WEBHOOK_SECRET) {
    if (!verifySignature(req.body, signature, process.env.WEBHOOK_SECRET)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  const { event, data } = req.body;
  
  switch (event) {
    case 'post.success':
      console.log(\`✅ Post \${data.post_id} published on \${data.platform}\`);
      console.log(\`   URL: \${data.platform_post_url}\`);
      break;
      
    case 'post.failed':
      console.error(\`❌ Post \${data.post_id} failed on \${data.platform}\`);
      console.error(\`   Error: \${data.error}\`);
      // Send alert, retry, or log to monitoring
      break;
      
    case 'post.completed':
      console.log(\`🎉 All platforms completed for \${data.post_id}\`);
      // Update your database, send summary email, etc.
      break;
  }
  
  res.json({ received: true });
});

app.listen(3000);`;

  const pythonWebhookHandler = `from flask import Flask, request, jsonify
import hmac
import hashlib
import os

app = Flask(__name__)

def verify_signature(payload, signature, secret):
    expected = hmac.new(
        secret.encode(),
        payload.encode(),
        hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(f"sha256={expected}", signature)

@app.route('/webhook/postora', methods=['POST'])
def handle_webhook():
    signature = request.headers.get('X-Postora-Signature', '')
    
    # Verify signature if secret is configured
    if os.environ.get('WEBHOOK_SECRET'):
        if not verify_signature(
            request.data.decode(),
            signature,
            os.environ['WEBHOOK_SECRET']
        ):
            return jsonify({'error': 'Invalid signature'}), 401
    
    data = request.json
    event = data.get('event')
    event_data = data.get('data', {})
    
    if event == 'post.success':
        print(f"✅ Post {event_data['post_id']} published on {event_data['platform']}")
        print(f"   URL: {event_data.get('platform_post_url', 'N/A')}")
        
    elif event == 'post.failed':
        print(f"❌ Post {event_data['post_id']} failed on {event_data['platform']}")
        print(f"   Error: {event_data.get('error', 'Unknown')}")
        # Send alert or retry logic
        
    elif event == 'post.completed':
        print(f"🎉 All platforms completed for {event_data['post_id']}")
        # Update database, send notifications, etc.
    
    return jsonify({'received': True})

if __name__ == '__main__':
    app.run(port=3000)`;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-border bg-background">
        <div className="container mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 sm:gap-4 min-w-0">
            <Link to="/" className="shrink-0"><Logo /></Link>
            <span className="text-muted-foreground max-sm:hidden">/</span>
            <Link to="/docs" className="text-muted-foreground hover:text-foreground max-sm:hidden">Docs</Link>
            <span className="text-muted-foreground">/</span>
            <span className="font-medium flex items-center gap-2 min-w-0">
              <Webhook className="w-4 h-4 shrink-0" />
              <span className="truncate">Webhooks</span>
            </span>
          </div>
          <div className="flex items-center gap-4 shrink-0">
            {user ? (
              <Link to="/dashboard"><Button variant="gradient">Dashboard</Button></Link>
            ) : (
              <Link to="/auth"><Button variant="gradient">Get Started</Button></Link>
            )}
          </div>
        </div>
      </header>

      <main className="container mx-auto px-6 py-12 max-w-5xl">
        {/* Hero */}
        <div className="mb-12">
          <div className="flex items-center gap-4 mb-4">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center bg-primary">
              <Webhook className="w-8 h-8 text-primary-foreground" />
            </div>
            <div>
              <Badge className="mb-2" variant="secondary">Webhooks</Badge>
              <h1 className="text-4xl font-bold">Real-Time Post Status Callbacks</h1>
            </div>
          </div>
          <p className="text-xl text-muted-foreground max-w-2xl mt-4">
            Receive instant notifications when your posts are published, fail, or complete across all platforms.
          </p>
        </div>

        {/* How Webhooks Work */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Info className="w-5 h-5 text-primary" />
              How Webhooks Work
            </CardTitle>
            <CardDescription>
              Understand the webhook flow for async post operations
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid md:grid-cols-4 gap-4">
              <div className="flex flex-col items-center text-center p-4 rounded-lg bg-muted/50">
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center mb-2">
                  <span className="text-lg font-bold text-primary">1</span>
                </div>
                <h4 className="font-medium mb-1">Create Post</h4>
                <p className="text-sm text-muted-foreground">You call the POST API endpoint</p>
              </div>
              <div className="flex flex-col items-center text-center p-4 rounded-lg bg-muted/50">
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center mb-2">
                  <span className="text-lg font-bold text-primary">2</span>
                </div>
                <h4 className="font-medium mb-1">Async Processing</h4>
                <p className="text-sm text-muted-foreground">Post queued for each platform</p>
              </div>
              <div className="flex flex-col items-center text-center p-4 rounded-lg bg-muted/50">
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center mb-2">
                  <span className="text-lg font-bold text-primary">3</span>
                </div>
                <h4 className="font-medium mb-1">Platform Publishes</h4>
                <p className="text-sm text-muted-foreground">Each platform processes media</p>
              </div>
              <div className="flex flex-col items-center text-center p-4 rounded-lg bg-muted/50">
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center mb-2">
                  <span className="text-lg font-bold text-primary">4</span>
                </div>
                <h4 className="font-medium mb-1">Webhook Fires</h4>
                <p className="text-sm text-muted-foreground">You receive status callback</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Configuration */}
        <Card className="mb-8 border-primary/20 bg-primary/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-primary" />
              Configure Your Webhook Endpoint
            </CardTitle>
            <CardDescription>
              Add a webhook URL when creating posts to receive status callbacks
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div>
                <h4 className="font-medium mb-2">Include in POST Request</h4>
                <div className="relative">
                  <pre className="text-sm bg-muted p-4 rounded-lg overflow-x-auto">
                    <code>{`{
  "operation": "upload_photos",
  "platforms": ["instagram", "facebook"],
  "account_ids": ["17841478425635377", "942626662258010"],
  "caption": "My awesome post!",
  "media_urls": "https://example.com/image.jpg",
  
  // Webhook configuration
  "webhook_url": "https://your-domain.com/webhook/postora",
  "webhook_secret": "your-optional-secret-for-signature-verification"
}`}</code>
                  </pre>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute top-2 end-2"
                    onClick={() => copyCode(`{
  "operation": "upload_photos",
  "platforms": ["instagram", "facebook"],
  "account_ids": ["17841478425635377", "942626662258010"],
  "caption": "My awesome post!",
  "media_urls": "https://example.com/image.jpg",
  "webhook_url": "https://your-domain.com/webhook/postora",
  "webhook_secret": "your-optional-secret-for-signature-verification"
}`, "webhook-config")}
                  >
                    {copiedCode === "webhook-config" ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </Button>
                </div>
              </div>

              <div className="p-4 rounded-lg bg-amber-500/10 border border-amber-500/20">
                <p className="text-sm flex items-start gap-2">
                  <Shield className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
                  <span>
                    <strong>Security Tip:</strong> Always use HTTPS for your webhook URL and configure a <code className="text-xs bg-muted px-1 rounded">webhook_secret</code> to verify the authenticity of incoming requests.
                  </span>
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Event Types */}
        <h2 className="text-2xl font-bold mb-4">Webhook Event Types</h2>
        <div className="space-y-4 mb-8">
          {webhookEvents.map((event, index) => (
            <Card key={index}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Badge variant={event.event.includes("failed") ? "destructive" : event.event.includes("success") ? "default" : "secondary"}>
                      {event.event}
                    </Badge>
                  </CardTitle>
                </div>
                <CardDescription>{event.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="relative">
                  <pre className="text-sm bg-muted p-4 rounded-lg overflow-x-auto">
                    <code>{event.payload}</code>
                  </pre>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute top-2 end-2"
                    onClick={() => copyCode(event.payload, `event-${index}`)}
                  >
                    {copiedCode === `event-${index}` ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Implementation Examples */}
        <h2 className="text-2xl font-bold mb-4">Implementation Examples</h2>
        <Tabs defaultValue="n8n" className="mb-8">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="n8n">n8n Workflow</TabsTrigger>
            <TabsTrigger value="nodejs">Node.js / Express</TabsTrigger>
            <TabsTrigger value="python">Python / Flask</TabsTrigger>
          </TabsList>
          
          <TabsContent value="n8n">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Zap className="w-5 h-5" />
                  n8n Webhook Receiver Workflow
                </CardTitle>
                <CardDescription>
                  Create an n8n workflow to receive and process webhook events
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="p-4 rounded-lg bg-muted/50 border">
                    <h4 className="font-medium mb-2">Workflow Setup Steps</h4>
                    <ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground">
                      <li>Add a <strong>Webhook</strong> node with POST method and custom path (e.g., "postora-webhook")</li>
                      <li>Copy the production URL from n8n (e.g., https://your-n8n.com/webhook/postora-webhook)</li>
                      <li>Add an <strong>If</strong> node to filter by event type</li>
                      <li>Connect notification nodes (Slack, Discord, Email) for each event type</li>
                      <li>Use the webhook URL in your Postora API requests</li>
                    </ol>
                  </div>
                  
                  <div className="relative">
                    <pre className="text-sm bg-[#0d1117] text-gray-200 p-4 rounded-lg overflow-x-auto">
                      <code>{n8nWebhookExample}</code>
                    </pre>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="absolute top-2 end-2 text-gray-400 hover:text-white"
                      onClick={() => copyCode(n8nWebhookExample, "n8n")}
                    >
                      {copiedCode === "n8n" ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
          
          <TabsContent value="nodejs">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Terminal className="w-5 h-5" />
                  Node.js / Express Webhook Handler
                </CardTitle>
                <CardDescription>
                  Complete Express.js handler with signature verification
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="relative">
                  <pre className="text-sm bg-[#0d1117] text-gray-200 p-4 rounded-lg overflow-x-auto">
                    <code>{expressWebhookHandler}</code>
                  </pre>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute top-2 end-2 text-gray-400 hover:text-white"
                    onClick={() => copyCode(expressWebhookHandler, "nodejs")}
                  >
                    {copiedCode === "nodejs" ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
          
          <TabsContent value="python">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Code className="w-5 h-5" />
                  Python / Flask Webhook Handler
                </CardTitle>
                <CardDescription>
                  Flask handler with HMAC signature verification
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="relative">
                  <pre className="text-sm bg-[#0d1117] text-gray-200 p-4 rounded-lg overflow-x-auto">
                    <code>{pythonWebhookHandler}</code>
                  </pre>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute top-2 end-2 text-gray-400 hover:text-white"
                    onClick={() => copyCode(pythonWebhookHandler, "python")}
                  >
                    {copiedCode === "python" ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Strict Field Naming Warning */}
        <Card className="mb-8 border-red-500/20 bg-red-500/5">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-red-500 mt-0.5 flex-shrink-0" />
              <div>
                <h4 className="font-semibold mb-1">Strict Field Naming for account_ids</h4>
                <p className="text-sm text-muted-foreground mb-2">
                  Only <code className="px-1 bg-muted rounded text-xs">account_ids</code> or <code className="px-1 bg-muted rounded text-xs">ACCOUNT_IDS</code> are accepted as field names. Any other variant (account_id, id, social_account_id, etc.) will return a <strong>400 error</strong>.
                </p>
                <p className="text-sm text-muted-foreground">
                  ⚠️ Always send large numeric IDs as <strong>strings</strong> (e.g., <code className="px-1 bg-muted rounded text-xs">"34767551309502570"</code>). Numbers exceeding JavaScript's safe integer limit will lose precision.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Best Practices */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-green-500" />
              Best Practices
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid md:grid-cols-2 gap-4">
              <div className="p-4 rounded-lg bg-muted/50 border">
                <h4 className="font-medium mb-2 flex items-center gap-2">
                  <RefreshCw className="w-4 h-4 text-primary" />
                  Respond Quickly
                </h4>
                <p className="text-sm text-muted-foreground">
                  Respond with 200 OK within 30 seconds. Process heavy tasks asynchronously after responding.
                </p>
              </div>
              
              <div className="p-4 rounded-lg bg-muted/50 border">
                <h4 className="font-medium mb-2 flex items-center gap-2">
                  <Shield className="w-4 h-4 text-primary" />
                  Verify Signatures
                </h4>
                <p className="text-sm text-muted-foreground">
                  Always verify the <code className="text-xs bg-muted px-1 rounded">x-postora-signature</code> header to prevent spoofing.
                </p>
              </div>
              
              <div className="p-4 rounded-lg bg-muted/50 border">
                <h4 className="font-medium mb-2 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-primary" />
                  Handle Retries
                </h4>
                <p className="text-sm text-muted-foreground">
                  Webhooks may be retried on failure. Use idempotency keys to prevent duplicate processing.
                </p>
              </div>
              
              <div className="p-4 rounded-lg bg-muted/50 border">
                <h4 className="font-medium mb-2 flex items-center gap-2">
                  <Bell className="w-4 h-4 text-primary" />
                  Log Everything
                </h4>
                <p className="text-sm text-muted-foreground">
                  Log all incoming webhooks for debugging. Include timestamps and full payloads.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Webhook Headers */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileJson className="w-5 h-5" />
              Webhook Request Headers
            </CardTitle>
            <CardDescription>
              Headers included in every webhook request
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[32rem] text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-start py-2 px-4 font-medium">Header</th>
                    <th className="text-start py-2 px-4 font-medium">Description</th>
                    <th className="text-start py-2 px-4 font-medium">Example</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b">
                    <td className="py-2 px-4"><code className="text-xs bg-muted px-1 rounded">Content-Type</code></td>
                    <td className="py-2 px-4 text-muted-foreground">Always JSON</td>
                    <td className="py-2 px-4"><code className="text-xs bg-muted px-1 rounded">application/json</code></td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2 px-4"><code className="text-xs bg-muted px-1 rounded">X-Postora-Event</code></td>
                    <td className="py-2 px-4 text-muted-foreground">Event type</td>
                    <td className="py-2 px-4"><code className="text-xs bg-muted px-1 rounded">post.success</code></td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2 px-4"><code className="text-xs bg-muted px-1 rounded">X-Postora-Signature</code></td>
                    <td className="py-2 px-4 text-muted-foreground">HMAC-SHA256 signature</td>
                    <td className="py-2 px-4"><code className="text-xs bg-muted px-1 rounded">sha256=abc123...</code></td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2 px-4"><code className="text-xs bg-muted px-1 rounded">X-Postora-Timestamp</code></td>
                    <td className="py-2 px-4 text-muted-foreground">Request timestamp</td>
                    <td className="py-2 px-4"><code className="text-xs bg-muted px-1 rounded">1704891600</code></td>
                  </tr>
                  <tr>
                    <td className="py-2 px-4"><code className="text-xs bg-muted px-1 rounded">X-Postora-Delivery-ID</code></td>
                    <td className="py-2 px-4 text-muted-foreground">Unique delivery ID for idempotency</td>
                    <td className="py-2 px-4"><code className="text-xs bg-muted px-1 rounded">del_abc123...</code></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* Related Documentation */}
        <div className="border-t border-border pt-8">
          <h3 className="text-lg font-semibold mb-4">Related Documentation</h3>
          <div className="flex flex-wrap gap-2">
            <Link to="/docs/multi-platform">
              <Button variant="outline" size="sm" className="gap-2">
                <ArrowRight className="w-4 h-4" />
                Multi-Platform Guide
              </Button>
            </Link>
            <Link to="/docs/n8n-integration">
              <Button variant="outline" size="sm" className="gap-2">
                <Zap className="w-4 h-4" />
                n8n Integration
              </Button>
            </Link>
            <Link to="/docs/playground">
              <Button variant="outline" size="sm" className="gap-2">
                <Terminal className="w-4 h-4" />
                API Playground
              </Button>
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
