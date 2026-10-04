import { Link } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/useAuth";
import { useCopyToClipboard } from "@/hooks/shared";
import {
  ArrowLeft, Copy, Check, ExternalLink, Instagram, Image, Video,
  MessageSquare, Users, MapPin, Clock, Hash, FileText, AlertCircle,
  CheckCircle2, Info, Calendar, Globe, Zap
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DocPageHeader } from "@/components/docs";

const API_BASE = "https://api.postora.cloud/functions/v1/n8n-api";

export default function InstagramApi() {
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

  // Curl examples
  const curlBasicPost = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_username (instagram)",
    "platforms": ["instagram"],
    "title": "Check out this amazing photo! 📸",
    "media_urls": "https://example.com/image.jpg",
    "instagram_media_type": "feed"
  }'`;

  const curlWithAllFields = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_username (instagram)",
    "platforms": ["instagram"],
    "title": "Amazing sunset at the beach! 🌅",
    "media_urls": "https://example.com/sunset.jpg",
    "instagram_media_type": "feed",
    "instagram_alt_text": "A beautiful orange sunset over the ocean with silhouettes of palm trees",
    "instagram_first_comment": "#sunset #beach #photography #nature #travel #beautiful",
    "instagram_collaborators": ["photographer_friend", "travel_buddy"],
    "instagram_user_tags": ["beach_resort", "travel_agency"],
    "instagram_location_id": "123456789"
  }'`;

  const curlMultipleImages = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_username (instagram)",
    "platforms": ["instagram"],
    "title": "Our amazing trip to Paris! 🗼✨",
    "media_urls": [
      "https://example.com/paris1.jpg",
      "https://example.com/paris2.jpg",
      "https://example.com/paris3.jpg"
    ],
    "instagram_media_type": "feed",
    "instagram_alt_text": "Carousel of Paris trip photos",
    "instagram_first_comment": "#paris #france #travel #eiffeltower #vacation"
  }'`;

  const curlBase64Image = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_username (instagram)",
    "platforms": ["instagram"],
    "title": "Created with AI! 🎨",
    "media_base64": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAA...",
    "instagram_media_type": "feed",
    "instagram_alt_text": "AI generated artwork"
  }'`;

  const curlStories = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_username (instagram)",
    "platforms": ["instagram"],
    "media_urls": "https://example.com/story-image.jpg",
    "instagram_media_type": "stories"
  }'`;

  const curlVideo = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_video",
    "user_identifier": "your_username (instagram)",
    "platforms": ["instagram"],
    "title": "Behind the scenes video! 🎬",
    "media_urls": "https://example.com/video.mp4",
    "instagram_media_type": "feed",
    "instagram_alt_text": "Behind the scenes footage of our photoshoot",
    "instagram_first_comment": "#behindthescenes #bts #video #reels"
  }'`;

  const curlScheduled = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_username (instagram)",
    "platforms": ["instagram"],
    "title": "Scheduled post coming soon! ⏰",
    "media_urls": "https://example.com/image.jpg",
    "scheduled_date": "2026-01-15T14:00:00Z",
    "timezone": "Europe/Madrid",
    "instagram_media_type": "feed",
    "instagram_first_comment": "#scheduled #automation #socialmedia"
  }'`;

  const curlTextOnly = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_text",
    "user_identifier": "your_username (instagram)",
    "platforms": ["instagram"],
    "title": "Good morning everyone! ☀️ Starting the day with positive vibes. What are your goals for today?"
  }'`;

  const curlGetAccounts = `curl -X GET "${API_BASE}/api/v1/accounts" \\
  -H "x-api-key: YOUR_API_KEY"`;

  const fields = [
    {
      name: "operation",
      type: "string",
      required: false,
      default: "upload_photos",
      description: "The type of content to upload",
      options: ["upload_photos", "upload_video", "upload_text", "upload_document"],
      icon: Zap
    },
    {
      name: "user_identifier",
      type: "string",
      required: true,
      description: "Account identifier in format: \"username (platform)\"",
      example: "mturpo (instagram)",
      icon: Users
    },
    {
      name: "platforms",
      type: "string | array",
      required: true,
      description: "Platforms to post to. Accepts multiple formats for flexibility with n8n.",
      example: "[\"instagram\"] or instagram or instagram,facebook",
      formats: [
        { format: "JSON array", example: '["instagram", "facebook"]' },
        { format: "String JSON array", example: '\'["instagram", "facebook"]\'' },
        { format: "Comma-separated", example: "instagram,facebook" },
        { format: "Single value", example: "instagram" }
      ],
      n8nTip: "In n8n HTTP Request body fields, use: [\"instagram\", \"facebook\"] or just: instagram,facebook",
      icon: Instagram
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
      n8nTip: "In n8n, use either format: [\"{{ $json.account1 }}\", \"{{ $json.account2 }}\"] or {{ $json.account1 }},{{ $json.account2 }}. Always use strings for IDs.",
      icon: Users
    },
    {
      name: "title",
      type: "string",
      required: false,
      description: "The main caption text for your Instagram post. Also acts as fallback for caption field.",
      maxLength: 2200,
      icon: FileText
    },
    {
      name: "media_urls",
      type: "string | array",
      required: false,
      description: "Single URL or array of URLs for images/videos. Supports up to 10 images for carousel. Accepts multiple formats: JSON array, stringified JSON array, comma-separated URLs, or single URL.",
      example: "[\"url1\", \"url2\"] or '{\"url1\", \"url2\"}' or url1,url2 or url1",
      formats: [
        { format: "JSON array", example: "[\"url1\", \"url2\"]" },
        { format: "String JSON array", example: "'[\"url1\", \"url2\"]'" },
        { format: "Comma-separated", example: "url1,url2" },
        { format: "Single URL", example: "https://example.com/image.jpg" }
      ],
      n8nTip: "In n8n, use: [\"{{ $json['Image1'][0].url }}\", \"{{ $json['Image2'][0].url }}\"] or {{ $json['Image1'][0].url }},{{ $json['Image2'][0].url }}",
      icon: Image
    },
    {
      name: "media_base64",
      type: "string | array",
      required: false,
      description: "Base64 encoded media data. Format: data:mime/type;base64,DATA",
      example: "data:image/jpeg;base64,/9j/4AAQ...",
      icon: Image
    },
    {
      name: "instagram_media_type",
      type: "string",
      required: false,
      default: "feed",
      description: "Where to post the content",
      options: ["feed", "stories"],
      icon: Instagram
    },
    {
      name: "instagram_alt_text",
      type: "string",
      required: false,
      description: "Extended alt text for accessibility. Describes the image for visually impaired users.",
      maxLength: 420,
      icon: FileText
    },
    {
      name: "instagram_first_comment",
      type: "string",
      required: false,
      description: "Auto-posted first comment. Perfect for hashtags to keep caption clean.",
      maxLength: 2200,
      icon: MessageSquare
    },
    {
      name: "instagram_collaborators",
      type: "array",
      required: false,
      description: "Array of Instagram usernames to invite as collaborators on the post.",
      example: "[\"username1\", \"username2\"]",
      icon: Users
    },
    {
      name: "instagram_user_tags",
      type: "array",
      required: false,
      description: "Array of Instagram usernames to tag in the post.",
      example: "[\"tagged_user1\", \"tagged_user2\"]",
      icon: Hash
    },
    {
      name: "instagram_location_id",
      type: "string",
      required: false,
      description: "Facebook Location ID to tag the post with a location.",
      example: "123456789",
      icon: MapPin
    },
    {
      name: "instagram_title",
      type: "string",
      required: false,
      description: "Override title specifically for Instagram (if different from main title).",
      icon: FileText
    },
    {
      name: "scheduled_date",
      type: "string",
      required: false,
      description: "ISO 8601 date/time for scheduling. If set, post will be scheduled instead of posted immediately.",
      example: "2026-01-15T14:00:00Z",
      icon: Calendar
    },
    {
      name: "timezone",
      type: "string",
      required: false,
      default: "UTC",
      description: "Timezone for the scheduled post.",
      example: "Europe/Madrid, America/New_York",
      icon: Globe
    }
  ];

  return (
    <div className="min-h-screen bg-background">
      <DocPageHeader
        isAuthenticated={!!user}
        title="Instagram API"
        subtitle="Complete guide to posting on Instagram via n8n API"
        icon={Instagram}
        variant="rose"
        headingPreset="amber-rose-violet"
        ctaGradient="from-amber-500 via-rose-500 to-fuchsia-500"
        badges={[
          { label: "Photos", icon: Image },
          { label: "Videos", icon: Video },
          { label: "Carousels", icon: Image },
          { label: "Stories", icon: Clock },
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
            <CardDescription>Get your first post published in 2 minutes</CardDescription>
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
                <p className="font-medium">Get your Account Identifier</p>
                <p className="text-sm text-muted-foreground">Run the accounts endpoint to find your Instagram username</p>
              </div>
            </div>
            <CodeBlock code={curlGetAccounts} language="bash" id="get-accounts" title="Get your accounts" />
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">3</div>
              <div>
                <p className="font-medium">Post to Instagram</p>
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
                <code className="text-xs bg-muted px-2 py-1 rounded block mb-2">["instagram", "facebook"]</code>
                <code className="text-xs bg-muted px-2 py-1 rounded block">["17841478425635377", "942626662258010"]</code>
              </div>
              <div className="p-4 rounded-lg bg-background border">
                <h4 className="font-medium mb-2">Comma-Separated Format</h4>
                <code className="text-xs bg-muted px-2 py-1 rounded block mb-2">instagram,facebook</code>
                <code className="text-xs bg-muted px-2 py-1 rounded block">17841478425635377,942626662258010</code>
              </div>
            </div>
            <div className="mt-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <p className="text-sm flex items-start gap-2">
                <Zap className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
                <span><strong>n8n HTTP Request Tip:</strong> Both formats work in body fields. Use JSON array for multiple dynamic values: <code className="text-xs bg-muted px-1 rounded">["{`{{ $json.platform1 }}`}", "{`{{ $json.platform2 }}`}"]</code> or comma-separated for simple cases: <code className="text-xs bg-muted px-1 rounded">{`{{ $json.platform1 }},{{ $json.platform2 }}`}</code></span>
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Curl Examples */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-6">Curl Examples</h2>
          
          <Tabs defaultValue="basic" className="w-full">
            <TabsList className="grid w-full grid-cols-4 lg:grid-cols-8 h-auto gap-1">
              <TabsTrigger value="basic" className="text-xs">Basic</TabsTrigger>
              <TabsTrigger value="full" className="text-xs">All Fields</TabsTrigger>
              <TabsTrigger value="carousel" className="text-xs">Carousel</TabsTrigger>
              <TabsTrigger value="base64" className="text-xs">Base64</TabsTrigger>
              <TabsTrigger value="stories" className="text-xs">Stories</TabsTrigger>
              <TabsTrigger value="video" className="text-xs">Video</TabsTrigger>
              <TabsTrigger value="scheduled" className="text-xs">Scheduled</TabsTrigger>
              <TabsTrigger value="text" className="text-xs">Text Only</TabsTrigger>
            </TabsList>

            <TabsContent value="basic" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Image className="w-5 h-5" />
                    Basic Photo Post
                  </CardTitle>
                  <CardDescription>Simple post with a single image URL</CardDescription>
                </CardHeader>
                <CardContent>
                  <CodeBlock code={curlBasicPost} language="bash" id="basic-post" />
                  <div className="mt-4 p-4 rounded-lg bg-muted/50">
                    <h4 className="font-medium mb-2 flex items-center gap-2">
                      <Info className="w-4 h-4 text-blue-500" />
                      What this does:
                    </h4>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      <li>• Downloads the image from the provided URL</li>
                      <li>• Uploads it to Instagram Feed</li>
                      <li>• Posts with the caption from the title field</li>
                    </ul>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="full" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <CheckCircle2 className="w-5 h-5 text-green-500" />
                    Complete Post with All Fields
                  </CardTitle>
                  <CardDescription>Using all available Instagram-specific options</CardDescription>
                </CardHeader>
                <CardContent>
                  <CodeBlock code={curlWithAllFields} language="bash" id="full-post" />
                  <div className="mt-4 p-4 rounded-lg bg-muted/50">
                    <h4 className="font-medium mb-2 flex items-center gap-2">
                      <Info className="w-4 h-4 text-blue-500" />
                      Features used:
                    </h4>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      <li>• <strong>instagram_alt_text:</strong> Accessibility text for visually impaired users</li>
                      <li>• <strong>instagram_first_comment:</strong> Auto-posts hashtags as first comment</li>
                      <li>• <strong>instagram_collaborators:</strong> Invites users as post collaborators</li>
                      <li>• <strong>instagram_user_tags:</strong> Tags users in the post</li>
                      <li>• <strong>instagram_location_id:</strong> Adds location to the post</li>
                    </ul>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="carousel" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Image className="w-5 h-5" />
                    Carousel Post (Multiple Images)
                  </CardTitle>
                  <CardDescription>Post up to 10 images in a single carousel</CardDescription>
                </CardHeader>
                <CardContent>
                  <CodeBlock code={curlMultipleImages} language="bash" id="carousel-post" />
                  <div className="mt-4 p-4 rounded-lg bg-amber-500/10 border border-amber-500/20">
                    <h4 className="font-medium mb-2 flex items-center gap-2 text-amber-600">
                      <AlertCircle className="w-4 h-4" />
                      Important Notes:
                    </h4>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      <li>• Maximum 10 images per carousel</li>
                      <li>• All images should have similar aspect ratios for best results</li>
                      <li>• Supported formats: JPEG, PNG, GIF, WebP</li>
                      <li>• Maximum file size: 20MB per image</li>
                    </ul>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="base64" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <FileText className="w-5 h-5" />
                    Base64 Encoded Image
                  </CardTitle>
                  <CardDescription>Upload images directly as base64 data</CardDescription>
                </CardHeader>
                <CardContent>
                  <CodeBlock code={curlBase64Image} language="bash" id="base64-post" />
                  <div className="mt-4 p-4 rounded-lg bg-muted/50">
                    <h4 className="font-medium mb-2 flex items-center gap-2">
                      <Info className="w-4 h-4 text-blue-500" />
                      Base64 Format:
                    </h4>
                    <p className="text-sm text-muted-foreground">
                      The base64 string must include the data URL prefix:<br />
                      <code className="text-xs bg-muted px-2 py-1 rounded">data:image/jpeg;base64,/9j/4AAQ...</code>
                    </p>
                    <p className="text-sm text-muted-foreground mt-2">
                      Supported MIME types: image/jpeg, image/png, image/gif, image/webp
                    </p>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="stories" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Clock className="w-5 h-5 text-foreground" />
                    Instagram Stories
                  </CardTitle>
                  <CardDescription>Post to Instagram Stories instead of Feed</CardDescription>
                </CardHeader>
                <CardContent>
                  <CodeBlock code={curlStories} language="bash" id="stories-post" />
                  <div className="mt-4 p-4 rounded-lg bg-muted border border-border">
                    <h4 className="font-medium mb-2 flex items-center gap-2 text-foreground">
                      <Info className="w-4 h-4" />
                      Stories Notes:
                    </h4>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      <li>• Stories disappear after 24 hours</li>
                      <li>• Recommended aspect ratio: 9:16 (1080x1920)</li>
                      <li>• Title/caption is not shown on stories</li>
                      <li>• Videos should be 15 seconds or less for stories</li>
                    </ul>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="video" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Video className="w-5 h-5 text-red-500" />
                    Video Post / Reels
                  </CardTitle>
                  <CardDescription>Upload videos to Instagram Feed or Reels</CardDescription>
                </CardHeader>
                <CardContent>
                  <CodeBlock code={curlVideo} language="bash" id="video-post" />
                  <div className="mt-4 p-4 rounded-lg bg-muted/50">
                    <h4 className="font-medium mb-2 flex items-center gap-2">
                      <Info className="w-4 h-4 text-blue-500" />
                      Video Requirements:
                    </h4>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      <li>• Supported formats: MP4, MOV, WebM</li>
                      <li>• Maximum file size: 500MB</li>
                      <li>• Maximum duration: 60 minutes (Feed), 90 seconds (Reels)</li>
                      <li>• Recommended resolution: 1080x1920 (9:16) for Reels</li>
                    </ul>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="scheduled" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Calendar className="w-5 h-5 text-blue-500" />
                    Scheduled Post
                  </CardTitle>
                  <CardDescription>Schedule posts for future publication</CardDescription>
                </CardHeader>
                <CardContent>
                  <CodeBlock code={curlScheduled} language="bash" id="scheduled-post" />
                  <div className="mt-4 p-4 rounded-lg bg-blue-500/10 border border-blue-500/20">
                    <h4 className="font-medium mb-2 flex items-center gap-2 text-blue-600">
                      <Clock className="w-4 h-4" />
                      Scheduling Details:
                    </h4>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      <li>• Use ISO 8601 format: <code className="text-xs bg-muted px-1 rounded">2026-01-15T14:00:00Z</code></li>
                      <li>• Specify timezone with the <code className="text-xs bg-muted px-1 rounded">timezone</code> field</li>
                      <li>• Common timezones: UTC, Europe/Madrid, America/New_York, Asia/Tokyo</li>
                      <li>• Posts are processed every minute by our scheduler</li>
                    </ul>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="text" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <MessageSquare className="w-5 h-5" />
                    Text Only Post
                  </CardTitle>
                  <CardDescription>Post text without media (limited support)</CardDescription>
                </CardHeader>
                <CardContent>
                  <CodeBlock code={curlTextOnly} language="bash" id="text-post" />
                  <div className="mt-4 p-4 rounded-lg bg-amber-500/10 border border-amber-500/20">
                    <h4 className="font-medium mb-2 flex items-center gap-2 text-amber-600">
                      <AlertCircle className="w-4 h-4" />
                      Note:
                    </h4>
                    <p className="text-sm text-muted-foreground">
                      Instagram does not support text-only posts natively. This will create a text post 
                      which may need to be converted to an image or used with other platforms that support text posts.
                    </p>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </section>

        {/* Field Reference */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-6">Field Reference</h2>
          
          <div className="space-y-4">
            {fields.map((field) => (
              <Card key={field.name} className="overflow-hidden">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                        <field.icon className="w-4 h-4 text-primary" />
                      </div>
                      <div>
                        <CardTitle className="text-base font-mono">{field.name}</CardTitle>
                        <div className="flex items-center gap-2 mt-1">
                          <Badge variant="outline" className="text-xs">{field.type}</Badge>
                          {field.required ? (
                            <Badge variant="destructive" className="text-xs">Required</Badge>
                          ) : (
                            <Badge variant="secondary" className="text-xs">Optional</Badge>
                          )}
                          {field.default && (
                            <Badge variant="outline" className="text-xs">Default: {field.default}</Badge>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <p className="text-sm text-muted-foreground mb-2">{field.description}</p>
                  
                  {field.options && (
                    <div className="mt-2">
                      <span className="text-xs text-muted-foreground">Options: </span>
                      {field.options.map((opt, i) => (
                        <code key={opt} className="text-xs bg-muted px-1.5 py-0.5 rounded mx-0.5">
                          {opt}
                        </code>
                      ))}
                    </div>
                  )}
                  
                  {field.formats && (
                    <div className="mt-3 p-3 rounded-lg bg-muted/50 border border-border">
                      <span className="text-xs font-medium text-foreground block mb-2">Supported Formats:</span>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {field.formats.map((f: { format: string; example: string }) => (
                          <div key={f.format} className="flex items-center gap-2">
                            <CheckCircle2 className="w-3 h-3 text-green-500 flex-shrink-0" />
                            <span className="text-xs text-muted-foreground">{f.format}:</span>
                            <code className="text-xs bg-background px-1.5 py-0.5 rounded border">{f.example}</code>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  
                  {field.n8nTip && (
                    <div className="mt-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                      <span className="text-xs font-medium text-amber-600 flex items-center gap-1 mb-1">
                        <Zap className="w-3 h-3" /> n8n Tip:
                      </span>
                      <code className="text-xs text-muted-foreground block break-all">{field.n8nTip}</code>
                    </div>
                  )}
                  
                  {field.example && !field.formats && (
                    <div className="mt-2">
                      <span className="text-xs text-muted-foreground">Example: </span>
                      <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{field.example}</code>
                    </div>
                  )}
                  
                  {field.maxLength && (
                    <div className="mt-2">
                      <span className="text-xs text-muted-foreground">Max length: </span>
                      <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{field.maxLength} characters</code>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* Response Examples */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-6">Response Examples</h2>
          
          <Tabs defaultValue="success">
            <TabsList>
              <TabsTrigger value="success">Success</TabsTrigger>
              <TabsTrigger value="error">Error</TabsTrigger>
            </TabsList>

            <TabsContent value="success" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-green-500">
                    <CheckCircle2 className="w-5 h-5" />
                    Successful Response (201)
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <CodeBlock 
                    code={`{
  "success": true,
  "post": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "user_id": "user-uuid",
    "caption": "Amazing sunset at the beach! 🌅",
    "platforms": ["instagram"],
    "media_file_ids": ["media-uuid-1"],
    "status": "pending",
    "created_at": "2026-01-10T12:00:00Z"
  },
  "metadata_applied": {
    "instagram": {
      "mediaType": "feed",
      "collaborators": ["photographer_friend"],
      "userTags": ["beach_resort"],
      "locationId": "123456789",
      "altText": "A beautiful orange sunset...",
      "firstComment": "#sunset #beach..."
    }
  },
  "account_ids_used": ["account-uuid-1"]
}`}
                    language="json"
                    id="success-response"
                  />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="error" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-red-500">
                    <AlertCircle className="w-5 h-5" />
                    Error Response (400/401/500)
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <CodeBlock 
                    code={`// 401 Unauthorized
{
  "error": "Invalid API key"
}

// 400 Bad Request
{
  "error": "platforms array is required"
}

// 400 Bad Request - Account not found
{
  "error": "No valid account IDs found. You can use: internal UUID, platform_user_id, or user_identifier (e.g., \\"username (instagram)\\"). Use GET /api/v1/accounts to see your available accounts.",
  "provided_ids": ["invalid_id"]
}

// 400 Bad Request - Media failed
{
  "error": "Failed to upload media from URLs",
  "details": ["https://example.com/broken.jpg: Failed to download"]
}`}
                    language="json"
                    id="error-response"
                  />
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </section>

        {/* Best Practices */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-6">Best Practices</h2>
          
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Hash className="w-4 h-4 text-blue-500" />
                  Use First Comment for Hashtags
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Keep your caption clean by putting hashtags in the <code className="text-xs bg-muted px-1 rounded">instagram_first_comment</code> field. 
                  This auto-posts them as the first comment.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <FileText className="w-4 h-4 text-green-500" />
                  Always Add Alt Text
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Use <code className="text-xs bg-muted px-1 rounded">instagram_alt_text</code> to describe your images. 
                  This improves accessibility and can help with Instagram search rankings.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Clock className="w-4 h-4 text-foreground" />
                  Schedule for Optimal Times
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Use the scheduling feature to post when your audience is most active. 
                  Always specify your timezone to ensure accurate scheduling.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Image className="w-4 h-4 text-orange-500" />
                  Optimize Image Sizes
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Instagram recommends 1080x1080 (1:1) for feed posts and 1080x1920 (9:16) for stories and reels. 
                  Max file size is 20MB for images.
                </p>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* Related Links */}
        <section>
          <h2 className="text-2xl font-bold mb-6">Related Documentation</h2>
          
          <div className="flex flex-wrap gap-4">
            <Link to="/n8n">
              <Button variant="outline" className="gap-2">
                <ArrowLeft className="w-4 h-4" />
                n8n Integration Guide
              </Button>
            </Link>
            <Link to="/api-keys">
              <Button variant="outline" className="gap-2">
                Get API Key
                <ExternalLink className="w-4 h-4" />
              </Button>
            </Link>
            <Link to="/profiles">
              <Button variant="outline" className="gap-2">
                Connect Instagram Account
                <ExternalLink className="w-4 h-4" />
              </Button>
            </Link>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-border mt-16">
        <div className="container mx-auto px-6 py-8">
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <p>© 2026 Postora. A product developed and operated by WALEED PROLIFE LLC. All rights reserved.</p>
            <div className="flex items-center gap-4">
              <Link to="/docs" className="hover:text-foreground">Documentation</Link>
              <Link to="/n8n" className="hover:text-foreground">n8n Integration</Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
