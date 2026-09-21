import { Link } from "react-router-dom";
import { DocPageHeader } from "@/components/docs";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/useAuth";
import { PlatformIcon } from "@/components/PlatformIcon";
import { useCopyToClipboard } from "@/hooks/shared";
import {
  ArrowLeft, Copy, Check, Image, Video,
  MessageSquare, FileText, AlertCircle,
  CheckCircle2, Calendar, Globe, Zap, Hash,
  Eye, Link as LinkIcon, Shield, Users, Lock,
  Tag, AlertTriangle, MailCheck, Flame
} from "lucide-react";

const API_BASE = "https://api.postora.cloud/functions/v1/n8n-api";

export default function RedditApi() {
  const { copiedId, copy } = useCopyToClipboard();
  const { user } = useAuth();

  const CodeBlock = ({ code, language, id, title }: { code: string; language: string; id: string; title?: string }) => (
    <div className="relative group rounded-xl bg-[#0d1117] border border-[#30363d] overflow-hidden my-4">
      <div className="flex items-center justify-between px-4 py-2 border-b border-[#30363d] bg-[#161b22]">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400 font-mono">{language}</span>
          {title && <span className="text-xs text-gray-500">• {title}</span>}
        </div>
        <Button variant="ghost" size="sm" onClick={() => copy(code, id)} className="h-7 text-xs text-gray-300 hover:text-white hover:bg-white/10">
          {copiedId === id ? <Check className="w-3 h-3 me-1" /> : <Copy className="w-3 h-3 me-1" />}
          {copiedId === id ? "Copied!" : "Copy"}
        </Button>
      </div>
      <pre className="p-4 overflow-x-auto text-sm"><code className="text-gray-200">{code}</code></pre>
    </div>
  );

  // JSON Body Examples
  const curlTextPost = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_text",
    "user_identifier": "your_username (reddit)",
    "platforms": ["reddit"],
    "reddit_subreddit": "test",
    "reddit_title": "My first automated Reddit post!",
    "title": "This is the body text of my self post. It can include markdown formatting!",
    "reddit_post_type": "self"
  }'`;

  const curlLinkPost = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_text",
    "user_identifier": "your_username (reddit)",
    "platforms": ["reddit"],
    "reddit_subreddit": "programming",
    "reddit_title": "Amazing open source project I found",
    "reddit_post_type": "link",
    "reddit_link_url": "https://github.com/example/project"
  }'`;

  const curlImagePost = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_username (reddit)",
    "platforms": ["reddit"],
    "reddit_subreddit": "pics",
    "reddit_title": "Beautiful sunset I captured today",
    "media_urls": "https://example.com/sunset.jpg",
    "reddit_post_type": "image"
  }'`;

  const curlWithFlair = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_text",
    "user_identifier": "your_username (reddit)",
    "platforms": ["reddit"],
    "reddit_subreddit": "news",
    "reddit_title": "Breaking: Important announcement",
    "title": "Full details of the announcement...",
    "reddit_post_type": "self",
    "reddit_flair": "Breaking News"
  }'`;

  const curlWithAllFields = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_username (reddit)",
    "platforms": ["reddit"],
    "reddit_subreddit": "gaming",
    "reddit_title": "[Spoiler] End game boss strategy",
    "title": "Here is my detailed strategy for beating the final boss...",
    "media_urls": "https://example.com/screenshot.jpg",
    "reddit_post_type": "image",
    "reddit_spoiler": true,
    "reddit_nsfw": false,
    "reddit_send_replies": true,
    "reddit_flair": "Strategy Guide"
  }'`;

  const curlScheduled = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_text",
    "user_identifier": "your_username (reddit)",
    "platforms": ["reddit"],
    "reddit_subreddit": "announcements",
    "reddit_title": "Scheduled announcement",
    "title": "This post will be published at the scheduled time.",
    "reddit_post_type": "self",
    "scheduled_date": "2026-01-15T18:00:00Z",
    "timezone": "America/New_York"
  }'`;

  const curlGetAccounts = `curl -X GET "${API_BASE}/api/v1/accounts" \\
  -H "x-api-key: YOUR_API_KEY"`;

  const fields = [
    {
      name: "operation",
      type: "string",
      required: false,
      default: "upload_text",
      description: "The type of content to upload.",
      options: ["upload_text", "upload_photos"],
      icon: Zap
    },
    {
      name: "user_identifier",
      type: "string",
      required: true,
      description: "Account identifier in format: \"username (reddit)\"",
      example: "my_reddit_user (reddit)",
      icon: Users
    },
    {
      name: "platforms",
      type: "string | array",
      required: true,
      description: "Platforms to post to. Use \"reddit\" for Reddit.",
      example: "[\"reddit\"] or reddit",
      icon: Hash
    },
    {
      name: "reddit_subreddit",
      type: "string",
      required: true,
      description: "The subreddit to post to (without r/ prefix).",
      example: "programming, news, pics",
      n8nField: "Subreddit",
      icon: Hash
    },
    {
      name: "reddit_title",
      type: "string",
      required: true,
      description: "The title of your Reddit post.",
      maxLength: 300,
      n8nField: "Reddit Title",
      icon: FileText
    },
    {
      name: "title",
      type: "string",
      required: false,
      description: "The body text for self posts. Supports markdown.",
      maxLength: 40000,
      icon: FileText
    },
    {
      name: "reddit_post_type",
      type: "string",
      required: false,
      default: "self",
      description: "The type of Reddit post to create.",
      options: ["self", "link", "image"],
      n8nField: "Reddit Post Type",
      icon: FileText
    },
    {
      name: "reddit_link_url",
      type: "string",
      required: false,
      description: "URL for link posts. Required when post_type is 'link'.",
      example: "https://example.com/article",
      n8nField: "Link URL",
      icon: LinkIcon
    },
    {
      name: "media_urls",
      type: "string | array",
      required: false,
      description: "Image URL for image posts. Required when post_type is 'image'.",
      example: "https://example.com/image.jpg",
      icon: Image
    },
    {
      name: "media_base64",
      type: "string | array",
      required: false,
      description: "Base64 encoded image with data URI prefix. Alternative to media_urls for direct file upload without hosting. In n8n, use Binary Data media source.",
      example: "data:image/jpeg;base64,/9j/4AAQSkZJRg...",
      icon: Image
    },
    {
      name: "reddit_spoiler",
      type: "boolean",
      required: false,
      default: false,
      description: "Mark the post as containing spoilers.",
      n8nField: "Spoiler Tag",
      icon: AlertTriangle
    },
    {
      name: "reddit_nsfw",
      type: "boolean",
      required: false,
      default: false,
      description: "Mark the post as NSFW (Not Safe For Work).",
      n8nField: "NSFW Tag",
      icon: Lock
    },
    {
      name: "reddit_send_replies",
      type: "boolean",
      required: false,
      default: true,
      description: "Receive reply notifications in your inbox.",
      n8nField: "Send Replies to Inbox",
      icon: MailCheck
    },
    {
      name: "reddit_flair",
      type: "string",
      required: false,
      description: "Post flair text. Must be allowed by the subreddit.",
      example: "Discussion, OC, Question",
      n8nField: "Flair",
      icon: Tag
    },
    {
      name: "scheduled_date",
      type: "string",
      required: false,
      description: "ISO 8601 date/time for scheduling.",
      example: "2026-01-15T18:00:00Z",
      n8nField: "Scheduled Date",
      icon: Calendar
    },
    {
      name: "timezone",
      type: "string",
      required: false,
      default: "UTC",
      description: "Timezone for the scheduled post.",
      example: "America/New_York",
      n8nField: "Timezone",
      icon: Globe
    }
  ];

  return (
    <div className="min-h-screen bg-background">
      <DocPageHeader
        isAuthenticated={!!user}
        title="Reddit API"
        subtitle="Complete guide to posting on Reddit via the Postora API"
        icon={Flame}
        variant="amber"
        headingPreset="amber-rose-violet"
        ctaGradient="from-amber-500 via-orange-500 to-rose-500"
        badges={[
          { label: "Self Posts (Text)", icon: MessageSquare },
          { label: "Link Posts", icon: LinkIcon },
          { label: "Image Posts", icon: Image },
          { label: "Flair Support", icon: Tag },
          { label: "Scheduling", icon: Calendar },
        ]}
      />

      <main className="container mx-auto px-6 py-12 max-w-5xl">

        {/* Important Notes */}
        <Card className="mb-8 border-orange-500/20 bg-orange-500/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-orange-500" />
              Important Notes
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-green-500 mt-0.5" />
              <p className="text-sm"><strong>Subreddit is required</strong> - You must specify which subreddit to post to</p>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-green-500 mt-0.5" />
              <p className="text-sm"><strong>Title is required</strong> - Reddit posts always need a title (max 300 chars)</p>
            </div>
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5" />
              <p className="text-sm"><strong>Subreddit rules</strong> - Each subreddit has different rules. Check before posting.</p>
            </div>
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5" />
              <p className="text-sm"><strong>Rate limits</strong> - Reddit has strict rate limits. Wait between posts.</p>
            </div>
          </CardContent>
        </Card>

        {/* Media Support Matrix */}
        <Card className="mb-8 border-orange-500/20 bg-orange-500/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-orange-500" />
              Post Types & Media Support
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="p-4 rounded-lg bg-background border">
                <h4 className="font-medium mb-2 flex items-center gap-2"><MessageSquare className="w-4 h-4" /> Self Posts</h4>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>• Text with markdown</li>
                  <li>• Max body: 40,000 chars</li>
                  <li>• Title required</li>
                </ul>
              </div>
              <div className="p-4 rounded-lg bg-background border">
                <h4 className="font-medium mb-2 flex items-center gap-2"><LinkIcon className="w-4 h-4" /> Link Posts</h4>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>• External URL link</li>
                  <li>• Auto-generates preview</li>
                  <li>• No body text allowed</li>
                </ul>
              </div>
              <div className="p-4 rounded-lg bg-background border">
                <h4 className="font-medium mb-2 flex items-center gap-2"><Image className="w-4 h-4" /> Image Posts</h4>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>• JPEG, PNG, GIF</li>
                  <li>• Max size: 20MB</li>
                  <li>• 1 image per post</li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Quick Start */}
        <Card className="mb-8 border-primary/20 bg-primary/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-primary" />
              Quick Start
            </CardTitle>
            <CardDescription>Get your first Reddit post published in 2 minutes</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">1</div>
              <div>
                <p className="font-medium">Get your API Key</p>
                <p className="text-sm text-muted-foreground">Navigate to <Link to="/api-keys" className="text-primary hover:underline">Settings → API Keys</Link></p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">2</div>
              <div>
                <p className="font-medium">Connect Reddit Account</p>
                <p className="text-sm text-muted-foreground">Connect your Reddit account from <Link to="/profiles" className="text-primary hover:underline">Profiles</Link></p>
              </div>
            </div>
            <CodeBlock code={curlGetAccounts} language="bash" id="get-accounts" title="Get accounts" />
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">3</div>
              <div>
                <p className="font-medium">Post to Reddit</p>
                <p className="text-sm text-muted-foreground">Use the post endpoint with subreddit and title</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* JSON Examples */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle>JSON Body Examples</CardTitle>
            <CardDescription>Copy and customize these examples for your n8n workflows</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="self" className="w-full">
              <TabsList className="grid grid-cols-3 lg:grid-cols-6 mb-4">
                <TabsTrigger value="self">Self Post</TabsTrigger>
                <TabsTrigger value="link">Link Post</TabsTrigger>
                <TabsTrigger value="image">Image Post</TabsTrigger>
                <TabsTrigger value="flair">With Flair</TabsTrigger>
                <TabsTrigger value="all">All Fields</TabsTrigger>
                <TabsTrigger value="scheduled">Scheduled</TabsTrigger>
              </TabsList>
              <TabsContent value="self">
                <CodeBlock code={curlTextPost} language="bash" id="self-post" title="Self post" />
              </TabsContent>
              <TabsContent value="link">
                <CodeBlock code={curlLinkPost} language="bash" id="link-post" title="Link post" />
              </TabsContent>
              <TabsContent value="image">
                <CodeBlock code={curlImagePost} language="bash" id="image-post" title="Image post" />
              </TabsContent>
              <TabsContent value="flair">
                <CodeBlock code={curlWithFlair} language="bash" id="flair-post" title="With flair" />
              </TabsContent>
              <TabsContent value="all">
                <CodeBlock code={curlWithAllFields} language="bash" id="all-fields" title="All fields" />
              </TabsContent>
              <TabsContent value="scheduled">
                <CodeBlock code={curlScheduled} language="bash" id="scheduled-post" title="Scheduled post" />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        {/* API Fields Reference */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle>API Fields Reference</CardTitle>
            <CardDescription>Complete list of available fields for Reddit posts</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {fields.map((field) => (
              <div key={field.name} className="p-4 rounded-lg border bg-card">
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <field.icon className="w-4 h-4 text-primary" />
                    <code className="text-sm font-mono font-bold">{field.name}</code>
                    <Badge variant="outline" className="text-xs">{field.type}</Badge>
                    {field.required && <Badge className="text-xs bg-red-500">Required</Badge>}
                  </div>
                </div>
                <p className="text-sm text-muted-foreground mb-2">{field.description}</p>
                {field.options && (
                  <div className="flex flex-wrap gap-1 mb-2">
                    {field.options.map((opt) => (
                      <Badge key={opt} variant="secondary" className="text-xs">{opt}</Badge>
                    ))}
                  </div>
                )}
                {field.example && (
                  <p className="text-xs text-muted-foreground">Example: <code className="bg-muted px-1 rounded">{field.example}</code></p>
                )}
                {field.maxLength && (
                  <p className="text-xs text-muted-foreground">Max length: {field.maxLength} characters</p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Response Examples */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle>Response Examples</CardTitle>
            <CardDescription>Example API responses</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="success">
              <TabsList className="mb-4">
                <TabsTrigger value="success">Success</TabsTrigger>
                <TabsTrigger value="scheduled">Scheduled</TabsTrigger>
                <TabsTrigger value="error">Error</TabsTrigger>
              </TabsList>
              <TabsContent value="success">
                <CodeBlock 
                  code={`{
  "success": true,
  "post_id": "uuid-here",
  "platforms": {
    "reddit": {
      "success": true,
      "post_id": "t3_abc123",
      "post_url": "https://reddit.com/r/subreddit/comments/abc123/my_post_title/"
    }
  },
  "created_at": "2026-01-11T12:00:00Z"
}`}
                  language="json"
                  id="success-response"
                  title="Success response"
                />
              </TabsContent>
              <TabsContent value="scheduled">
                <CodeBlock 
                  code={`{
  "success": true,
  "post_id": "uuid-here",
  "status": "scheduled",
  "scheduled_at": "2026-01-15T18:00:00Z",
  "timezone": "America/New_York"
}`}
                  language="json"
                  id="scheduled-response"
                  title="Scheduled response"
                />
              </TabsContent>
              <TabsContent value="error">
                <CodeBlock 
                  code={`{
  "success": false,
  "error": "Subreddit not found",
  "details": "The subreddit 'invalidsubreddit' does not exist or is private"
}`}
                  language="json"
                  id="error-response"
                  title="Error response"
                />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        {/* n8n Integration */}
        <Card className="mb-8 border-amber-500/20 bg-amber-500/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-amber-500" />
              n8n HTTP Request Configuration
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div className="p-3 rounded bg-background border">
                  <p className="text-muted-foreground">Method</p>
                  <p className="font-mono font-bold">POST</p>
                </div>
                <div className="p-3 rounded bg-background border">
                  <p className="text-muted-foreground">URL</p>
                  <p className="font-mono text-xs break-all">{API_BASE}/api/v1/post</p>
                </div>
              </div>
              <div className="p-3 rounded bg-background border">
                <p className="text-muted-foreground text-sm mb-2">Headers</p>
                <code className="text-xs block">Content-Type: application/json</code>
                <code className="text-xs block">x-api-key: {"{{ $credentials.postora.apiKey }}"}</code>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Footer navigation */}
        <div className="flex justify-between items-center pt-8 border-t">
          <Link to="/docs/bluesky-api" className="text-muted-foreground hover:text-foreground flex items-center gap-2">
            <ArrowLeft className="w-4 h-4" />
            Bluesky API
          </Link>
          <Link to="/docs/remove-background" className="text-primary hover:underline flex items-center gap-2">
            Remove Background API
            <ArrowLeft className="w-4 h-4 rotate-180" />
          </Link>
        </div>
      </main>
    </div>
  );
}
