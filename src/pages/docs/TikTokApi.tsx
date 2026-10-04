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
  Eye, Users, Lock, Music, Shield, Megaphone
} from "lucide-react";
import { cn } from "@/lib/utils";

const API_BASE = "https://api.postora.cloud/functions/v1/n8n-api";

export default function TikTokApi() {
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
  const curlJsonBasicVideo = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_video",
    "user_identifier": "your_username (tiktok)",
    "platforms": ["tiktok"],
    "caption": "Check out this video! 🎵 #fyp #viral",
    "media_urls": "https://res.cloudinary.com/demo/video/upload/sample.mp4"
  }'`;

  const curlJsonWithAllFields = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_video",
    "user_identifier": "your_username (tiktok)",
    "platforms": ["tiktok"],
    "caption": "Amazing content coming your way! 🚀\\n\\n#fyp #viral #trending",
    "media_urls": "https://res.cloudinary.com/demo/video/upload/trending.mp4",
    "tiktok_privacy_level": "PUBLIC_TO_EVERYONE",
    "tiktok_disable_comment": false,
    "tiktok_disable_duet": false,
    "tiktok_disable_stitch": false,
    "tiktok_brand_content_toggle": false,
    "tiktok_brand_organic_toggle": false,
    "tiktok_video_cover_timestamp_ms": 1000
  }'`;

  const curlJsonPhotoPost = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_username (tiktok)",
    "platforms": ["tiktok"],
    "caption": "Photo carousel time! 📸 #photography #fyp",
    "media_urls": [
      "https://res.cloudinary.com/demo/image/upload/photo1.jpg",
      "https://res.cloudinary.com/demo/image/upload/photo2.jpg",
      "https://res.cloudinary.com/demo/image/upload/photo3.jpg"
    ],
    "tiktok_privacy_level": "PUBLIC_TO_EVERYONE"
  }'`;

  const curlJsonPrivateVideo = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_video",
    "user_identifier": "your_username (tiktok)",
    "platforms": ["tiktok"],
    "caption": "Private video for review",
    "media_urls": "https://res.cloudinary.com/demo/video/upload/private.mp4",
    "tiktok_privacy_level": "SELF_ONLY",
    "tiktok_disable_comment": true,
    "tiktok_disable_duet": true,
    "tiktok_disable_stitch": true
  }'`;

  const curlJsonBrandedContent = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_video",
    "user_identifier": "your_username (tiktok)",
    "platforms": ["tiktok"],
    "caption": "Partnered with @brand for this amazing product! 🎁 #ad #sponsored",
    "media_urls": "https://res.cloudinary.com/demo/video/upload/branded.mp4",
    "tiktok_privacy_level": "PUBLIC_TO_EVERYONE",
    "tiktok_brand_content_toggle": true,
    "tiktok_brand_organic_toggle": false
  }'`;

  const curlJsonScheduled = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_video",
    "user_identifier": "your_username (tiktok)",
    "platforms": ["tiktok"],
    "caption": "Scheduled to go viral! ⏰ #fyp #scheduled",
    "media_urls": "https://res.cloudinary.com/demo/video/upload/scheduled.mp4",
    "tiktok_privacy_level": "PUBLIC_TO_EVERYONE",
    "scheduled_date": "2026-02-01T18:00:00Z",
    "timezone": "America/New_York"
  }'`;

  // Form-Data Examples
  const curlFormBasicVideo = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "operation=upload_video" \\
  -F "user_identifier=your_username (tiktok)" \\
  -F "platforms=tiktok" \\
  -F "caption=Check out this video! 🎵 #fyp" \\
  -F "media_url=https://res.cloudinary.com/demo/video/upload/sample.mp4"`;

  const curlFormWithFile = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "operation=upload_video" \\
  -F "user_identifier=your_username (tiktok)" \\
  -F "platforms=tiktok" \\
  -F "caption=Direct upload! 📤 #fyp #viral" \\
  -F "file=@/path/to/video.mp4" \\
  -F "tiktok_privacy_level=PUBLIC_TO_EVERYONE"`;

  const curlFormPhotos = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "operation=upload_photos" \\
  -F "user_identifier=your_username (tiktok)" \\
  -F "platforms=tiktok" \\
  -F "caption=Photo carousel! 📸" \\
  -F "file=@/path/to/photo1.jpg" \\
  -F "file=@/path/to/photo2.jpg" \\
  -F "file=@/path/to/photo3.jpg"`;

  const curlFormAllFields = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "operation=upload_video" \\
  -F "user_identifier=your_username (tiktok)" \\
  -F "platforms=tiktok" \\
  -F "caption=Complete video with all settings! 🎬" \\
  -F "file=@/path/to/video.mp4" \\
  -F "tiktok_privacy_level=PUBLIC_TO_EVERYONE" \\
  -F "tiktok_disable_comment=false" \\
  -F "tiktok_disable_duet=false" \\
  -F "tiktok_disable_stitch=false" \\
  -F "tiktok_brand_content_toggle=false" \\
  -F "tiktok_video_cover_timestamp_ms=1000"`;

  const curlGetAccounts = `curl -X GET "${API_BASE}/api/v1/accounts" \\
  -H "x-api-key: YOUR_API_KEY"`;

  const fields = [
    {
      name: "operation",
      type: "string",
      required: false,
      default: "upload_video",
      description: "The type of content to upload.",
      options: ["upload_video", "upload_photos"],
      icon: Zap
    },
    {
      name: "user_identifier",
      type: "string",
      required: true,
      description: "Account identifier in format: \"username (tiktok)\"",
      example: "tiktoker123 (tiktok)",
      icon: Hash
    },
    {
      name: "platforms",
      type: "string | array",
      required: true,
      description: "Platforms to post to. Accepts multiple formats for flexibility with n8n.",
      example: "[\"tiktok\"] or tiktok or tiktok,instagram",
      formats: [
        { format: "JSON array", example: '["tiktok", "instagram"]' },
        { format: "String JSON array", example: '\'["tiktok", "instagram"]\'' },
        { format: "Comma-separated", example: "tiktok,instagram" },
        { format: "Single value", example: "tiktok" }
      ],
      n8nTip: "In n8n HTTP Request, use: [\"tiktok\", \"instagram\"] or: tiktok,instagram",
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
      required: false,
      description: "Main post caption (up to 4000 characters). This is the primary content that appears with your video. If no tiktok_title is provided, this caption will also be used as the title.",
      maxLength: 4000,
      icon: MessageSquare
    },
    {
      name: "media_urls",
      type: "string | array",
      required: false,
      description: "Video URL or array of image URLs (for photo carousels). TikTok supports 1 video or up to 35 images per post.",
      example: "https://res.cloudinary.com/demo/video/upload/sample.mp4",
      n8nField: "Video/Photos (Files or URLs)",
      icon: Video
    },
    {
      name: "media_base64",
      type: "string | array",
      required: false,
      description: "Base64 encoded media with data URI prefix. Alternative to media_urls for direct file upload without hosting. Supports multiple files as an array. In n8n, use Binary Data media source with comma-separated property names (e.g., data,data1,data2).",
      example: "data:video/mp4;base64,AAAAIGZ0eXBpc29t...",
      icon: Video
    },
    {
      name: "tiktok_title",
      type: "string",
      required: false,
      description: "Title override (up to 100 characters). If provided, this will be used as the video title instead of the caption. Leave empty to use the main caption as the title. Useful for creating a short, catchy title while keeping a longer detailed caption.",
      maxLength: 100,
      n8nField: "TikTok Title Override",
      icon: FileText
    },
    {
      name: "tiktok_privacy_level",
      type: "string",
      required: false,
      default: "PUBLIC_TO_EVERYONE",
      description: "Controls who can view the video. Note: Branded content is not available for private videos (SELF_ONLY).",
      options: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"],
      n8nField: "TikTok Privacy Level",
      icon: Lock
    },
    {
      name: "tiktok_disable_comment",
      type: "boolean",
      required: false,
      default: false,
      description: "Whether to disable comments on the video.",
      n8nField: "TikTok Disable Comment",
      icon: MessageSquare
    },
    {
      name: "tiktok_disable_duet",
      type: "boolean",
      required: false,
      default: false,
      description: "Whether to disable duets with this video.",
      n8nField: "TikTok Disable Duet",
      icon: Users
    },
    {
      name: "tiktok_disable_stitch",
      type: "boolean",
      required: false,
      default: false,
      description: "Whether to disable stitching with this video.",
      n8nField: "TikTok Disable Stitch",
      icon: Users
    },
    {
      name: "tiktok_brand_content_toggle",
      type: "boolean",
      required: false,
      default: false,
      description: "Set to true if video contains branded content/paid partnership. Not available for private videos (SELF_ONLY privacy level).",
      n8nField: "TikTok Brand Content Toggle",
      icon: Megaphone
    },
    {
      name: "tiktok_brand_organic_toggle",
      type: "boolean",
      required: false,
      default: false,
      description: "Set to true if video promotes your own brand/business.",
      n8nField: "TikTok Brand Organic Toggle",
      icon: Megaphone
    },
    {
      name: "tiktok_video_cover_timestamp_ms",
      type: "number",
      required: false,
      default: 0,
      description: "Timestamp in milliseconds for the video cover image.",
      example: "1000 (for 1 second mark)",
      n8nField: "TikTok Video Cover Timestamp (ms)",
      icon: Image
    },
    {
      name: "scheduled_date",
      type: "string",
      required: false,
      description: "ISO 8601 date/time for scheduling. If set, video will be scheduled instead of posted immediately.",
      example: "2026-01-15T14:00:00Z",
      n8nField: "Scheduled Date",
      icon: Calendar
    },
    {
      name: "timezone",
      type: "string",
      required: false,
      default: "UTC",
      description: "Timezone for the scheduled video.",
      example: "America/Los_Angeles, Europe/Paris",
      n8nField: "Timezone",
      icon: Globe
    }
  ];

  return (
    <div className="min-h-screen bg-background">
      <DocPageHeader
        isAuthenticated={!!user}
        title="TikTok API"
        subtitle="Complete guide to posting on TikTok via the Postora API"
        icon={Music}
        variant="rose"
        headingPreset="amber-rose-violet"
        ctaGradient="from-rose-500 via-fuchsia-500 to-cyan-500"
        badges={[
          { label: "Videos", icon: Video },
          { label: "Photo Carousels", icon: Image },
          { label: "Privacy Controls", icon: Lock },
          { label: "Branded Content", icon: Megaphone },
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
            <CardDescription>Get your first TikTok video posted in 3 minutes</CardDescription>
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
                <p className="font-medium">Get your TikTok Username</p>
                <p className="text-sm text-muted-foreground">Run the accounts endpoint to find your TikTok username</p>
              </div>
            </div>
            <CodeBlock code={curlGetAccounts} language="bash" id="get-accounts" title="Get your accounts" />
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">3</div>
              <div>
                <p className="font-medium">Upload your first video</p>
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
                <code className="text-xs bg-muted px-2 py-1 rounded block mb-2">["tiktok", "instagram"]</code>
                <code className="text-xs bg-muted px-2 py-1 rounded block">["17841478425635377", "942626662258010"]</code>
              </div>
              <div className="p-4 rounded-lg bg-background border">
                <h4 className="font-medium mb-2">Comma-Separated Format</h4>
                <code className="text-xs bg-muted px-2 py-1 rounded block mb-2">tiktok,instagram</code>
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
              <p className="text-sm"><strong>Video Format:</strong> TikTok supports MP4 and WebM. Recommended: H.264 codec, AAC audio.</p>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-green-500 mt-0.5 flex-shrink-0" />
              <p className="text-sm"><strong>Video Size:</strong> Max 4GB. Recommended dimensions: 1080x1920 (9:16 aspect ratio).</p>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-green-500 mt-0.5 flex-shrink-0" />
              <p className="text-sm"><strong>Video Duration:</strong> 3 seconds to 10 minutes. Optimal for FYP: 15-60 seconds.</p>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-green-500 mt-0.5 flex-shrink-0" />
              <p className="text-sm"><strong>Photo Carousel:</strong> Up to 35 images per post. Recommended: 1080x1920 pixels.</p>
            </div>
            <div className="flex items-start gap-2">
              <Info className="w-4 h-4 text-blue-500 mt-0.5 flex-shrink-0" />
              <p className="text-sm"><strong>Branded Content:</strong> Must disclose paid partnerships using brand_content_toggle.</p>
            </div>
            <div className="flex items-start gap-2">
              <Info className="w-4 h-4 text-blue-500 mt-0.5 flex-shrink-0" />
              <p className="text-sm"><strong>Music:</strong> TikTok API does not support adding music. Videos must include audio in the file.</p>
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
              <TabsTrigger value="photos">Photos</TabsTrigger>
              <TabsTrigger value="private">Private</TabsTrigger>
              <TabsTrigger value="branded">Branded</TabsTrigger>
              <TabsTrigger value="scheduled">Scheduled</TabsTrigger>
            </TabsList>
            <TabsContent value="basic">
              <CodeBlock code={curlJsonBasicVideo} language="bash" id="json-basic" title="Basic video upload" />
            </TabsContent>
            <TabsContent value="all-fields">
              <CodeBlock code={curlJsonWithAllFields} language="bash" id="json-all" title="Video with all fields" />
            </TabsContent>
            <TabsContent value="photos">
              <CodeBlock code={curlJsonPhotoPost} language="bash" id="json-photos" title="Photo carousel" />
            </TabsContent>
            <TabsContent value="private">
              <CodeBlock code={curlJsonPrivateVideo} language="bash" id="json-private" title="Private video" />
            </TabsContent>
            <TabsContent value="branded">
              <CodeBlock code={curlJsonBrandedContent} language="bash" id="json-branded" title="Branded content" />
            </TabsContent>
            <TabsContent value="scheduled">
              <CodeBlock code={curlJsonScheduled} language="bash" id="json-scheduled" title="Scheduled video" />
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
              <TabsTrigger value="photos-form">Photos</TabsTrigger>
              <TabsTrigger value="all-form">All Fields</TabsTrigger>
            </TabsList>
            <TabsContent value="basic-form">
              <CodeBlock code={curlFormBasicVideo} language="bash" id="form-basic" title="Basic video" />
            </TabsContent>
            <TabsContent value="file-form">
              <CodeBlock code={curlFormWithFile} language="bash" id="form-file" title="Direct file upload" />
            </TabsContent>
            <TabsContent value="photos-form">
              <CodeBlock code={curlFormPhotos} language="bash" id="form-photos" title="Photo carousel" />
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

        {/* Privacy Levels Explained */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
            <Lock className="w-6 h-6" />
            Privacy Levels Explained
          </h2>
          <Card>
            <CardContent className="pt-6">
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <Badge className="bg-green-500/20 text-green-500 border-green-500/30">PUBLIC_TO_EVERYONE</Badge>
                  <p className="text-sm text-muted-foreground">Everyone can view the video (recommended for maximum reach)</p>
                </div>
                <div className="flex items-start gap-3">
                  <Badge className="bg-blue-500/20 text-blue-500 border-blue-500/30">MUTUAL_FOLLOW_FRIENDS</Badge>
                  <p className="text-sm text-muted-foreground">Only mutual followers can view the video</p>
                </div>
                <div className="flex items-start gap-3">
                  <Badge className="bg-muted text-foreground border-border">FOLLOWER_OF_CREATOR</Badge>
                  <p className="text-sm text-muted-foreground">Only your followers can view the video</p>
                </div>
                <div className="flex items-start gap-3">
                  <Badge className="bg-gray-500/20 text-gray-500 border-gray-500/30">SELF_ONLY</Badge>
                  <p className="text-sm text-muted-foreground">Only you can view the video (private)</p>
                </div>
              </div>
            </CardContent>
          </Card>
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
  "message": "Video uploaded successfully",
  "post_id": "abc123-def456-ghi789",
  "platform_results": {
    "tiktok": {
      "success": true,
      "publish_id": "7123456789012345678",
      "status": "published"
    }
  }
}`} 
                language="json" 
                id="response-success" 
                title="Successful upload response" 
              />
            </TabsContent>
            <TabsContent value="scheduled">
              <CodeBlock 
                code={`{
  "success": true,
  "message": "Video scheduled successfully",
  "post_id": "abc123-def456-ghi789",
  "scheduled_at": "2026-02-01T18:00:00Z",
  "platform_results": {
    "tiktok": {
      "success": true,
      "status": "scheduled",
      "scheduled_time": "2026-02-01T18:00:00Z"
    }
  }
}`} 
                language="json" 
                id="response-scheduled" 
                title="Scheduled video response" 
              />
            </TabsContent>
            <TabsContent value="error">
              <CodeBlock 
                code={`{
  "success": false,
  "error": "Upload failed",
  "message": "Video duration exceeds maximum allowed",
  "details": {
    "platform": "tiktok",
    "error_code": "VIDEO_DURATION_ERROR",
    "max_duration": "600 seconds",
    "provided_duration": "720 seconds"
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
              <CardDescription>Configure n8n to post TikTok videos automatically</CardDescription>
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
          <Link to="/docs/twitter-api" className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4" />
            Twitter/X API
          </Link>
          <Link to="/docs/n8n-integration" className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
            n8n Integration
            <ExternalLink className="w-4 h-4" />
          </Link>
        </div>
      </main>
    </div>
  );
}
