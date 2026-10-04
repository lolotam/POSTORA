import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/useAuth";
import { Icon3D, GradientHeading, Reveal, GradientRingCard } from "@/components/fx";
import {
  ArrowLeft, Copy, Check, Plug, Bot, Sparkles, ShieldCheck,
  Workflow, Terminal, BookOpen, Zap,
} from "lucide-react";

const MCP_URL = "https://api.postora.cloud/functions/v1/mcp";

type Tool = { name: string; description: string };
const TOOLS: Tool[] = [
  { name: "list_accounts", description: "List connected social accounts (FB, IG, TikTok, YouTube, Pinterest, X, LinkedIn, Threads, Bluesky, Reddit)." },
  { name: "list_posts", description: "List recent posts with pagination and status filters." },
  { name: "get_post", description: "Fetch a single post (and per-platform results) by id." },
  { name: "create_post", description: "Publish or schedule a post across one or more platforms." },
  { name: "upload_media", description: "Upload an image or video by URL or base64. Returns a media_file_id." },
  { name: "list_webhooks", description: "List registered webhook subscriptions." },
  { name: "register_webhook", description: "Register a webhook URL for post status events." },
  { name: "delete_webhook", description: "Remove a registered webhook by id." },
];

export default function McpServer() {
  const { user } = useAuth();
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
          <span className="text-xs text-gray-400 font-mono">{lang}</span>
          {title && <span className="text-xs text-gray-500">• {title}</span>}
        </div>
        <Button variant="ghost" size="sm" onClick={() => copy(code, id)} className="h-7 text-xs text-gray-300 hover:text-white hover:bg-white/10">
          {copied === id ? <Check className="w-3 h-3 me-1" /> : <Copy className="w-3 h-3 me-1" />}
          {copied === id ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="p-4 overflow-x-auto text-sm"><code className="text-gray-200">{code}</code></pre>
    </div>
  );

  const claudeConfig = `{
  "mcpServers": {
    "postora": {
      "type": "http",
      "url": "${MCP_URL}",
      "headers": {
        "Authorization": "Bearer YOUR_POSTORA_API_KEY"
      }
    }
  }
}`;

  const cursorConfig = `{
  "mcpServers": {
    "postora": {
      "url": "${MCP_URL}",
      "headers": { "Authorization": "Bearer YOUR_POSTORA_API_KEY" }
    }
  }
}`;

  const chatgptNote = `# In ChatGPT → Settings → Connectors → Add custom connector
URL:    ${MCP_URL}
Auth:   Bearer token
Token:  YOUR_POSTORA_API_KEY`;

  const antigravityConfig = `{
  "mcp": {
    "servers": {
      "postora": {
        "transport": "http",
        "url": "${MCP_URL}",
        "headers": { "Authorization": "Bearer YOUR_POSTORA_API_KEY" }
      }
    }
  }
}`;

  const openaiAgent = `import OpenAI from "openai";

const openai = new OpenAI();

const resp = await openai.responses.create({
  model: "gpt-5.2",
  input: "Schedule a post on Instagram for tomorrow at 9am.",
  tools: [{
    type: "mcp",
    server_label: "postora",
    server_url: "${MCP_URL}",
    headers: { Authorization: "Bearer YOUR_POSTORA_API_KEY" },
  }],
});`;

  return (
    <div className="min-h-screen bg-background relative overflow-hidden">
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10">
      </div>

      <div className="container mx-auto px-4 py-8 max-w-5xl">
        <Link to="/docs/n8n-integration" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-6">
          <ArrowLeft className="w-4 h-4" /> Back to integrations
        </Link>

        {/* Hero */}
        <Reveal className="text-center mb-12">
          <div className="flex items-center justify-center gap-3 mb-4">
            <Icon3D icon={Plug} variant="violet" size="lg" />
            <Badge variant="outline" className="bg-muted border-input text-neutral-200">MCP Server · Beta</Badge>
          </div>
          <GradientHeading as="h1" preset="sky-violet-pink" size="xl">
            Connect any LLM to Postora
          </GradientHeading>
          <p className="text-muted-foreground max-w-2xl mx-auto mt-4">
            One endpoint that lets Claude, ChatGPT, Antigravity, Cursor, Cline, and any
            MCP-compatible agent post, schedule, and manage your social accounts on your behalf.
          </p>

          <div className="mt-6 inline-flex items-center gap-2 rounded-2xl bg-white/5 ring-1 ring-white/10 px-4 py-2">
            <Terminal className="w-4 h-4 text-neutral-200" />
            <code className="text-sm text-neutral-200">{MCP_URL}</code>
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
                  <CardTitle>What is MCP?</CardTitle>
                </div>
                <CardDescription>
                  Model Context Protocol is the open standard LLM clients use to call external tools.
                  Postora speaks MCP over Streamable HTTP, so any compatible agent can drive your account
                  with no glue code.
                </CardDescription>
              </CardHeader>
            </GradientRingCard>
          </Reveal>

          <Reveal delay={0.1}>
            <GradientRingCard variant="sky" className="h-full">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <Icon3D icon={ShieldCheck} variant="sky" size="md" />
                  <CardTitle>Authentication</CardTitle>
                </div>
                <CardDescription>
                  Use your Postora API key as an HTTP Bearer token. Every tool call is scoped to your
                  account, rate-limited, and logged — same rules as the public REST API.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button asChild variant="outline" size="sm">
                  <Link to="/api-keys">Get your API key</Link>
                </Button>
              </CardContent>
            </GradientRingCard>
          </Reveal>
        </div>

        {/* Client configs */}
        <Reveal className="mb-12">
          <div className="flex items-center gap-3 mb-4">
            <Icon3D icon={Workflow} variant="rose" size="md" />
            <GradientHeading as="h2" preset="amber-rose-violet" size="lg">Connect your client</GradientHeading>
          </div>
          <Tabs defaultValue="claude" className="w-full">
            <TabsList className="bg-white/5 ring-1 ring-white/10">
              <TabsTrigger value="claude">Claude Desktop</TabsTrigger>
              <TabsTrigger value="chatgpt">ChatGPT</TabsTrigger>
              <TabsTrigger value="antigravity">Antigravity</TabsTrigger>
              <TabsTrigger value="cursor">Cursor / Cline</TabsTrigger>
              <TabsTrigger value="openai">OpenAI Agents</TabsTrigger>
            </TabsList>
            <TabsContent value="claude">
              <Code lang="json" id="claude" title="claude_desktop_config.json" code={claudeConfig} />
            </TabsContent>
            <TabsContent value="chatgpt">
              <Code lang="text" id="chatgpt" title="ChatGPT custom connector" code={chatgptNote} />
            </TabsContent>
            <TabsContent value="antigravity">
              <Code lang="json" id="antigravity" title="antigravity settings" code={antigravityConfig} />
            </TabsContent>
            <TabsContent value="cursor">
              <Code lang="json" id="cursor" title="~/.cursor/mcp.json (same shape works in Cline)" code={cursorConfig} />
            </TabsContent>
            <TabsContent value="openai">
              <Code lang="ts" id="openai" title="OpenAI Agents SDK" code={openaiAgent} />
            </TabsContent>
          </Tabs>
        </Reveal>

        {/* Tools catalog */}
        <Reveal className="mb-12">
          <div className="flex items-center gap-3 mb-4">
            <Icon3D icon={Sparkles} variant="emerald" size="md" />
            <GradientHeading as="h2" preset="sky-violet-pink" size="lg">Available tools</GradientHeading>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            {TOOLS.map((t, i) => (
              <Reveal key={t.name} delay={0.03 * i}>
                <Card className="bg-white/5 ring-1 ring-white/10 border-0 h-full">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base font-mono text-neutral-200">{t.name}</CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm text-muted-foreground">{t.description}</CardContent>
                </Card>
              </Reveal>
            ))}
          </div>
        </Reveal>

        {/* Troubleshooting */}
        <Reveal>
          <GradientRingCard variant="amber">
            <CardHeader>
              <div className="flex items-center gap-3">
                <Icon3D icon={Zap} variant="amber" size="md" />
                <CardTitle>Troubleshooting</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p><strong className="text-foreground">401 Unauthorized</strong> — missing or invalid API key. Pass it as <code>Authorization: Bearer &lt;key&gt;</code>.</p>
              <p><strong className="text-foreground">406 Not Acceptable</strong> — your client isn't sending <code>Accept: application/json, text/event-stream</code>. Update to a current MCP client.</p>
              <p><strong className="text-foreground">429 Too Many Requests</strong> — you've hit the per-user rate limit. Back off and retry after the <code>X-RateLimit-Reset</code> time.</p>
              <p><strong className="text-foreground">Tool says account not connected</strong> — visit <Link to="/profiles" className="text-neutral-200 hover:underline">Profiles</Link> and link the platform first.</p>
            </CardContent>
          </GradientRingCard>
        </Reveal>

        <div className="mt-10 text-center">
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button asChild>
              <Link to="/docs/mcp-integration"><Sparkles className="w-4 h-4 me-2" /> Full MCP integration & roadmap</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/docs/n8n-integration"><BookOpen className="w-4 h-4 me-2" /> REST API docs</Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}