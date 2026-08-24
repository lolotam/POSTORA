import { useState } from "react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useCopyToClipboard } from "@/hooks/shared";
import {
    Key,
    Copy,
    RefreshCw,
    Check,
    Eye,
    EyeOff,
    Plus,
    Clock,
    Activity,
    ChevronDown,
    ChevronUp,
    ExternalLink,
} from "lucide-react";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { McpConnectionPanel } from "@/components/mcp/McpConnectionPanel";
import { McpConnectedClients } from "@/components/mcp/McpConnectedClients";
import { Plug } from "lucide-react";
import { WebhookSubscriptionsCard } from "@/features/webhook-observability";

const BASE_URL = "https://api.postora.cloud/functions/v1/n8n-api";

interface EndpointInfo {
    method: "GET" | "POST" | "DELETE";
    path: string;
    description: string;
    rateLimit: string;
    requestBody?: {
        field: string;
        type: string;
        required: boolean;
        description: string;
    }[];
    queryParams?: {
        param: string;
        type: string;
        description: string;
    }[];
    responseExample?: string;
}

const API_ENDPOINTS: EndpointInfo[] = [
    {
        method: "POST",
        path: "/api/v1/post",
        description: "Create and schedule a new post to one or more social platforms",
        rateLimit: "30 requests/hour",
        requestBody: [
            { field: "platforms", type: "string[]", required: true, description: "Target platforms (instagram, facebook, twitter, tiktok, youtube, linkedin, pinterest, threads, bluesky, reddit)" },
            { field: "caption", type: "string", required: false, description: "Post caption/content" },
            { field: "media_urls", type: "string[]", required: false, description: "URLs of media files to include" },
            { field: "media_file_ids", type: "string[]", required: false, description: "IDs of pre-uploaded media files" },
            { field: "scheduled_at", type: "ISO 8601", required: false, description: "Schedule time (omit for immediate post)" },
            { field: "timezone", type: "string", required: false, description: "Timezone for scheduling (e.g., America/New_York)" },
            { field: "account_ids", type: "string[]", required: false, description: "Specific account IDs to post to (only \"account_ids\" or \"ACCOUNT_IDS\" accepted — other variants return 400). Always use strings for large IDs." },
            { field: "webhook_url", type: "string", required: false, description: "URL for status callbacks" },
        ],
        responseExample: `{
  "success": true,
  "post_id": "uuid",
  "platform_posts": [...]
}`
    },
    {
        method: "POST",
        path: "/api/v1/upload-media",
        description: "Upload media files (images/videos) to be used in posts",
        rateLimit: "60 requests/hour",
        requestBody: [
            { field: "file", type: "File", required: true, description: "Media file (multipart/form-data)" },
            { field: "media_url", type: "string", required: false, description: "Alternative: URL to download media from" },
        ],
        responseExample: `{
  "success": true,
  "media_file_id": "uuid",
  "file_type": "image",
  "file_size": 1024000
}`
    },
    {
        method: "GET",
        path: "/api/v1/accounts",
        description: "List all connected social media accounts",
        rateLimit: "100 requests/hour",
        responseExample: `{
  "accounts": [
    {
      "id": "uuid",
      "platform": "instagram",
      "username": "@example",
      "connected_at": "2024-01-01T00:00:00Z"
    }
  ]
}`
    },
    {
        method: "GET",
        path: "/api/v1/posts",
        description: "Retrieve post history with filtering options",
        rateLimit: "100 requests/hour",
        queryParams: [
            { param: "status", type: "string", description: "Filter by status (pending, posted, failed, scheduled)" },
            { param: "platform", type: "string", description: "Filter by platform" },
            { param: "limit", type: "number", description: "Number of results (default: 50, max: 100)" },
            { param: "offset", type: "number", description: "Pagination offset" },
        ],
        responseExample: `{
  "posts": [...],
  "total": 150,
  "limit": 50,
  "offset": 0
}`
    },
    {
        method: "POST",
        path: "/api/v1/webhooks",
        description: "Register a webhook to receive post status updates",
        rateLimit: "30 requests/hour",
        requestBody: [
            { field: "url", type: "string", required: true, description: "Webhook endpoint URL (HTTPS required)" },
            { field: "events", type: "string[]", required: true, description: "Events to subscribe to (post.completed, post.failed, post.scheduled)" },
            { field: "secret", type: "string", required: false, description: "Secret for HMAC signature verification" },
        ],
        responseExample: `{
  "success": true,
  "webhook_id": "uuid",
  "url": "https://..."
}`
    },
    {
        method: "GET",
        path: "/api/v1/webhooks",
        description: "List all registered webhooks",
        rateLimit: "30 requests/hour",
        responseExample: `{
  "webhooks": [
    {
      "id": "uuid",
      "url": "https://...",
      "events": ["post.completed"],
      "active": true
    }
  ]
}`
    },
    {
        method: "DELETE",
        path: "/api/v1/webhooks/:id",
        description: "Delete a registered webhook",
        rateLimit: "30 requests/hour",
        responseExample: `{
  "success": true,
  "message": "Webhook deleted"
}`
    },
    {
        method: "POST",
        path: "/api/v1/webhooks/test",
        description: "Send a test payload to a webhook endpoint",
        rateLimit: "30 requests/hour",
        requestBody: [
            { field: "webhook_id", type: "string", required: true, description: "ID of the webhook to test" },
        ],
        responseExample: `{
  "success": true,
  "response_status": 200
}`
    },
];

