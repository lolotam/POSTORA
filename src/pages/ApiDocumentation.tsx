import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useNavigate } from "react-router-dom";
import { BookOpen, Key, Zap, AlertTriangle, Webhook, Clock, ExternalLink, ArrowLeft } from "lucide-react";
import { CodeBlock, MethodBadge } from "@/components/api-docs/ApiDocsComponents";
import { endpoints, rateLimits, errorCodes, webhookEvents, BASE_URL } from "@/components/api-docs/data/apiEndpoints";

export default function ApiDocumentation() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-6 py-4 flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate("/docs")}><ArrowLeft className="w-4 h-4" /></Button>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center"><BookOpen className="w-4 h-4 text-primary" /></div>
            <div>
              <h1 className="text-lg font-bold">Postora API Reference</h1>
              <p className="text-xs text-muted-foreground">v1 — REST API for automation platforms</p>
            </div>
          </div>
          <div className="ms-auto flex items-center gap-2">
            <Badge variant="outline" className="text-xs">Version 1.0</Badge>
            <Button size="sm" variant="outline" asChild>
              <a href="/docs/n8n-integration" className="flex items-center gap-1.5"><Zap className="w-3.5 h-3.5" /> n8n Guide</a>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <a href="/docs/make-integration" className="flex items-center gap-1.5"><Zap className="w-3.5 h-3.5" /> Make.com Guide</a>
            </Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-6 py-10 max-w-5xl">
        {/* Authentication */}
        <section className="mb-12">
          <div className="flex items-center gap-3 mb-4"><Key className="w-5 h-5 text-primary" /><h2 className="text-2xl font-bold">Authentication</h2></div>
          <p className="text-muted-foreground mb-4">All API requests require your API key. Get it from <a href="/api-keys" className="text-primary underline">Settings → API Keys</a>.</p>
          <div className="grid md:grid-cols-2 gap-4 mb-4">
            <div><p className="text-sm font-medium mb-2">Header (recommended)</p><CodeBlock lang="bash" code={`curl -H "x-api-key: YOUR_API_KEY" \\\n  ${BASE_URL}/api/v1/accounts`} /></div>
            <div><p className="text-sm font-medium mb-2">Authorization Bearer</p><CodeBlock lang="bash" code={`curl -H "Authorization: Bearer YOUR_API_KEY" \\\n  ${BASE_URL}/api/v1/accounts`} /></div>
          </div>
        </section>

        {/* Base URL */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-4">Base URL</h2>
          <CodeBlock lang="text" code={BASE_URL} />
          <p className="text-sm text-muted-foreground mt-2">All endpoint paths below are appended to this base URL.</p>
        </section>

        {/* Endpoints */}
        <section className="mb-12">
          <div className="flex items-center gap-3 mb-6"><Zap className="w-5 h-5 text-primary" /><h2 className="text-2xl font-bold">Endpoints</h2></div>
          <div className="space-y-8">
            {endpoints.map((ep, i) => (
              <div key={i} className="border border-border rounded-xl overflow-hidden">
                <div className="flex items-center gap-3 px-5 py-3 bg-card border-b border-border"><MethodBadge method={ep.method} /><code className="text-sm font-mono font-medium">{ep.path}</code></div>
                <div className="p-5">
                  <p className="text-muted-foreground mb-4">{ep.description}</p>
                  {ep.notes && <p className="text-xs text-muted-foreground bg-secondary/30 rounded-lg px-3 py-2 mb-4">💡 {ep.notes}</p>}
                  <Tabs defaultValue={ep.body ? "request" : "response"} className="w-full">
                    <TabsList className="mb-2">
                      {ep.body && <TabsTrigger value="request">Request</TabsTrigger>}
                      <TabsTrigger value="response">Response</TabsTrigger>
                      <TabsTrigger value="curl">cURL</TabsTrigger>
                    </TabsList>
                    {ep.body && <TabsContent value="request"><CodeBlock lang="json" code={ep.body} /></TabsContent>}
                    <TabsContent value="response"><CodeBlock lang="json" code={ep.response} /></TabsContent>
                    <TabsContent value="curl">
                      <CodeBlock lang="bash" code={
                        ep.method === "GET" ? `curl -X GET "${BASE_URL}${ep.path}" \\\n  -H "x-api-key: YOUR_API_KEY"`
                          : ep.method === "DELETE" ? `curl -X DELETE "${BASE_URL}${ep.path}" \\\n  -H "x-api-key: YOUR_API_KEY"`
                            : `curl -X POST "${BASE_URL}${ep.path}" \\\n  -H "x-api-key: YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '${ep.body?.replace(/\n\s*/g, " ") || "{}"}'`
                      } />
                    </TabsContent>
                  </Tabs>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Rate Limits */}
        <section className="mb-12">
          <div className="flex items-center gap-3 mb-4"><Clock className="w-5 h-5 text-primary" /><h2 className="text-2xl font-bold">Rate Limits</h2></div>
          <p className="text-muted-foreground mb-4">All responses include rate limit headers: <code className="text-xs bg-muted px-1.5 py-0.5 rounded">X-RateLimit-Limit</code>, <code className="text-xs bg-muted px-1.5 py-0.5 rounded">X-RateLimit-Remaining</code>, <code className="text-xs bg-muted px-1.5 py-0.5 rounded">X-RateLimit-Reset</code>.</p>
          <div className="overflow-x-auto border border-border rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-secondary/50"><tr><th className="text-start py-3 px-4 font-medium">Endpoint</th><th className="text-start py-3 px-4 font-medium">Limit</th><th className="text-start py-3 px-4 font-medium">Window</th></tr></thead>
              <tbody>{rateLimits.map((r, i) => (<tr key={i} className="border-t border-border"><td className="py-3 px-4 font-mono text-xs">{r.endpoint}</td><td className="py-3 px-4">{r.limit}</td><td className="py-3 px-4 text-muted-foreground">{r.window}</td></tr>))}</tbody>
            </table>
          </div>
        </section>

        {/* Error Codes */}
        <section className="mb-12">
          <div className="flex items-center gap-3 mb-4"><AlertTriangle className="w-5 h-5 text-primary" /><h2 className="text-2xl font-bold">Error Codes</h2></div>
          <p className="text-muted-foreground mb-4">All errors follow a standardized JSON format:</p>
          <CodeBlock lang="json" code={JSON.stringify({ success: false, error: { code: "ERROR_CODE", message: "Human-readable message", details: {} } }, null, 2)} />
          <div className="overflow-x-auto border border-border rounded-lg mt-4">
            <table className="w-full text-sm">
              <thead className="bg-secondary/50"><tr><th className="text-start py-3 px-4 font-medium">Code</th><th className="text-start py-3 px-4 font-medium">HTTP Status</th><th className="text-start py-3 px-4 font-medium">Description</th></tr></thead>
              <tbody>{errorCodes.map((e, i) => (<tr key={i} className="border-t border-border"><td className="py-3 px-4 font-mono text-xs text-primary">{e.code}</td><td className="py-3 px-4"><Badge variant="outline">{e.status}</Badge></td><td className="py-3 px-4 text-muted-foreground">{e.description}</td></tr>))}</tbody>
            </table>
          </div>
        </section>

        {/* Webhook Events */}
        <section className="mb-12">
          <div className="flex items-center gap-3 mb-4"><Webhook className="w-5 h-5 text-primary" /><h2 className="text-2xl font-bold">Webhook Events</h2></div>
          <p className="text-muted-foreground mb-4">Register webhooks to receive real-time notifications. Postora sends POST requests with headers:</p>
          <CodeBlock lang="text" code={`X-Postora-Event: post.completed\nX-Postora-Timestamp: 2026-03-28T12:05:00Z\nContent-Type: application/json`} />
          <div className="overflow-x-auto border border-border rounded-lg mt-4">
            <table className="w-full text-sm">
              <thead className="bg-secondary/50"><tr><th className="text-start py-3 px-4 font-medium">Event</th><th className="text-start py-3 px-4 font-medium">Description</th></tr></thead>
              <tbody>{webhookEvents.map((w, i) => (<tr key={i} className="border-t border-border"><td className="py-3 px-4 font-mono text-xs text-primary">{w.event}</td><td className="py-3 px-4 text-muted-foreground">{w.description}</td></tr>))}</tbody>
            </table>
          </div>
        </section>

        {/* Integration Examples */}
        <section className="mb-12">
          <div className="flex items-center gap-3 mb-4"><ExternalLink className="w-5 h-5 text-primary" /><h2 className="text-2xl font-bold">Integration Examples</h2></div>
          <Tabs defaultValue="n8n">
            <TabsList><TabsTrigger value="n8n">n8n</TabsTrigger><TabsTrigger value="make">Make.com</TabsTrigger><TabsTrigger value="zapier">Zapier</TabsTrigger><TabsTrigger value="python">Python</TabsTrigger></TabsList>
            <TabsContent value="n8n">
              <p className="text-muted-foreground text-sm mb-3">Use the HTTP Request node in n8n with your API key:</p>
              <CodeBlock lang="json" code={JSON.stringify({ method: "POST", url: `${BASE_URL}/api/v1/post`, headers: { "x-api-key": "YOUR_API_KEY", "Content-Type": "application/json" }, body: { caption: "Posted from n8n!", platforms: ["instagram"], account_ids: ["your-account-uuid"] } }, null, 2)} />
            </TabsContent>
            <TabsContent value="make">
              <p className="text-muted-foreground text-sm mb-3">In Make.com, use the HTTP module with these settings:</p>
              <CodeBlock lang="text" code={`URL: ${BASE_URL}/api/v1/post\nMethod: POST\nHeaders:\n  x-api-key: YOUR_API_KEY\n  Content-Type: application/json\nBody type: Raw → JSON`} />
            </TabsContent>
            <TabsContent value="zapier">
              <p className="text-muted-foreground text-sm mb-3">In Zapier, use the "Webhooks by Zapier" action with Custom Request:</p>
              <CodeBlock lang="text" code={`Method: POST\nURL: ${BASE_URL}/api/v1/post\nHeaders:\n  x-api-key: YOUR_API_KEY\n  Content-Type: application/json\nData Pass-Through: false\nData: {"caption": "Posted from Zapier!", "platforms": ["instagram"]}`} />
            </TabsContent>
            <TabsContent value="python">
              <CodeBlock lang="python" code={`import requests\n\nAPI_KEY = "YOUR_API_KEY"\nBASE = "${BASE_URL}"\n\n# Create a post\nresp = requests.post(f"{BASE}/api/v1/post", \n  headers={"x-api-key": API_KEY},\n  json={\n    "caption": "Hello from Python! 🐍",\n    "platforms": ["instagram", "facebook"],\n    "media_urls": ["https://example.com/photo.jpg"]\n  }\n)\nprint(resp.json())\n\n# Check post status\npost_id = resp.json()["post"]["id"]\nstatus = requests.get(f"{BASE}/api/v1/post/{post_id}",\n  headers={"x-api-key": API_KEY}\n)\nprint(status.json())`} />
            </TabsContent>
          </Tabs>
        </section>

        <section className="text-center py-8 border-t border-border">
          <p className="text-muted-foreground">Need help? Check the <a href="/docs/n8n-integration" className="text-primary underline">full integration guide</a> or <a href="/contact" className="text-primary underline">contact support</a>.</p>
        </section>
      </div>
    </div>
  );
}
