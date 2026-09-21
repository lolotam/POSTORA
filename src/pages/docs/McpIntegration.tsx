import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Icon3D, GradientHeading, Reveal, GradientRingCard } from "@/components/fx";
import {
  ArrowLeft, Copy, Check, Plug, Bot, ShieldCheck, Workflow, Terminal,
  Sparkles, Zap, BookOpen, Image as ImageIcon, Hash, Clock, Trash2,
  PenLine, FolderOpen, BarChart3, Inbox, KeyRound, Webhook, Send,
  Calendar, FileText, Rocket,
} from "lucide-react";

const MCP_URL = "https://api.postora.cloud/functions/v1/mcp";

type Endpoint = {
  name: string;
  method: "GET" | "POST" | "DELETE" | "PUT";
  rest: string;
  desc: string;
  icon: any;
  variant: "violet" | "sky" | "rose" | "emerald" | "amber";
};

const LIVE: Endpoint[] = [
  { name: "list_accounts", method: "GET", rest: "/api/v1/accounts", desc: "List connected social accounts across all 10 platforms.", icon: Plug, variant: "violet" },
  { name: "list_posts", method: "GET", rest: "/api/v1/posts", desc: "Paginate post history with status/platform filters.", icon: FileText, variant: "sky" },
  { name: "get_post", method: "GET", rest: "/api/v1/post/:id", desc: "Fetch one post and its per-platform results.", icon: FileText, variant: "sky" },
  { name: "create_post", method: "POST", rest: "/api/v1/post", desc: "Publish or schedule a post on one or many platforms.", icon: Send, variant: "rose" },
  { name: "upload_media", method: "POST", rest: "/api/v1/upload-media", desc: "Upload image or video by URL / base64. Returns media_file_id.", icon: ImageIcon, variant: "emerald" },
  { name: "list_webhooks", method: "GET", rest: "/api/v1/webhooks", desc: "List your registered webhook subscriptions.", icon: Webhook, variant: "violet" },
  { name: "register_webhook", method: "POST", rest: "/api/v1/webhooks", desc: "Subscribe a URL to post status events.", icon: Webhook, variant: "violet" },
  { name: "delete_webhook", method: "DELETE", rest: "/api/v1/webhooks/:id", desc: "Remove a registered webhook by id.", icon: Trash2, variant: "amber" },
];

const ROADMAP: Endpoint[] = [
  { name: "generate_caption", method: "POST", rest: "AI", desc: "Draft platform-tuned copy from a brief before posting.", icon: PenLine, variant: "violet" },
  { name: "generate_hashtags", method: "POST", rest: "AI", desc: "Suggest trending hashtags for a caption + niche.", icon: Hash, variant: "sky" },
  { name: "generate_image", method: "POST", rest: "AI", desc: "Create an image with the Postora image model and auto-upload.", icon: ImageIcon, variant: "rose" },
  { name: "suggest_best_times", method: "POST", rest: "AI", desc: "Get optimal scheduled_at slots per account.", icon: Clock, variant: "emerald" },
  { name: "list_media", method: "GET", rest: "/api/v1/media", desc: "Browse media library before reusing assets.", icon: FolderOpen, variant: "violet" },
  { name: "update_post", method: "PUT", rest: "/api/v1/post/:id", desc: "Edit caption or schedule of a pending post.", icon: PenLine, variant: "amber" },
  { name: "delete_post", method: "DELETE", rest: "/api/v1/post/:id", desc: "Cancel a scheduled post or remove a draft.", icon: Trash2, variant: "amber" },
  { name: "list_pinterest_boards", method: "GET", rest: "/api/v1/pinterest/boards", desc: "Fetch boards before creating a Pinterest pin.", icon: FolderOpen, variant: "rose" },
  { name: "get_account_health", method: "GET", rest: "/api/v1/health", desc: "Check token validity per connected account.", icon: ShieldCheck, variant: "emerald" },
  { name: "list_templates", method: "GET", rest: "/api/v1/templates", desc: "List saved post templates and apply by id.", icon: FileText, variant: "sky" },
  { name: "get_analytics", method: "GET", rest: "/api/v1/analytics", desc: "Aggregate reach / engagement per platform.", icon: BarChart3, variant: "violet" },
  { name: "list_inbox / reply_message", method: "GET", rest: "/api/v1/inbox", desc: "Read DMs and comments, reply from the agent.", icon: Inbox, variant: "rose" },
  { name: "list_credits", method: "GET", rest: "/api/v1/credits", desc: "Read AI credit balance and quota usage.", icon: KeyRound, variant: "amber" },
  { name: "schedule_campaign", method: "POST", rest: "/api/v1/campaigns", desc: "Bulk-schedule a sequence of posts in one call.", icon: Calendar, variant: "sky" },
];

