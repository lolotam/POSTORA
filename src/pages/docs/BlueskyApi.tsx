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
  Eye, Link as LinkIcon, Languages, Shield, AtSign, Cloud
} from "lucide-react";

const API_BASE = "https://api.postora.cloud/functions/v1/n8n-api";

export default function BlueskyApi() {
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
    "user_identifier": "yourhandle.bsky.social (bluesky)",
    "platforms": ["bluesky"],
    "title": "Hello Bluesky! 🦋 My first automated post from Postora."
  }'`;

  const curlPhotoPost = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "yourhandle.bsky.social (bluesky)",
    "platforms": ["bluesky"],
    "title": "Check out this beautiful photo! 📸",
    "media_urls": "https://example.com/image.jpg",
    "bluesky_alt_text": "A stunning mountain landscape at sunset"
  }'`;

  const curlMultiplePhotos = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "yourhandle.bsky.social (bluesky)",
    "platforms": ["bluesky"],
    "title": "Photo thread! 🧵",
    "media_urls": [
      "https://example.com/photo1.jpg",
      "https://example.com/photo2.jpg",
      "https://example.com/photo3.jpg",
      "https://example.com/photo4.jpg"
    ],
    "bluesky_alt_text": "Collection of photos from my recent trip"
  }'`;

  const curlVideoPost = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_video",
    "user_identifier": "yourhandle.bsky.social (bluesky)",
    "platforms": ["bluesky"],
    "title": "My latest video! 🎬",
    "media_urls": "https://example.com/video.mp4",
    "bluesky_title": "Amazing Video Content"
  }'`;

  const curlWithLink = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_text",
    "user_identifier": "yourhandle.bsky.social (bluesky)",
    "platforms": ["bluesky"],
    "title": "Check out this amazing article! 🔗",
    "bluesky_embed_link": "https://example.com/my-article",
    "bluesky_language": "en"
  }'`;

  const curlWithAllFields = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "yourhandle.bsky.social (bluesky)",
    "platforms": ["bluesky"],
    "title": "Complete post with all settings! ✨",
    "media_urls": "https://example.com/image.jpg",
    "bluesky_alt_text": "Detailed description of the image",
    "bluesky_language": "en",
    "bluesky_embed_link": "https://mywebsite.com",
    "first_comment": "Reply to this post for more info!"
  }'`;

  const curlScheduled = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "yourhandle.bsky.social (bluesky)",
    "platforms": ["bluesky"],
    "title": "Scheduled for later! ⏰",
    "media_urls": "https://example.com/image.jpg",
    "scheduled_date": "2026-01-15T18:00:00Z",
    "timezone": "Europe/London"
  }'`;

  const curlGetAccounts = `curl -X GET "${API_BASE}/api/v1/accounts" \\
  -H "x-api-key: YOUR_API_KEY"`;

  const fields = [
    {
      name: "operation",
      type: "string",
      required: false,
      default: "upload_photos",
      description: "The type of content to upload.",
      options: ["upload_photos", "upload_video", "upload_text"],
      icon: Zap
    },
    {
      name: "user_identifier",
      type: "string",
      required: true,
      description: "Account identifier in format: \"handle.bsky.social (bluesky)\"",
      example: "myhandle.bsky.social (bluesky)",
      icon: AtSign
    },
    {
      name: "platforms",
      type: "string | array",
      required: true,
      description: "Platforms to post to. Use \"bluesky\" for Bluesky.",
      example: "[\"bluesky\"] or bluesky",
      formats: [
        { format: "JSON array", example: '["bluesky"]' },
        { format: "Comma-separated", example: "bluesky,threads" },
        { format: "Single value", example: "bluesky" }
      ],
      icon: Hash
    },
    {
      name: "title",
      type: "string",
      required: false,
      description: "The main text content for your Bluesky post.",
      maxLength: 300,
      icon: FileText
    },
    {
      name: "media_urls",
      type: "string | array",
      required: false,
      description: "Single URL or array of URLs for images. Up to 4 images per post.",
      example: "https://example.com/image.jpg",
      icon: Image
    },
    {
      name: "media_base64",
      type: "string | array",
      required: false,
      description: "Base64 encoded media with data URI prefix. Alternative to media_urls for direct file upload without hosting. Supports up to 4 images. In n8n, use Binary Data media source.",
      example: "data:image/jpeg;base64,/9j/4AAQSkZJRg...",
      icon: Image
    },
    {
      name: "bluesky_alt_text",
      type: "string",
      required: false,
      description: "Alt text for media. Important for accessibility.",
      maxLength: 2000,
      n8nField: "Alt Text (Extended)",
      icon: Eye
    },
    {
      name: "bluesky_language",
      type: "string",
      required: false,
      default: "en",
      description: "Language code for the post (ISO 639-1).",
      example: "en, es, fr, de, ja",
      n8nField: "Bluesky Language",
      icon: Languages
    },
    {
      name: "bluesky_embed_link",
      type: "string",
      required: false,
      description: "URL to embed as a link card in the post.",
      example: "https://example.com/article",
      n8nField: "Bluesky Embed Link",
      icon: LinkIcon
    },
    {
      name: "bluesky_title",
      type: "string",
      required: false,
      description: "Override title specifically for Bluesky.",
      n8nField: "Bluesky Title (Override)",
      icon: FileText
    },
    {
      name: "first_comment",
      type: "string",
      required: false,
      description: "Auto-posted reply to your own post.",
      maxLength: 300,
      n8nField: "First Comment",
      icon: MessageSquare
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
      example: "Europe/London",
      n8nField: "Timezone",
      icon: Globe
    }
  ];

  return (
    <div className="min-h-screen bg-background">
      <DocPageHeader
        isAuthenticated={!!user}
        title="Bluesky API"
        subtitle="Complete guide to posting on Bluesky via the Postora API"
        icon={Cloud}
        variant="cyan"
        headingPreset="emerald-cyan-sky"
        ctaGradient="from-cyan-500 via-sky-500 to-blue-500"
        badges={[
          { label: "Text Posts", icon: MessageSquare },
          { label: "Photos (4 max)", icon: Image },
          { label: "Videos", icon: Video },
          { label: "Link Embeds", icon: LinkIcon },
          { label: "Scheduling", icon: Calendar },
        ]}
      />

      <main className="container mx-auto px-6 py-12 max-w-5xl">

        {/* Media Support Matrix */}
        <Card className="mb-8 border-border bg-muted">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-foreground" />
              Media Support
            </CardTitle>
            <CardDescription>Bluesky supported media formats and limits</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 rounded-lg bg-background border">
                <h4 className="font-medium mb-2 flex items-center gap-2"><Image className="w-4 h-4" /> Images</h4>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>• Formats: JPEG, PNG, GIF, WEBP</li>
                  <li>• Max size: 1MB per image</li>
                  <li>• Max images: 4 per post</li>
                  <li>• Recommended: 1:1 or 4:3 aspect ratio</li>
                </ul>
              </div>
              <div className="p-4 rounded-lg bg-background border">
                <h4 className="font-medium mb-2 flex items-center gap-2"><Video className="w-4 h-4" /> Videos</h4>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>• Formats: MP4</li>
                  <li>• Max size: 50MB</li>
                  <li>• Max duration: 60 seconds</li>
                  <li>• Codec: H.264 recommended</li>
                </ul>
              </div>
            </div>
            <div className="mt-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <p className="text-sm flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-amber-500" />
                Bluesky has a 300 character limit for post text. Hashtags and mentions are detected automatically.
              </p>
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
            <CardDescription>Get your first Bluesky post published in 2 minutes</CardDescription>
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
                <p className="font-medium">Connect Bluesky Account</p>
                <p className="text-sm text-muted-foreground">Use your Bluesky handle and app password from <Link to="/profiles" className="text-primary hover:underline">Profiles</Link></p>
              </div>
            </div>
            <CodeBlock code={curlGetAccounts} language="bash" id="get-accounts" title="Get accounts" />
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">3</div>
              <div>
                <p className="font-medium">Post to Bluesky</p>
                <p className="text-sm text-muted-foreground">Use the post endpoint with your credentials</p>
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
            <Tabs defaultValue="text" className="w-full">
              <TabsList className="grid grid-cols-3 lg:grid-cols-7 mb-4">
                <TabsTrigger value="text">Text</TabsTrigger>
                <TabsTrigger value="photo">Photo</TabsTrigger>
                <TabsTrigger value="multi">Multi Photo</TabsTrigger>
                <TabsTrigger value="video">Video</TabsTrigger>
                <TabsTrigger value="link">With Link</TabsTrigger>
                <TabsTrigger value="all">All Fields</TabsTrigger>
                <TabsTrigger value="scheduled">Scheduled</TabsTrigger>
              </TabsList>
              <TabsContent value="text">
                <CodeBlock code={curlTextPost} language="bash" id="text-post" title="Text post" />
              </TabsContent>
              <TabsContent value="photo">
                <CodeBlock code={curlPhotoPost} language="bash" id="photo-post" title="Photo post" />
              </TabsContent>
              <TabsContent value="multi">
                <CodeBlock code={curlMultiplePhotos} language="bash" id="multi-post" title="Multi photo post" />
              </TabsContent>
              <TabsContent value="video">
                <CodeBlock code={curlVideoPost} language="bash" id="video-post" title="Video post" />
              </TabsContent>
              <TabsContent value="link">
                <CodeBlock code={curlWithLink} language="bash" id="link-post" title="With link embed" />
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
            <CardDescription>Complete list of available fields for Bluesky posts</CardDescription>
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
    "bluesky": {
      "success": true,
      "post_id": "at://did:plc:xyz/app.bsky.feed.post/abc123",
      "post_url": "https://bsky.app/profile/handle.bsky.social/post/abc123"
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
  "timezone": "Europe/London"
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
  "error": "Image too large",
  "details": "Bluesky images must be under 1MB. Your image was 2.3MB."
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
          <Link to="/docs/threads-api" className="text-muted-foreground hover:text-foreground flex items-center gap-2">
            <ArrowLeft className="w-4 h-4" />
            Threads API
          </Link>
          <Link to="/docs/reddit-api" className="text-primary hover:underline flex items-center gap-2">
            Reddit API
            <ArrowLeft className="w-4 h-4 rotate-180" />
          </Link>
        </div>
      </main>
    </div>
  );
}
