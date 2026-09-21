import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Copy, Check, ExternalLink, Plug, Wrench } from "lucide-react";
import { Link } from "react-router-dom";

export const MCP_URL = "https://api.postora.cloud/functions/v1/mcp";

export const MCP_TOOLS: { name: string; description: string; rest: string }[] = [
  { name: "list_accounts", description: "List connected social accounts across all platforms.", rest: "GET /api/v1/accounts" },
  { name: "list_posts", description: "List recent posts with pagination and status filters.", rest: "GET /api/v1/posts" },
  { name: "get_post", description: "Fetch a single post and per-platform results by id.", rest: "GET /api/v1/post/:id" },
  { name: "create_post", description: "Publish or schedule a post across one or more platforms.", rest: "POST /api/v1/post" },
  { name: "upload_media", description: "Upload an image or video by URL or base64. Returns a media_file_id.", rest: "POST /api/v1/upload-media" },
  { name: "list_webhooks", description: "List registered webhook subscriptions.", rest: "GET /api/v1/webhooks" },
  { name: "register_webhook", description: "Register a webhook URL for post status events.", rest: "POST /api/v1/webhooks" },
  { name: "delete_webhook", description: "Remove a registered webhook by id.", rest: "DELETE /api/v1/webhooks/:id" },
];

