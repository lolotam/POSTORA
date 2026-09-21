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
  Eye, Users, Lock, Shield, AtSign
} from "lucide-react";

const API_BASE = "https://api.postora.cloud/functions/v1/n8n-api";

export default function ThreadsApi() {
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
    "user_identifier": "your_username (threads)",
    "platforms": ["threads"],
    "title": "Hello Threads! 🧵 This is my first automated post."
  }'`;

  const curlPhotoPost = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_username (threads)",
    "platforms": ["threads"],
    "title": "Check out this photo! 📸",
    "media_urls": "https://example.com/image.jpg",
    "threads_alt_text": "A beautiful sunset over the ocean"
  }'`;

  const curlMultiplePhotos = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_username (threads)",
    "platforms": ["threads"],
    "title": "My photo carousel! 🎠",
    "media_urls": [
      "https://example.com/photo1.jpg",
      "https://example.com/photo2.jpg",
      "https://example.com/photo3.jpg"
    ],
    "threads_alt_text": "Photo collection from my trip"
  }'`;

  const curlVideoPost = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_video",
    "user_identifier": "your_username (threads)",
    "platforms": ["threads"],
    "title": "My latest video! 🎬",
    "media_urls": "https://example.com/video.mp4",
    "threads_title": "Amazing Video Content"
  }'`;

  const curlWithAllFields = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_username (threads)",
    "platforms": ["threads"],
    "title": "Complete post with all settings! ✨",
    "media_urls": "https://example.com/image.jpg",
    "threads_reply_control": "following",
    "threads_alt_text": "Detailed description of the image for accessibility",
    "first_comment": "Check out my bio for more content! #threads #automation"
  }'`;

  const curlScheduled = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_username (threads)",
    "platforms": ["threads"],
    "title": "Scheduled for later! ⏰",
    "media_urls": "https://example.com/image.jpg",
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
      default: "upload_photos",
      description: "The type of content to upload.",
      options: ["upload_photos", "upload_video", "upload_text"],
      icon: Zap
    },
    {
      name: "user_identifier",
      type: "string",
      required: true,
      description: "Account identifier in format: \"username (threads)\"",
      example: "myaccount (threads)",
      icon: AtSign
    },
    {
      name: "platforms",
      type: "string | array",
      required: true,
      description: "Platforms to post to. Use \"threads\" for Threads.",
      example: "[\"threads\"] or threads",
      formats: [
        { format: "JSON array", example: '["threads"]' },
        { format: "Comma-separated", example: "threads,instagram" },
        { format: "Single value", example: "threads" }
      ],
      icon: Hash
    },
    {
      name: "title",
      type: "string",
      required: false,
      description: "The main text content for your Threads post.",
      maxLength: 500,
      icon: FileText
    },
    {
      name: "media_urls",
      type: "string | array",
      required: false,
      description: "Single URL or array of URLs for images/videos. Up to 10 images or 1 video.",
      example: "https://example.com/image.jpg",
      icon: Image
    },
    {
      name: "media_base64",
      type: "string | array",
      required: false,
      description: "Base64 encoded media with data URI prefix. Alternative to media_urls for direct file upload without hosting. Supports multiple files as an array. In n8n, use Binary Data media source.",
      example: "data:image/jpeg;base64,/9j/4AAQSkZJRg...",
      icon: Image
    },
    {
      name: "threads_reply_control",
      type: "string",
      required: false,
      default: "everyone",
      description: "Controls who can reply to the thread.",
      options: ["everyone", "following", "mentioned"],
      n8nField: "Threads Reply Control",
      icon: MessageSquare
    },
    {
      name: "threads_alt_text",
      type: "string",
      required: false,
      description: "Alt text for media. Improves accessibility.",
      maxLength: 1000,
      n8nField: "Alt Text (Extended)",
      icon: Eye
    },
    {
      name: "threads_title",
      type: "string",
      required: false,
      description: "Override title specifically for Threads.",
      n8nField: "Threads Title (Override)",
      icon: FileText
    },
    {
      name: "first_comment",
      type: "string",
      required: false,
      description: "Auto-posted first comment. Great for hashtags.",
      maxLength: 500,
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
      example: "America/Los_Angeles",
      n8nField: "Timezone",
      icon: Globe
    }
  ];

  return (
    <div className="min-h-screen bg-background">
      <DocPageHeader
        isAuthenticated={!!user}
        title="Threads API"
        subtitle="Complete guide to posting on Threads via the Postora API"
        icon={MessageSquare}
        variant="indigo"
        headingPreset="violet-sky"
        ctaGradient="from-indigo-500 via-violet-500 to-purple-500"
        badges={[
          { label: "Text Posts", icon: MessageSquare },
          { label: "Photos", icon: Image },
          { label: "Videos", icon: Video },
          { label: "Carousels (10 images)", icon: Image },
          { label: "Scheduling", icon: Calendar },
        ]}
      />

      <main className="container mx-auto px-6 py-12 max-w-5xl">

        {/* Media Support Matrix */}
        <Card className="mb-8 border-purple-500/20 bg-purple-500/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-purple-500" />
              Media Support
            </CardTitle>
            <CardDescription>Threads supported media formats and limits</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 rounded-lg bg-background border">
                <h4 className="font-medium mb-2 flex items-center gap-2"><Image className="w-4 h-4" /> Images</h4>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>• Formats: JPEG, PNG, GIF, WEBP</li>
                  <li>• Max size: 8MB per image</li>
                  <li>• Max images: 10 per carousel</li>
                  <li>• Aspect ratio: 1.91:1 to 4:5</li>
                </ul>
              </div>
              <div className="p-4 rounded-lg bg-background border">
                <h4 className="font-medium mb-2 flex items-center gap-2"><Video className="w-4 h-4" /> Videos</h4>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>• Formats: MP4, MOV</li>
                  <li>• Max size: 1GB</li>
                  <li>• Max duration: 5 minutes</li>
                  <li>• Min duration: 1 second</li>
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
            <CardDescription>Get your first Threads post published in 2 minutes</CardDescription>
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
                <p className="font-medium">Get your Account Identifier</p>
                <p className="text-sm text-muted-foreground">Run the accounts endpoint to find your Threads username</p>
              </div>
            </div>
            <CodeBlock code={curlGetAccounts} language="bash" id="get-accounts" title="Get accounts" />
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">3</div>
              <div>
                <p className="font-medium">Post to Threads</p>
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
              <TabsList className="grid grid-cols-3 lg:grid-cols-6 mb-4">
                <TabsTrigger value="text">Text</TabsTrigger>
                <TabsTrigger value="photo">Photo</TabsTrigger>
                <TabsTrigger value="carousel">Carousel</TabsTrigger>
                <TabsTrigger value="video">Video</TabsTrigger>
                <TabsTrigger value="all-fields">All Fields</TabsTrigger>
                <TabsTrigger value="scheduled">Scheduled</TabsTrigger>
              </TabsList>
              <TabsContent value="text">
                <CodeBlock code={curlTextPost} language="bash" id="text-post" title="Text post" />
              </TabsContent>
              <TabsContent value="photo">
                <CodeBlock code={curlPhotoPost} language="bash" id="photo-post" title="Photo post" />
              </TabsContent>
              <TabsContent value="carousel">
                <CodeBlock code={curlMultiplePhotos} language="bash" id="carousel-post" title="Carousel post" />
              </TabsContent>
              <TabsContent value="video">
                <CodeBlock code={curlVideoPost} language="bash" id="video-post" title="Video post" />
              </TabsContent>
              <TabsContent value="all-fields">
                <CodeBlock code={curlWithAllFields} language="bash" id="all-fields-post" title="All fields" />
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
            <CardDescription>Complete list of available fields for Threads posts</CardDescription>
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
    "threads": {
      "success": true,
      "post_id": "12345678901234567",
      "post_url": "https://threads.net/@username/post/ABC123"
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
  "error": "Invalid media URL",
  "details": "The provided URL is not accessible or not a valid media file"
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
          <Link to="/docs/instagram-api" className="text-muted-foreground hover:text-foreground flex items-center gap-2">
            <ArrowLeft className="w-4 h-4" />
            Instagram API
          </Link>
          <Link to="/docs/bluesky-api" className="text-primary hover:underline flex items-center gap-2">
            Bluesky API
            <ArrowLeft className="w-4 h-4 rotate-180" />
          </Link>
        </div>
      </main>
    </div>
  );
}