const RATE_LIMITS = [
  { tool: "create_post", limit: "30 / hour" },
  { tool: "upload_media", limit: "60 / hour" },
  { tool: "list_posts · list_accounts", limit: "100 / hour" },
  { tool: "webhook operations", limit: "30 / hour" },
];

export default function McpIntegration() {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 1800);
  };

  const Code = ({ code, lang, id, title }: { code: string; lang: string; id: string; title?: string }) => (
    <div className="relative rounded-xl bg-[#0d1117] border border-[#30363d] overflow-hidden my-4">
      <div className="flex items-center justify-between px-4 py-2 border-b border-[#30363d] bg-[#161b22]">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground font-mono">{lang}</span>
          {title && <span className="text-xs text-muted-foreground/70">• {title}</span>}
        </div>
        <Button variant="ghost" size="sm" onClick={() => copy(code, id)} className="h-7 text-xs">
          {copied === id ? <Check className="w-3 h-3 me-1" /> : <Copy className="w-3 h-3 me-1" />}
          {copied === id ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="p-4 overflow-x-auto text-sm"><code className="text-foreground/90">{code}</code></pre>
    </div>
  );

  const jsonRpcCreate = `// JSON-RPC over Streamable HTTP
POST ${MCP_URL}
Authorization: Bearer YOUR_POSTORA_API_KEY
Accept: application/json, text/event-stream

{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": {
    "name": "create_post",
    "arguments": {
      "caption": "New drop is live ✨",
      "platforms": ["instagram","facebook"],
      "media_file_ids": ["<id-from-upload_media>"],
      "scheduled_at": "2026-05-04T14:00:00Z"
    }
  }
}`;

  const curlUpload = `curl -X POST ${MCP_URL} \\
  -H "Authorization: Bearer YOUR_POSTORA_API_KEY" \\
  -H "Accept: application/json, text/event-stream" \\
  -H "Content-Type: application/json" \\
  -d '{
    "jsonrpc":"2.0","id":1,"method":"tools/call",
    "params":{
      "name":"upload_media",
      "arguments":{ "media_url":"https://example.com/photo.jpg" }
    }
  }'`;

  const promptExample = `# In Claude / ChatGPT after connecting Postora:

"List my connected Instagram accounts, then schedule
 a carousel of these 3 images for tomorrow at 9am
 with the caption 'Spring collection ☀️'."`;

  return (
    <div className="min-h-screen bg-background relative overflow-hidden">
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute -top-40 start-1/3 h-[480px] w-[480px] rounded-full bg-violet-500/10 blur-3xl" />
        <div className="absolute top-1/2 -end-40 h-[420px] w-[420px] rounded-full bg-sky-500/10 blur-3xl" />
        <div className="absolute bottom-0 start-0 h-[360px] w-[360px] rounded-full bg-rose-500/10 blur-3xl" />
      </div>

      <div className="container mx-auto px-4 py-8 max-w-6xl">
        <Link to="/docs/mcp-server" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-6">
          <ArrowLeft className="w-4 h-4" /> Back to MCP Server config
        </Link>

        {/* Hero */}
        <Reveal className="text-center mb-12">
          <div className="flex items-center justify-center gap-3 mb-4">
            <Icon3D icon={Plug} variant="violet" size="lg" />
            <Badge variant="outline" className="bg-violet-500/10 border-violet-400/40 text-violet-200">MCP Integration · Beta</Badge>
          </div>
          <GradientHeading as="h1" preset="sky-violet-pink" size="xl">
            Postora MCP — full endpoint reference
          </GradientHeading>
          <p className="text-muted-foreground max-w-2xl mx-auto mt-4">
            Every tool your LLM agent can call on Postora, plus the roadmap of what's coming next.
            One auth, one endpoint, ten platforms.
          </p>

          <div className="mt-6 inline-flex items-center gap-2 rounded-2xl bg-white/5 ring-1 ring-white/10 px-4 py-2 backdrop-blur-xl">
            <Terminal className="w-4 h-4 text-violet-300" />
            <code className="text-sm text-violet-100">{MCP_URL}</code>
            <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => copy(MCP_URL, "url")}>
              {copied === "url" ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            </Button>
          </div>
        </Reveal>

        {/* What & Auth */}
        <div className="grid md:grid-cols-2 gap-6 mb-12">
          <Reveal delay={0.05}>
            <GradientRingCard variant="violet" className="h-full">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <Icon3D icon={Bot} variant="violet" size="md" />
                  <CardTitle>How MCP works</CardTitle>
                </div>
                <CardDescription>
                  The Model Context Protocol is the open standard agents use to call external tools.
                  Postora speaks MCP over Streamable HTTP, so any compatible client — Claude, ChatGPT,
                  Cursor, Antigravity, Cline — drives your account with no glue code.
                </CardDescription>
              </CardHeader>
            </GradientRingCard>
          </Reveal>
          <Reveal delay={0.1}>
            <GradientRingCard variant="sky" className="h-full">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <Icon3D icon={ShieldCheck} variant="sky" size="md" />
                  <CardTitle>Auth & safety</CardTitle>
                </div>
                <CardDescription>
                  Bearer your Postora API key. Every tool call is scoped to your user, rate-limited,
                  and logged — same rules as the public REST API. Revoke a key any time from Settings.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button asChild variant="outline" size="sm">
                  <Link to="/api-keys">Manage API keys</Link>
                </Button>
              </CardContent>
            </GradientRingCard>
          </Reveal>
        </div>

        {/* Quickstart */}
        <Reveal className="mb-12">
          <div className="flex items-center gap-3 mb-6">
            <Icon3D icon={Rocket} variant="rose" size="md" />
            <GradientHeading as="h2" preset="amber-rose-violet" size="lg">Quickstart in 3 steps</GradientHeading>
          </div>
          <div className="grid md:grid-cols-3 gap-4">
            {[
              { n: 1, t: "Get your API key", d: "Generate a Postora key from the API Keys page.", icon: KeyRound, v: "violet" as const, to: "/api-keys" },
              { n: 2, t: "Pick a client", d: "Claude Desktop, ChatGPT, Cursor, Cline, Antigravity — all supported.", icon: Workflow, v: "sky" as const, to: "/docs/mcp-server" },
              { n: 3, t: "Paste & chat", d: "Drop the config snippet, restart your client, ask it to post.", icon: Sparkles, v: "rose" as const, to: "/docs/mcp-server" },
            ].map((s, i) => (
              <Reveal key={s.n} delay={0.05 * i}>
                <Card className="bg-white/5 ring-1 ring-white/10 backdrop-blur-xl border-0 h-full hover:ring-violet-400/40 transition-all hover:-translate-y-0.5">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <Icon3D icon={s.icon} variant={s.v} size="md" />
                      <span className="text-3xl font-bold text-muted-foreground/30">0{s.n}</span>
                    </div>
                    <CardTitle className="text-base mt-3">{s.t}</CardTitle>
                    <CardDescription>{s.d}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Button asChild variant="ghost" size="sm" className="px-0 hover:bg-transparent">
                      <Link to={s.to}>Go →</Link>
                    </Button>
                  </CardContent>
                </Card>
              </Reveal>
            ))}
          </div>
        </Reveal>

        {/* Live endpoints */}
        <Reveal className="mb-12">
          <div className="flex items-center gap-3 mb-6">
            <Icon3D icon={Sparkles} variant="emerald" size="md" />
            <GradientHeading as="h2" preset="sky-violet-pink" size="lg">Live tools</GradientHeading>
            <Badge className="bg-emerald-500/15 text-emerald-300 border border-emerald-400/30">{LIVE.length} ready</Badge>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {LIVE.map((e, i) => (
              <Reveal key={e.name} delay={0.03 * i}>
                <Card className="bg-white/5 ring-1 ring-white/10 backdrop-blur-xl border-0 h-full hover:ring-violet-400/40 hover:-translate-y-0.5 transition-all">
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <Icon3D icon={e.icon} variant={e.variant} size="sm" />
                      <Badge variant="outline" className="text-[10px] font-mono">
                        {e.method}
                      </Badge>
                    </div>
                    <CardTitle className="text-base font-mono text-violet-200 mt-2">{e.name}</CardTitle>
                    <code className="text-[11px] text-muted-foreground/70">{e.rest}</code>
                  </CardHeader>
                  <CardContent className="text-sm text-muted-foreground">{e.desc}</CardContent>
                </Card>
              </Reveal>
            ))}
          </div>
        </Reveal>

        {/* Examples */}
        <Reveal className="mb-12">
          <div className="flex items-center gap-3 mb-4">
            <Icon3D icon={Terminal} variant="violet" size="md" />
            <GradientHeading as="h2" preset="amber-rose-violet" size="lg">Live request examples</GradientHeading>
          </div>
          <Tabs defaultValue="rpc" className="w-full">
            <TabsList className="bg-white/5 ring-1 ring-white/10 backdrop-blur-xl">
              <TabsTrigger value="rpc">JSON-RPC</TabsTrigger>
              <TabsTrigger value="curl">cURL</TabsTrigger>
              <TabsTrigger value="prompt">Natural prompt</TabsTrigger>
            </TabsList>
            <TabsContent value="rpc"><Code lang="http" id="rpc" title="create_post" code={jsonRpcCreate} /></TabsContent>
            <TabsContent value="curl"><Code lang="bash" id="curl" title="upload_media" code={curlUpload} /></TabsContent>
            <TabsContent value="prompt"><Code lang="text" id="prompt" title="What you actually type" code={promptExample} /></TabsContent>
          </Tabs>
        </Reveal>

        {/* Rate limits + Errors */}
        <div className="grid md:grid-cols-2 gap-6 mb-12">
          <Reveal delay={0.05}>
            <GradientRingCard variant="emerald" className="h-full">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <Icon3D icon={Zap} variant="emerald" size="md" />
                  <CardTitle>Rate limits</CardTitle>
                </div>
                <CardDescription>Per-user, rolling 1-hour windows. Admins are exempt.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="divide-y divide-white/5">
                  {RATE_LIMITS.map((r) => (
                    <div key={r.tool} className="flex items-center justify-between py-2 text-sm">
                      <code className="text-violet-200">{r.tool}</code>
                      <span className="text-muted-foreground">{r.limit}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </GradientRingCard>
          </Reveal>
          <Reveal delay={0.1}>
            <GradientRingCard variant="amber" className="h-full">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <Icon3D icon={ShieldCheck} variant="amber" size="md" />
                  <CardTitle>Error codes</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-muted-foreground">
                <p><strong className="text-foreground">401</strong> — missing / invalid Postora API key.</p>
                <p><strong className="text-foreground">406</strong> — client must send <code>Accept: application/json, text/event-stream</code>.</p>
                <p><strong className="text-foreground">429</strong> — rate-limited; honour <code>X-RateLimit-Reset</code>.</p>
                <p><strong className="text-foreground">200 + error_code</strong> — expected platform errors return 200 with <code>{`{ success:false, error_code }`}</code>.</p>
              </CardContent>
            </GradientRingCard>
          </Reveal>
        </div>

        {/* Roadmap */}
        <Reveal className="mb-12">
          <div className="flex items-center gap-3 mb-6">
            <Icon3D icon={Rocket} variant="amber" size="md" />
            <GradientHeading as="h2" preset="amber-rose-violet" size="lg">Roadmap — coming next</GradientHeading>
            <Badge className="bg-amber-500/15 text-amber-300 border border-amber-400/30">{ROADMAP.length} planned</Badge>
          </div>
          <p className="text-sm text-muted-foreground mb-4 max-w-3xl">
            These tools already exist as edge functions or DB-backed features inside Postora — they just
            need to be wrapped as MCP tools. Tell us which ones you want first.
          </p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {ROADMAP.map((e, i) => (
              <Reveal key={e.name} delay={0.025 * i}>
                <Card className="relative bg-white/[0.03] ring-1 ring-white/10 backdrop-blur-xl border-0 h-full hover:ring-amber-400/40 transition-all">
                  <div className="absolute top-2 end-2">
                    <Badge className="bg-amber-500/15 text-amber-300 border border-amber-400/30 text-[10px]">soon</Badge>
                  </div>
                  <CardHeader className="pb-2">
                    <Icon3D icon={e.icon} variant={e.variant} size="sm" />
                    <CardTitle className="text-base font-mono text-amber-200 mt-2">{e.name}</CardTitle>
                    <code className="text-[11px] text-muted-foreground/70">{e.method} · {e.rest}</code>
                  </CardHeader>
                  <CardContent className="text-sm text-muted-foreground">{e.desc}</CardContent>
                </Card>
              </Reveal>
            ))}
          </div>
        </Reveal>

        {/* CTA */}
        <Reveal>
          <GradientRingCard variant="violet">
            <CardHeader>
              <div className="flex items-center gap-3">
                <Icon3D icon={BookOpen} variant="violet" size="md" />
                <CardTitle>Keep going</CardTitle>
              </div>
              <CardDescription>
                Set up your client, browse the REST equivalent, or grab an API key.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-3">
              <Button asChild><Link to="/docs/mcp-server"><Plug className="w-4 h-4 me-2" /> Client config</Link></Button>
              <Button asChild variant="outline"><Link to="/docs/n8n-integration"><Workflow className="w-4 h-4 me-2" /> REST API</Link></Button>
              <Button asChild variant="outline"><Link to="/api-keys"><KeyRound className="w-4 h-4 me-2" /> API keys</Link></Button>
            </CardContent>
          </GradientRingCard>
        </Reveal>
      </div>
    </div>
  );
}