function buildSnippets(apiKey: string) {
  const key = apiKey || "YOUR_POSTORA_API_KEY";
  return {
    claudeDesktopOAuth: `# Claude Desktop → Settings → Connectors → Add custom connector
# OAuth registers automatically (no API key needed).
URL: ${MCP_URL}`,
    claudeWebOAuth: `# Claude.ai (web) → Settings → Connectors → Add custom connector
URL: ${MCP_URL}`,
    chatgptOAuth: `# ChatGPT → Settings → Connectors → Add custom connector
# Authentication: OAuth (auto-registers)
URL: ${MCP_URL}`,
    antigravity: `# Antigravity IDE → Add MCP server → Remote (HTTP)
URL: ${MCP_URL}
# Auth: OAuth (auto-registers)`,
    claudeCode: `# Claude Code CLI — OAuth-based remote MCP
claude mcp add --transport http postora ${MCP_URL}`,
    claude: `{
  "mcpServers": {
    "postora": {
      "type": "http",
      "url": "${MCP_URL}",
      "headers": {
        "Authorization": "Bearer ${key}"
      }
    }
  }
}`,
    cursor: `{
  "mcpServers": {
    "postora": {
      "url": "${MCP_URL}",
      "headers": { "Authorization": "Bearer ${key}" }
    }
  }
}`,
    cline: `// VS Code settings.json — Cline / Roo Code
{
  "cline.mcpServers": {
    "postora": {
      "url": "${MCP_URL}",
      "headers": { "Authorization": "Bearer ${key}" }
    }
  }
}`,
    opencode: `# ~/.config/opencode/mcp.json
{
  "servers": {
    "postora": {
      "transport": "http",
      "url": "${MCP_URL}",
      "headers": { "Authorization": "Bearer ${key}" }
    }
  }
}`,
    codex: `# Codex CLI / OpenAI Agents SDK
export POSTORA_MCP_URL="${MCP_URL}"
export POSTORA_API_KEY="${key}"
codex mcp add postora --url "$POSTORA_MCP_URL" --header "Authorization: Bearer $POSTORA_API_KEY"`,
    generic: `curl -X POST ${MCP_URL} \\
  -H "Authorization: Bearer ${key}" \\
  -H "Accept: application/json, text/event-stream" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
  };
}

function CopyBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <div className="relative rounded-xl bg-[#0d1117] border border-[#30363d] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-[#30363d] bg-[#161b22]">
        <span className="text-xs text-gray-400 font-mono">{lang}</span>
        <Button variant="ghost" size="sm" onClick={onCopy} className="h-7 text-xs text-gray-300 hover:text-white hover:bg-white/10">
          {copied ? <Check className="w-3 h-3 me-1" /> : <Copy className="w-3 h-3 me-1" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="p-4 overflow-x-auto text-sm"><code className="text-gray-200 whitespace-pre">{code}</code></pre>
    </div>
  );
}

export function McpConnectionPanel({ apiKey = "" }: { apiKey?: string }) {
  const snip = buildSnippets(apiKey);

  return (
    <div className="space-y-6">
      {/* Endpoint + auth summary */}
      <div className="grid md:grid-cols-2 gap-3">
        <div className="rounded-lg border border-border bg-secondary/30 p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
            <Plug className="w-3.5 h-3.5" /> MCP Endpoint
          </div>
          <code className="font-mono text-sm break-all">{MCP_URL}</code>
        </div>
        <div className="rounded-lg border border-border bg-secondary/30 p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
            <Wrench className="w-3.5 h-3.5" /> Authentication
          </div>
          <p className="text-xs">
            <span className="font-medium">OAuth 2.1 (recommended)</span> — apps register themselves automatically.<br />
            <span className="font-medium">API key fallback</span> — <code className="bg-muted px-1 rounded">Authorization: Bearer YOUR_API_KEY</code>
          </p>
          <p className="text-xs text-muted-foreground mt-2">
            Transport: Streamable HTTP (JSON-RPC 2.0).
          </p>
        </div>
      </div>

      {/* OAuth-based clients */}
      <div>
        <p className="text-sm font-medium mb-2">OAuth — paste the URL, sign in to Postora</p>
        <Tabs defaultValue="claude-desktop">
          <TabsList className="flex-wrap h-auto">
            <TabsTrigger value="claude-desktop">Claude Desktop</TabsTrigger>
            <TabsTrigger value="claude-web">Claude.ai (web)</TabsTrigger>
            <TabsTrigger value="chatgpt-oauth">ChatGPT</TabsTrigger>
            <TabsTrigger value="antigravity">Antigravity</TabsTrigger>
            <TabsTrigger value="claude-code">Claude Code</TabsTrigger>
          </TabsList>
          <TabsContent value="claude-desktop" className="mt-3">
            <CopyBlock lang="text" code={snip.claudeDesktopOAuth} />
          </TabsContent>
          <TabsContent value="claude-web" className="mt-3">
            <CopyBlock lang="text" code={snip.claudeWebOAuth} />
          </TabsContent>
          <TabsContent value="chatgpt-oauth" className="mt-3">
            <CopyBlock lang="text" code={snip.chatgptOAuth} />
          </TabsContent>
          <TabsContent value="antigravity" className="mt-3">
            <CopyBlock lang="text" code={snip.antigravity} />
          </TabsContent>
          <TabsContent value="claude-code" className="mt-3">
            <CopyBlock lang="bash" code={snip.claudeCode} />
          </TabsContent>
        </Tabs>
      </div>

      {/* API-key based clients */}
      <div>
        <p className="text-sm font-medium mb-2">API key — for clients without OAuth UI</p>
        <Tabs defaultValue="claude">
          <TabsList className="flex-wrap h-auto">
            <TabsTrigger value="claude">Claude Desktop</TabsTrigger>
            <TabsTrigger value="cursor">Cursor</TabsTrigger>
            <TabsTrigger value="cline">Cline / Roo</TabsTrigger>
            <TabsTrigger value="opencode">OpenCode</TabsTrigger>
            <TabsTrigger value="codex">Codex CLI</TabsTrigger>
            <TabsTrigger value="generic">Generic / cURL</TabsTrigger>
          </TabsList>
          <TabsContent value="claude" className="mt-3">
            <p className="text-xs text-muted-foreground mb-2">Add to <code className="bg-muted px-1 rounded">claude_desktop_config.json</code>, then restart Claude.</p>
            <CopyBlock lang="json" code={snip.claude} />
          </TabsContent>
          <TabsContent value="cursor" className="mt-3">
            <p className="text-xs text-muted-foreground mb-2">Add to <code className="bg-muted px-1 rounded">~/.cursor/mcp.json</code> or your project's <code className="bg-muted px-1 rounded">.cursor/mcp.json</code>.</p>
            <CopyBlock lang="json" code={snip.cursor} />
          </TabsContent>
          <TabsContent value="cline" className="mt-3">
            <p className="text-xs text-muted-foreground mb-2">Add to your VS Code <code className="bg-muted px-1 rounded">settings.json</code>.</p>
            <CopyBlock lang="json" code={snip.cline} />
          </TabsContent>
          <TabsContent value="opencode" className="mt-3">
            <p className="text-xs text-muted-foreground mb-2">Add to your OpenCode MCP config file.</p>
            <CopyBlock lang="json" code={snip.opencode} />
          </TabsContent>
          <TabsContent value="codex" className="mt-3">
            <p className="text-xs text-muted-foreground mb-2">Codex CLI / OpenAI Agents SDK.</p>
            <CopyBlock lang="bash" code={snip.codex} />
          </TabsContent>
          <TabsContent value="generic" className="mt-3">
            <p className="text-xs text-muted-foreground mb-2">Any MCP Streamable HTTP client. List available tools:</p>
            <CopyBlock lang="bash" code={snip.generic} />
          </TabsContent>
        </Tabs>
      </div>

      {/* Tools list */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-medium">Available MCP tools</p>
          <Badge variant="secondary" className="text-xs">{MCP_TOOLS.length} tools</Badge>
        </div>
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-secondary/50">
              <tr>
                <th className="text-start py-2 px-3 font-medium w-1/4">Tool</th>
                <th className="text-start py-2 px-3 font-medium">Description</th>
                <th className="text-start py-2 px-3 font-medium hidden md:table-cell w-1/4">REST equivalent</th>
              </tr>
            </thead>
            <tbody>
              {MCP_TOOLS.map((t) => (
                <tr key={t.name} className="border-t border-border">
                  <td className="py-2 px-3 font-mono text-xs text-primary">{t.name}</td>
                  <td className="py-2 px-3 text-muted-foreground">{t.description}</td>
                  <td className="py-2 px-3 font-mono text-xs text-muted-foreground hidden md:table-cell">{t.rest}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Example JSON-RPC call */}
      <div>
        <p className="text-sm font-medium mb-2">Example: call <code className="bg-muted px-1 rounded">create_post</code></p>
        <CopyBlock
          lang="json"
          code={`{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "create_post",
    "arguments": {
      "platforms": ["instagram", "twitter"],
      "caption": "Hello from MCP 👋",
      "media_urls": ["https://example.com/photo.jpg"]
    }
  }
}`}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" asChild>
          <Link to="/docs/mcp-server" className="gap-1.5">
            <ExternalLink className="w-3.5 h-3.5" /> Full MCP guide
          </Link>
        </Button>
        <Button variant="outline" size="sm" asChild>
          <a href="https://modelcontextprotocol.io" target="_blank" rel="noopener noreferrer" className="gap-1.5">
            <ExternalLink className="w-3.5 h-3.5" /> About MCP
          </a>
        </Button>
      </div>
    </div>
  );
}