const ERROR_CODES = [
    { code: "400", color: "text-red-400", title: "Bad Request", description: "Invalid request body or missing required fields" },
    { code: "401", color: "text-red-400", title: "Unauthorized", description: "Invalid or missing API key - check x-api-key header" },
    { code: "402", color: "text-yellow-400", title: "Payment Required", description: "AI credits exhausted - add more credits to continue" },
    { code: "403", color: "text-red-400", title: "Forbidden", description: "Subscription required - upgrade to access this feature" },
    { code: "404", color: "text-orange-400", title: "Not Found", description: "Endpoint or resource not found" },
    { code: "429", color: "text-orange-400", title: "Rate Limited", description: "Too many requests - wait and retry (see Retry-After header)" },
    { code: "500", color: "text-red-500", title: "Server Error", description: "Internal error - contact support if persistent" },
    { code: "502", color: "text-red-500", title: "Bad Gateway", description: "Platform API unavailable - retry later" },
    { code: "503", color: "text-red-500", title: "Service Unavailable", description: "Service temporarily down - retry later" },
];

function EndpointCard({ endpoint }: { endpoint: EndpointInfo }) {
    const [isOpen, setIsOpen] = useState(false);
    const { copied, copy } = useCopyToClipboard();

    const methodColors = {
        GET: "bg-blue-500/20 text-blue-400 border-blue-500/30",
        POST: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
        DELETE: "bg-red-500/20 text-red-400 border-red-500/30",
    };

    const handleCopy = () => {
        copy(`${BASE_URL}${endpoint.path}`);
    };

    return (
        <Collapsible open={isOpen} onOpenChange={setIsOpen}>
            <div className="border rounded-lg bg-secondary/30">
                <CollapsibleTrigger className="w-full">
                    <div className="p-4 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                            <Badge variant="outline" className={`${methodColors[endpoint.method]} font-mono shrink-0`}>
                                {endpoint.method}
                            </Badge>
                            <code className="text-sm font-mono truncate">{endpoint.path}</code>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                            <Badge variant="secondary" className="text-xs hidden sm:inline-flex">
                                {endpoint.rateLimit}
                            </Badge>
                            {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </div>
                    </div>
                </CollapsibleTrigger>

                <CollapsibleContent>
                    <div className="px-4 pb-4 space-y-4 border-t pt-4">
                        <p className="text-sm text-muted-foreground">{endpoint.description}</p>

                        {/* Full URL */}
                        <div className="space-y-2">
                            <Label className="text-xs">Full URL</Label>
                            <div className="flex gap-2">
                                <Input
                                    value={`${BASE_URL}${endpoint.path}`}
                                    readOnly
                                    className="font-mono text-xs"
                                />
                                <Button variant="outline" size="sm" onClick={handleCopy}>
                                    {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                                </Button>
                            </div>
                        </div>

                        {/* Request Body */}
                        {endpoint.requestBody && (
                            <div className="space-y-2">
                                <Label className="text-xs">Request Body</Label>
                                <div className="rounded-lg border bg-secondary/50 overflow-hidden">
                                    <table className="w-full text-xs">
                                        <thead className="bg-secondary">
                                            <tr>
                                                <th className="text-left p-2 font-medium">Field</th>
                                                <th className="text-left p-2 font-medium">Type</th>
                                                <th className="text-left p-2 font-medium hidden sm:table-cell">Required</th>
                                                <th className="text-left p-2 font-medium hidden md:table-cell">Description</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {endpoint.requestBody.map((field) => (
                                                <tr key={field.field} className="border-t border-border/50">
                                                    <td className="p-2 font-mono text-primary">{field.field}</td>
                                                    <td className="p-2 font-mono text-muted-foreground">{field.type}</td>
                                                    <td className="p-2 hidden sm:table-cell">
                                                        {field.required ? (
                                                            <Badge variant="destructive" className="text-[10px]">Required</Badge>
                                                        ) : (
                                                            <Badge variant="secondary" className="text-[10px]">Optional</Badge>
                                                        )}
                                                    </td>
                                                    <td className="p-2 text-muted-foreground hidden md:table-cell">{field.description}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}

                        {/* Query Params */}
                        {endpoint.queryParams && (
                            <div className="space-y-2">
                                <Label className="text-xs">Query Parameters</Label>
                                <div className="rounded-lg border bg-secondary/50 overflow-hidden">
                                    <table className="w-full text-xs">
                                        <thead className="bg-secondary">
                                            <tr>
                                                <th className="text-left p-2 font-medium">Param</th>
                                                <th className="text-left p-2 font-medium">Type</th>
                                                <th className="text-left p-2 font-medium hidden sm:table-cell">Description</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {endpoint.queryParams.map((param) => (
                                                <tr key={param.param} className="border-t border-border/50">
                                                    <td className="p-2 font-mono text-primary">{param.param}</td>
                                                    <td className="p-2 font-mono text-muted-foreground">{param.type}</td>
                                                    <td className="p-2 text-muted-foreground hidden sm:table-cell">{param.description}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}

                        {/* Response Example */}
                        {endpoint.responseExample && (
                            <div className="space-y-2">
                                <Label className="text-xs">Response Example</Label>
                                <pre className="p-3 rounded-lg bg-secondary/50 text-xs font-mono overflow-x-auto">
                                    {endpoint.responseExample}
                                </pre>
                            </div>
                        )}
                    </div>
                </CollapsibleContent>
            </div>
        </Collapsible>
    );
}

export default function ApiKeys() {
    const [showKey, setShowKey] = useState(false);
    const { toast } = useToast();
    const { profile, refreshProfile } = useAuth();
    const { copied, copy } = useCopyToClipboard();

    const apiKey = profile?.api_key || "Not available";
    const maskedKey = apiKey.slice(0, 8) + "..." + apiKey.slice(-4);

    const handleCopyApiKey = async () => {
        await copy(apiKey);
        toast({
            title: "API Key copied",
            description: "The API key has been copied to your clipboard.",
        });
    };

    const handleRegenerateApiKey = async () => {
        if (!profile) return;

        const { error } = await supabase
            .from("profiles")
            .update({ api_key: crypto.randomUUID() })
            .eq("id", profile.id);

        if (error) {
            toast({
                title: "Error",
                description: "Failed to regenerate API key.",
                variant: "destructive",
            });
        } else {
            await refreshProfile();
            toast({
                title: "API Key regenerated",
                description: "Your new API key is ready to use.",
            });
        }
    };

    return (
        <DashboardLayout>
            <div className="space-y-6">
                {/* Header */}
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                    <div>
                        <h1 className="text-2xl sm:text-3xl font-bold">API Keys</h1>
                        <p className="text-muted-foreground mt-1">
                            Manage your API keys for external integrations
                        </p>
                    </div>
                    <Button variant="gradient" className="w-full sm:w-auto">
                        <Plus className="w-4 h-4 mr-2" />
                        Create New Key
                    </Button>
                </div>

                {/* Current API Key */}
                <Card>
                    <CardHeader>
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                                <Key className="w-5 h-5 text-primary" />
                            </div>
                            <div>
                                <CardTitle className="text-lg">Default API Key</CardTitle>
                                <CardDescription>
                                    Use this key to integrate with n8n, Zapier, or custom tools
                                </CardDescription>
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="space-y-2">
                            <Label>Your API Key</Label>
                            <div className="flex flex-col sm:flex-row gap-2">
                                <div className="flex-1 relative">
                                    <Input
                                        value={showKey ? apiKey : maskedKey}
                                        readOnly
                                        className="pr-20 font-mono text-sm"
                                    />
                                    <div className="absolute right-1 top-1/2 -translate-y-1/2 flex gap-1">
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-7 w-7 p-0"
                                            onClick={() => setShowKey(!showKey)}
                                        >
                                            {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-7 w-7 p-0"
                                            onClick={handleCopyApiKey}
                                        >
                                            {copied ? (
                                                <Check className="w-4 h-4 text-emerald-400" />
                                            ) : (
                                                <Copy className="w-4 h-4" />
                                            )}
                                        </Button>
                                    </div>
                                </div>
                                <Button variant="outline" onClick={handleRegenerateApiKey} className="shrink-0">
                                    <RefreshCw className="w-4 h-4 mr-2" />
                                    Regenerate
                                </Button>
                            </div>
                            <p className="text-xs text-muted-foreground">
                                Keep this key secret. Never share it publicly. Include it in the <code className="bg-secondary px-1 rounded">x-api-key</code> header.
                            </p>
                        </div>
                    </CardContent>
                </Card>

                {/* API Usage Stats */}
                <Card>
                    <CardHeader>
                        <CardTitle className="text-lg flex items-center gap-2">
                            <Activity className="w-5 h-5" />
                            API Usage Status
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            <div className="p-4 rounded-lg bg-secondary/50 text-center">
                                <p className="text-2xl font-bold text-primary">10</p>
                                <p className="text-sm text-muted-foreground">Current Usage</p>
                            </div>
                            <div className="p-4 rounded-lg bg-secondary/50 text-center">
                                <p className="text-2xl font-bold">10</p>
                                <p className="text-sm text-muted-foreground">Usage Limit</p>
                            </div>
                            <div className="p-4 rounded-lg bg-secondary/50 text-center">
                                <div className="flex items-center justify-center gap-1">
                                    <Clock className="w-4 h-4" />
                                    <p className="text-lg font-bold">Jan 28</p>
                                </div>
                                <p className="text-sm text-muted-foreground">Next Reset</p>
                            </div>
                        </div>
                        <div className="mt-4">
                            <div className="flex justify-between text-sm mb-1">
                                <span>Usage Progress</span>
                                <span>10 / 10</span>
                            </div>
                            <div className="w-full bg-secondary rounded-full h-2">
                                <div className="bg-primary h-2 rounded-full" style={{ width: "100%" }}></div>
                            </div>
                        </div>
                    </CardContent>
                </Card>

                {/* Webhook Subscriptions */}
                <WebhookSubscriptionsCard />

                {/* API Endpoints */}
                <Card>
                    <CardHeader>
                        <div className="flex items-center justify-between">
                            <div>
                                <CardTitle className="text-lg">API Endpoints</CardTitle>
                                <CardDescription>Available endpoints for your integrations. Click to expand for details.</CardDescription>
                                <p className="text-sm text-muted-foreground mt-2">
                                    <span className="font-bold text-foreground">Base URL: </span>
                                    <code className="font-mono text-sm bg-muted px-2 py-1 rounded">https://api.postora.cloud/functions/v1/n8n-api</code>
                                    <span>{" "}+ endpoint path</span>
                                </p>
                            </div>
                            <Button variant="outline" size="sm" asChild>
                                <a href="/docs" target="_blank" rel="noopener noreferrer" className="gap-2">
                                    <ExternalLink className="w-4 h-4" />
                                    Full Docs
                                </a>
                            </Button>
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        {API_ENDPOINTS.map((endpoint) => (
                            <EndpointCard key={`${endpoint.method}-${endpoint.path}`} endpoint={endpoint} />
                        ))}
                    </CardContent>
                </Card>

                {/* MCP Server Connection */}
                <Card>
                    <CardHeader>
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                                <Plug className="w-5 h-5 text-primary" />
                            </div>
                            <div className="flex-1">
                                <div className="flex items-center gap-2">
                                    <CardTitle className="text-lg">MCP Server</CardTitle>
                                    <Badge variant="outline" className="text-[10px] bg-amber-500/10 text-amber-400 border-amber-500/30">Beta</Badge>
                                </div>
                                <CardDescription>
                                    Connect Postora to Claude, Cursor, ChatGPT and other MCP-compatible AI agents using the same API key above.
                                </CardDescription>
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent>
                        <McpConnectionPanel apiKey={showKey ? apiKey : ""} />
                    </CardContent>
                </Card>

                {/* Connected MCP clients */}
                <McpConnectedClients />

                {/* Error Codes Reference */}
                <Card>
                    <CardHeader>
                        <CardTitle className="text-lg">Error Codes Reference</CardTitle>
                        <CardDescription>Common HTTP status codes and their meanings</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="rounded-lg border overflow-hidden">
                            <table className="w-full text-sm">
                                <thead className="bg-secondary">
                                    <tr>
                                        <th className="text-left p-3 font-medium w-20">Code</th>
                                        <th className="text-left p-3 font-medium w-32">Status</th>
                                        <th className="text-left p-3 font-medium">Description</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {ERROR_CODES.map((error) => (
                                        <tr key={error.code} className="border-t border-border/50">
                                            <td className="p-3">
                                                <span className={`font-mono font-bold ${error.color}`}>{error.code}</span>
                                            </td>
                                            <td className="p-3 font-medium">{error.title}</td>
                                            <td className="p-3 text-muted-foreground">{error.description}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </CardContent>
                </Card>

                {/* Authentication Example */}
                <Card>
                    <CardHeader>
                        <CardTitle className="text-lg">Quick Start Example</CardTitle>
                        <CardDescription>How to authenticate and make your first API call</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <pre className="p-4 rounded-lg bg-secondary/50 text-xs font-mono overflow-x-auto">
{`curl -X POST "${BASE_URL}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "platforms": ["instagram", "twitter"],
    "caption": "Hello from the API! 🚀",
    "media_urls": ["https://example.com/image.jpg"]
  }'`}
                        </pre>
                    </CardContent>
                </Card>
            </div>
        </DashboardLayout>
    );
}
