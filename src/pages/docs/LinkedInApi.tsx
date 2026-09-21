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
  ArrowLeft, Copy, Check, ExternalLink, Image, Video,
  MessageSquare, Link as LinkIcon, FileText, AlertCircle,
  CheckCircle2, Info, Calendar, Globe, Zap, Hash, Layers,
  Eye, Users, Building2, Briefcase, Linkedin
} from "lucide-react";
import { cn } from "@/lib/utils";

const API_BASE = "https://api.postora.cloud/functions/v1/n8n-api";

export default function LinkedInApi() {
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
  const curlJsonBasicPost = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_name (linkedin)",
    "platforms": ["linkedin"],
    "caption": "Excited to share my latest project! 🚀",
    "media_urls": "https://res.cloudinary.com/demo/image/upload/sample.jpg"
  }'`;

  const curlJsonWithAllFields = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_name (linkedin)",
    "platforms": ["linkedin"],
    "caption": "Check out our new product launch! 🎉\\n\\nWe have been working on this for months and are thrilled to finally share it with you.",
    "media_urls": "https://res.cloudinary.com/demo/image/upload/product.jpg",
    "linkedin_visibility": "PUBLIC",
    "linkedin_feed_distribution": "MAIN_FEED",
    "linkedin_lifecycle_state": "PUBLISHED",
    "linkedin_allow_comments": true,
    "first_comment": "Drop a 🚀 if you are excited!"
  }'`;

  const curlJsonVideoPost = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_video",
    "user_identifier": "your_name (linkedin)",
    "platforms": ["linkedin"],
    "caption": "Behind the scenes of our team meeting! 🎬",
    "media_urls": "https://res.cloudinary.com/demo/video/upload/meeting.mp4",
    "linkedin_visibility": "PUBLIC",
    "linkedin_allow_comments": true
  }'`;

  const curlJsonTextOnly = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_name (linkedin)",
    "platforms": ["linkedin"],
    "caption": "💡 Thought of the day:\\n\\nThe best time to start was yesterday. The second best time is now.\\n\\nWhat is one thing you have been putting off that you can start today?\\n\\n#motivation #productivity #leadership",
    "linkedin_visibility": "PUBLIC"
  }'`;

  const curlJsonScheduled = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_name (linkedin)",
    "platforms": ["linkedin"],
    "caption": "Announcing our Q1 results! 📊",
    "media_urls": "https://res.cloudinary.com/demo/image/upload/quarterly-report.jpg",
    "linkedin_visibility": "PUBLIC",
    "scheduled_date": "2026-02-01T09:00:00Z",
    "timezone": "America/New_York"
  }'`;

  const curlJsonMultipleImages = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_name (linkedin)",
    "platforms": ["linkedin"],
    "caption": "Our team at the annual conference! 📸",
    "media_urls": [
      "https://res.cloudinary.com/demo/image/upload/team1.jpg",
      "https://res.cloudinary.com/demo/image/upload/team2.jpg",
      "https://res.cloudinary.com/demo/image/upload/team3.jpg"
    ],
    "linkedin_visibility": "PUBLIC"
  }'`;

  // Form-Data Examples
  const curlFormBasicPost = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "operation=upload_photos" \\
  -F "user_identifier=your_name (linkedin)" \\
  -F "platforms=linkedin" \\
  -F "caption=Excited to share my latest project! 🚀" \\
  -F "media_url=https://res.cloudinary.com/demo/image/upload/sample.jpg"`;

  const curlFormWithFile = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "operation=upload_photos" \\
  -F "user_identifier=your_name (linkedin)" \\
  -F "platforms=linkedin" \\
  -F "caption=Direct upload from my computer!" \\
  -F "file=@/path/to/image.jpg" \\
  -F "linkedin_visibility=PUBLIC"`;

  const curlFormVideo = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "operation=upload_video" \\
  -F "user_identifier=your_name (linkedin)" \\
  -F "platforms=linkedin" \\
  -F "caption=Check out this video! 🎥" \\
  -F "file=@/path/to/video.mp4" \\
  -F "linkedin_visibility=PUBLIC"`;

  const curlFormAllFields = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "operation=upload_photos" \\
  -F "user_identifier=your_name (linkedin)" \\
  -F "platforms=linkedin" \\
  -F "caption=Complete post with all settings!" \\
  -F "file=@/path/to/image.jpg" \\
  -F "linkedin_visibility=PUBLIC" \\
  -F "linkedin_feed_distribution=MAIN_FEED" \\
  -F "linkedin_allow_comments=true" \\
  -F "first_comment=First comment on my post!"`;

  const curlGetAccounts = `curl -X GET "${API_BASE}/api/v1/accounts" \\
  -H "x-api-key: YOUR_API_KEY"`;

  const fields = [
    {
      name: "operation",
      type: "string",
      required: false,
      default: "upload_photos",
      description: "The type of content to upload.",
      options: ["upload_photos", "upload_video"],
      icon: Zap
    },
    {
      name: "user_identifier",
      type: "string",
      required: true,
      description: "Account identifier in format: \"name (linkedin)\"",
      example: "john_doe (linkedin)",
      icon: Hash
    },
    {
      name: "platforms",
      type: "string | array",
      required: true,
      description: "Platforms to post to. Accepts multiple formats for flexibility with n8n.",
      example: "[\"linkedin\"] or linkedin or linkedin,twitter",
      formats: [
        { format: "JSON array", example: '["linkedin", "twitter"]' },
        { format: "String JSON array", example: '\'["linkedin", "twitter"]\'' },
        { format: "Comma-separated", example: "linkedin,twitter" },
        { format: "Single value", example: "linkedin" }
      ],
      n8nTip: "In n8n HTTP Request, use: [\"linkedin\", \"twitter\"] or: linkedin,twitter",
      icon: Layers
    },
    {
      name: "account_ids",
      type: "string | array",
      required: false,
      description: "Account IDs to post to. Only \"account_ids\" or \"ACCOUNT_IDS\" accepted as field names — any other variant (account_id, id, social_account_id, etc.) returns a 400 error. ⚠️ Always send large numeric IDs as strings to avoid precision loss.",
      example: '["17841478425635377", "942626662258010"] or "17841478425635377,942626662258010"',
      formats: [
        { format: "JSON array of strings", example: '["id1", "id2"]' },
        { format: "String JSON array", example: '\'["id1", "id2"]\'' },
        { format: "Comma-separated string", example: '"id1,id2"' },
        { format: "Single string", example: '"17841478425635377"' }
      ],
      n8nTip: "Use either: [\"{{ $json.account1 }}\", \"{{ $json.account2 }}\"] or {{ $json.account1 }},{{ $json.account2 }}. Always use strings for IDs.",
      icon: Users
    },
    {
      name: "caption",
      type: "string",
      required: true,
      description: "The main text content of the post. Supports line breaks and emojis.",
      maxLength: 3000,
      icon: MessageSquare
    },
    {
      name: "media_urls",
      type: "string | array",
      required: false,
      description: "Image or video URL(s) to include. LinkedIn supports up to 9 images or 1 video per post.",
      example: "https://res.cloudinary.com/demo/image/upload/sample.jpg",
      n8nField: "Photos (Files or URLs)",
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
      name: "first_comment",
      type: "string",
      required: false,
      description: "Auto-posted first comment on the post. Great for hashtags or additional context.",
      maxLength: 1250,
      n8nField: "First Comment",
      icon: MessageSquare
    },
    {
      name: "linkedin_visibility",
      type: "string",
      required: false,
      default: "PUBLIC",
      description: "Controls who can see the post.",
      options: ["PUBLIC", "CONNECTIONS"],
      n8nField: "LinkedIn Visibility",
      icon: Eye
    },
    {
      name: "linkedin_feed_distribution",
      type: "string",
      required: false,
      default: "MAIN_FEED",
      description: "Controls how the post is distributed in feeds.",
      options: ["MAIN_FEED", "NONE"],
      n8nField: "LinkedIn Feed Distribution",
      icon: Users
    },
    {
      name: "linkedin_lifecycle_state",
      type: "string",
      required: false,
      default: "PUBLISHED",
      description: "The lifecycle state of the post.",
      options: ["PUBLISHED", "DRAFT"],
      n8nField: "LinkedIn Lifecycle State",
      icon: FileText
    },
    {
      name: "linkedin_allow_comments",
      type: "boolean",
      required: false,
      default: true,
      description: "Whether comments are allowed on the post.",
      n8nField: "LinkedIn Allow Comments",
      icon: MessageSquare
    },
    {
      name: "scheduled_date",
      type: "string",
      required: false,
      description: "ISO 8601 date/time for scheduling. If set, post will be scheduled instead of posted immediately.",
      example: "2026-01-15T14:00:00Z",
      n8nField: "Scheduled Date",
      icon: Calendar
    },
    {
      name: "timezone",
      type: "string",
      required: false,
      default: "UTC",
      description: "Timezone for the scheduled post.",
      example: "Europe/London, America/New_York",
      n8nField: "Timezone",
      icon: Globe
    }
  ];

  return (
    <div className="min-h-screen bg-background">
      <DocPageHeader
        isAuthenticated={!!user}
        title="LinkedIn API"
        subtitle="Complete guide to posting on LinkedIn via the Postora API"
        icon={Linkedin}
        variant="sky"
        headingPreset="sky-violet"
        ctaGradient="from-sky-500 via-blue-500 to-indigo-500"
        badges={[
          { label: "Image Posts", icon: Image },
          { label: "Video Posts", icon: Video },
          { label: "Text Posts", icon: FileText },
          { label: "Company Pages", icon: Building2 },
          { label: "Scheduling", icon: Calendar },
        ]}
      />

      <main className="container mx-auto px-6 py-12 max-w-5xl">

        {/* Quick Start */}
        <Card className="mb-8 border-primary/20 bg-primary/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-primary" />
              Quick Start
            </CardTitle>
            <CardDescription>Get your first LinkedIn post published in 3 minutes</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">1</div>
              <div>
                <p className="font-medium">Get your API Key</p>
                <p className="text-sm text-muted-foreground">Navigate to <Link to="/api-keys" className="text-primary hover:underline">Settings → API Keys</Link> to get your API key</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">2</div>
              <div>
                <p className="font-medium">Get your LinkedIn Account ID</p>
                <p className="text-sm text-muted-foreground">Run the accounts endpoint to find your LinkedIn profile name</p>
              </div>
            </div>
            <CodeBlock code={curlGetAccounts} language="bash" id="get-accounts" title="Get your accounts" />
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">3</div>
              <div>
                <p className="font-medium">Create your first post</p>
                <p className="text-sm text-muted-foreground">Use the post endpoint with your credentials</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Array Field Formats */}
        <Card className="mb-8 border-green-500/20 bg-green-500/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-green-500" />
              n8n Array Field Formats
            </CardTitle>
            <CardDescription>Multiple formats supported for platforms, account_ids, and media_urls fields</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 rounded-lg bg-background border">
                <h4 className="font-medium mb-2">JSON Array Format</h4>
                <code className="text-xs bg-muted px-2 py-1 rounded block mb-2">["linkedin", "twitter"]</code>
                <code className="text-xs bg-muted px-2 py-1 rounded block">["17841478425635377", "942626662258010"]</code>
              </div>
              <div className="p-4 rounded-lg bg-background border">
                <h4 className="font-medium mb-2">Comma-Separated Format</h4>
                <code className="text-xs bg-muted px-2 py-1 rounded block mb-2">linkedin,twitter</code>
                <code className="text-xs bg-muted px-2 py-1 rounded block">17841478425635377,942626662258010</code>
              </div>
            </div>
            <div className="mt-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <p className="text-sm flex items-start gap-2">
                <Zap className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
                <span><strong>n8n HTTP Request Tip:</strong> Both formats work in body fields. Use JSON array for multiple dynamic values or comma-separated for simple cases.</span>
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Important Notes */}
        <Card className="mb-8 border-amber-500/30 bg-amber-500/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-amber-500" />
              Important Notes
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-green-500 mt-0.5 flex-shrink-0" />
              <p className="text-sm"><strong>Image Format:</strong> LinkedIn supports JPEG, PNG, and GIF images. Max file size is 8MB per image.</p>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-green-500 mt-0.5 flex-shrink-0" />
              <p className="text-sm"><strong>Video Format:</strong> LinkedIn supports MP4 videos. Max file size is 5GB, max duration is 10 minutes.</p>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-green-500 mt-0.5 flex-shrink-0" />
              <p className="text-sm"><strong>Multiple Images:</strong> You can include up to 9 images in a single post (carousel style).</p>
            </div>
            <div className="flex items-start gap-2">
              <Info className="w-4 h-4 text-blue-500 mt-0.5 flex-shrink-0" />
              <p className="text-sm"><strong>Character Limit:</strong> LinkedIn posts support up to 3,000 characters.</p>
            </div>
            <div className="flex items-start gap-2">
              <Info className="w-4 h-4 text-blue-500 mt-0.5 flex-shrink-0" />
              <p className="text-sm"><strong>Hashtags:</strong> Use 3-5 relevant hashtags for better reach. Add them at the end of your post.</p>
            </div>
          </CardContent>
        </Card>

        {/* JSON Body Examples */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
            <FileText className="w-6 h-6" />
            JSON Body Examples
          </h2>
          <p className="text-muted-foreground mb-6">
            Send requests with Content-Type: application/json header
          </p>

          <Tabs defaultValue="basic" className="w-full">
            <TabsList className="grid w-full grid-cols-3 lg:grid-cols-6 mb-4">
              <TabsTrigger value="basic">Basic</TabsTrigger>
              <TabsTrigger value="all-fields">All Fields</TabsTrigger>
              <TabsTrigger value="video">Video</TabsTrigger>
              <TabsTrigger value="text">Text Only</TabsTrigger>
              <TabsTrigger value="multiple">Multiple Images</TabsTrigger>
              <TabsTrigger value="scheduled">Scheduled</TabsTrigger>
            </TabsList>
            <TabsContent value="basic">
              <CodeBlock code={curlJsonBasicPost} language="bash" id="json-basic" title="Basic image post" />
            </TabsContent>
            <TabsContent value="all-fields">
              <CodeBlock code={curlJsonWithAllFields} language="bash" id="json-all" title="Post with all fields" />
            </TabsContent>
            <TabsContent value="video">
              <CodeBlock code={curlJsonVideoPost} language="bash" id="json-video" title="Video post" />
            </TabsContent>
            <TabsContent value="text">
              <CodeBlock code={curlJsonTextOnly} language="bash" id="json-text" title="Text-only post" />
            </TabsContent>
            <TabsContent value="multiple">
              <CodeBlock code={curlJsonMultipleImages} language="bash" id="json-multiple" title="Multiple images" />
            </TabsContent>
            <TabsContent value="scheduled">
              <CodeBlock code={curlJsonScheduled} language="bash" id="json-scheduled" title="Scheduled post" />
            </TabsContent>
          </Tabs>
        </section>

        {/* Form-Data Examples */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
            <FileText className="w-6 h-6" />
            Form-Data Examples
          </h2>
          <p className="text-muted-foreground mb-6">
            Upload content directly using multipart/form-data
          </p>

          <Tabs defaultValue="basic-form" className="w-full">
            <TabsList className="grid w-full grid-cols-2 lg:grid-cols-4 mb-4">
              <TabsTrigger value="basic-form">Basic</TabsTrigger>
              <TabsTrigger value="file-form">File Upload</TabsTrigger>
              <TabsTrigger value="video-form">Video</TabsTrigger>
              <TabsTrigger value="all-form">All Fields</TabsTrigger>
            </TabsList>
            <TabsContent value="basic-form">
              <CodeBlock code={curlFormBasicPost} language="bash" id="form-basic" title="Basic post" />
            </TabsContent>
            <TabsContent value="file-form">
              <CodeBlock code={curlFormWithFile} language="bash" id="form-file" title="Direct file upload" />
            </TabsContent>
            <TabsContent value="video-form">
              <CodeBlock code={curlFormVideo} language="bash" id="form-video" title="Video upload" />
            </TabsContent>
            <TabsContent value="all-form">
              <CodeBlock code={curlFormAllFields} language="bash" id="form-all" title="All fields via form-data" />
            </TabsContent>
          </Tabs>
        </section>

        {/* API Fields Reference */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
            <Layers className="w-6 h-6" />
            API Fields Reference
          </h2>

          <div className="space-y-4">
            {fields.map((field) => (
              <Card key={field.name} className="overflow-hidden">
                <CardHeader className="py-4">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                        <field.icon className="w-4 h-4 text-primary" />
                      </div>
                      <div>
                        <code className="text-lg font-mono font-bold">{field.name}</code>
                        <div className="flex items-center gap-2 mt-1">
                          <Badge variant="outline" className="text-xs">{field.type}</Badge>
                          {field.required ? (
                            <Badge variant="destructive" className="text-xs">Required</Badge>
                          ) : (
                            <Badge variant="secondary" className="text-xs">Optional</Badge>
                          )}
                          {field.default !== undefined && (
                            <Badge variant="outline" className="text-xs bg-blue-500/10 text-blue-500 border-blue-500/30">
                              Default: {String(field.default)}
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0 pb-4">
                  <p className="text-sm text-muted-foreground mb-3">{field.description}</p>
                  
                  {field.options && (
                    <div className="mb-3">
                      <p className="text-xs font-medium text-muted-foreground mb-1">Options:</p>
                      <div className="flex flex-wrap gap-1">
                        {field.options.map((opt) => (
                          <code key={opt} className="text-xs bg-muted px-2 py-0.5 rounded">{opt}</code>
                        ))}
                      </div>
                    </div>
                  )}
                  
                  {field.example && (
                    <div className="mb-3">
                      <p className="text-xs font-medium text-muted-foreground mb-1">Example:</p>
                      <code className="text-xs bg-muted px-2 py-1 rounded block">{field.example}</code>
                    </div>
                  )}
                  
                  {field.maxLength && (
                    <p className="text-xs text-muted-foreground">Max length: {field.maxLength} characters</p>
                  )}
                  
                  {field.n8nField && (
                    <div className="mt-2 pt-2 border-t border-border">
                      <p className="text-xs text-muted-foreground">
                        <span className="font-medium">n8n Field:</span> {field.n8nField}
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* Response Examples */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
            <CheckCircle2 className="w-6 h-6" />
            Response Examples
          </h2>

          <Tabs defaultValue="success" className="w-full">
            <TabsList className="grid w-full grid-cols-3 mb-4">
              <TabsTrigger value="success">Success</TabsTrigger>
              <TabsTrigger value="scheduled">Scheduled</TabsTrigger>
              <TabsTrigger value="error">Error</TabsTrigger>
            </TabsList>
            <TabsContent value="success">
              <CodeBlock 
                code={`{
  "success": true,
  "message": "Post published successfully",
  "post_id": "abc123-def456-ghi789",
  "platform_results": {
    "linkedin": {
      "success": true,
      "post_id": "urn:li:share:7123456789012345678",
      "post_url": "https://www.linkedin.com/feed/update/urn:li:share:7123456789012345678",
      "status": "published"
    }
  }
}`} 
                language="json" 
                id="response-success" 
                title="Successful post response" 
              />
            </TabsContent>
            <TabsContent value="scheduled">
              <CodeBlock 
                code={`{
  "success": true,
  "message": "Post scheduled successfully",
  "post_id": "abc123-def456-ghi789",
  "scheduled_at": "2026-02-01T09:00:00Z",
  "platform_results": {
    "linkedin": {
      "success": true,
      "status": "scheduled",
      "scheduled_time": "2026-02-01T09:00:00Z"
    }
  }
}`} 
                language="json" 
                id="response-scheduled" 
                title="Scheduled post response" 
              />
            </TabsContent>
            <TabsContent value="error">
              <CodeBlock 
                code={`{
  "success": false,
  "error": "Upload failed",
  "message": "The image file is too large",
  "details": {
    "platform": "linkedin",
    "error_code": "IMAGE_TOO_LARGE",
    "max_size": "8MB",
    "provided_size": "12MB"
  }
}`} 
                language="json" 
                id="response-error" 
                title="Error response" 
              />
            </TabsContent>
          </Tabs>
        </section>

        {/* n8n Integration */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
            <Zap className="w-6 h-6" />
            n8n Integration
          </h2>
          
          <Card className="border-primary/20">
            <CardHeader>
              <CardTitle>HTTP Request Node Configuration</CardTitle>
              <CardDescription>Configure n8n to post to LinkedIn automatically</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4">
                <div className="grid grid-cols-3 gap-4 items-center">
                  <span className="text-sm font-medium">Method</span>
                  <code className="col-span-2 bg-muted px-3 py-1.5 rounded text-sm">POST</code>
                </div>
                <div className="grid grid-cols-3 gap-4 items-center">
                  <span className="text-sm font-medium">URL</span>
                  <code className="col-span-2 bg-muted px-3 py-1.5 rounded text-sm break-all">{API_BASE}/api/v1/post</code>
                </div>
                <div className="grid grid-cols-3 gap-4 items-center">
                  <span className="text-sm font-medium">Authentication</span>
                  <span className="col-span-2 text-sm text-muted-foreground">Header Auth: x-api-key = YOUR_API_KEY</span>
                </div>
                <div className="grid grid-cols-3 gap-4 items-center">
                  <span className="text-sm font-medium">Content-Type</span>
                  <code className="col-span-2 bg-muted px-3 py-1.5 rounded text-sm">application/json</code>
                </div>
              </div>
              
              <div className="pt-4">
                <Link to="/docs/n8n-integration" className="inline-flex items-center gap-2 text-primary hover:underline">
                  View complete n8n setup guide
                  <ExternalLink className="w-4 h-4" />
                </Link>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* Footer Navigation */}
        <div className="flex items-center justify-between pt-8 border-t border-border">
          <Link to="/docs/youtube-api" className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4" />
            YouTube API
          </Link>
          <Link to="/docs/twitter-api" className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
            Twitter/X API
            <ExternalLink className="w-4 h-4" />
          </Link>
        </div>
      </main>
    </div>
  );
}
