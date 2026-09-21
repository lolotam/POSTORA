import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/useAuth";
import { useCopyToClipboard } from "@/hooks/shared";
import {
  ArrowLeft, Copy, Check, ExternalLink, Facebook, Image, Video,
  MessageSquare, Users, MapPin, Clock, Hash, FileText, AlertCircle,
  CheckCircle2, Info, Calendar, Globe, Zap, Film, BookOpen
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DocPageHeader } from "@/components/docs";

const API_BASE = "https://api.postora.cloud/functions/v1/n8n-api";

export default function FacebookApi() {
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
    "user_identifier": "your_page_name (facebook)",
    "platforms": ["facebook"],
    "title": "Exciting news from our team! 🎉",
    "media_urls": "https://example.com/image.jpg"
  }'`;

  const curlWithAllFields = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_page_name (facebook)",
    "platforms": ["facebook"],
    "title": "Check out our latest product launch! 🚀",
    "media_urls": "https://example.com/product.jpg",
    "facebook_page_id": "123456789",
    "alt_text": "New product showcase image",
    "first_comment": "Link in bio! #newproduct #launch"
  }'`;

  const curlMultipleImages = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_page_name (facebook)",
    "platforms": ["facebook"],
    "title": "Behind the scenes of our latest photoshoot! 📸",
    "media_urls": [
      "https://example.com/bts1.jpg",
      "https://example.com/bts2.jpg",
      "https://example.com/bts3.jpg",
      "https://example.com/bts4.jpg"
    ],
    "alt_text": "Behind the scenes photo collection"
  }'`;

  const curlBase64Image = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_page_name (facebook)",
    "platforms": ["facebook"],
    "title": "AI-generated artwork for today! 🎨",
    "media_base64": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAA...",
    "alt_text": "AI generated digital art"
  }'`;

  const curlReels = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_video",
    "user_identifier": "your_page_name (facebook)",
    "platforms": ["facebook"],
    "title": "Quick tips for productivity! 💡",
    "media_urls": "https://example.com/reel-video.mp4",
    "facebook_media_type": "REELS"
  }'`;

  const curlStories = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_page_name (facebook)",
    "platforms": ["facebook"],
    "media_urls": "https://example.com/story-image.jpg",
    "facebook_media_type": "STORIES"
  }'`;

  const curlVideo = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_video",
    "user_identifier": "your_page_name (facebook)",
    "platforms": ["facebook"],
    "title": "Full tutorial: How to use our product 🎬",
    "media_urls": "https://example.com/tutorial.mp4",
    "alt_text": "Product tutorial video walkthrough"
  }'`;

  const curlScheduled = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_page_name (facebook)",
    "platforms": ["facebook"],
    "title": "Coming tomorrow! Stay tuned 🔔",
    "media_urls": "https://example.com/teaser.jpg",
    "scheduled_date": "2026-01-15T09:00:00Z",
    "timezone": "America/New_York"
  }'`;

  const curlTextOnly = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_text",
    "user_identifier": "your_page_name (facebook)",
    "platforms": ["facebook"],
    "title": "Happy Monday everyone! 🌟 What are you working on this week? Drop a comment below and let us know!"
  }'`;

  const curlGetAccounts = `curl -X GET "${API_BASE}/api/v1/accounts" \\
  -H "x-api-key: YOUR_API_KEY"`;

  const curlCrossPost = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "platforms": ["facebook", "instagram"],
    "account_ids": ["facebook-account-uuid", "instagram-account-uuid"],
    "title": "Cross-posting to Facebook and Instagram! 🎯",
    "media_urls": "https://example.com/image.jpg",
    "instagram_media_type": "feed",
    "instagram_first_comment": "#crosspost #socialmedia"
  }'`;

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
      description: "Account identifier in format: \"page_name (facebook)\"",
      example: "my_business_page (facebook)",
      icon: Users
    },
    {
      name: "platforms",
      type: "string | array",
      required: true,
      description: "Platforms to post to. Accepts multiple formats for flexibility with n8n.",
      example: "[\"facebook\"] or facebook or facebook,instagram",
      formats: [
        { format: "JSON array", example: '["facebook", "instagram"]' },
        { format: "String JSON array", example: '\'["facebook", "instagram"]\'' },
        { format: "Comma-separated", example: "facebook,instagram" },
        { format: "Single value", example: "facebook" }
      ],
      n8nTip: "In n8n HTTP Request body fields, use: [\"facebook\", \"instagram\"] or just: facebook,instagram",
      icon: Facebook
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
      description: "The main text content for your Facebook post. This is the post caption.",
      maxLength: 63206,
      icon: FileText
    },
    {
      name: "media_urls",
      type: "string | array",
      required: false,
      description: "Single URL or array of URLs for images/videos. Accepts multiple formats: JSON array, stringified JSON array, comma-separated URLs, or single URL.",
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
      name: "facebook_page_id",
      type: "string",
      required: false,
      description: "Specific Facebook Page ID to post to. If not provided, uses the connected page.",
      example: "123456789012345",
      icon: Facebook
    },
    {
      name: "facebook_media_type",
      type: "string",
      required: false,
      default: "null (regular post)",
      description: "Special media type for Facebook content",
      options: ["REELS", "STORIES"],
      icon: Film
    },
    {
      name: "alt_text",
      type: "string",
      required: false,
      description: "Alt text for images. Improves accessibility and SEO.",
      maxLength: 1000,
      icon: FileText
    },
    {
      name: "first_comment",
      type: "string",
      required: false,
      description: "Auto-posted first comment on the post. Great for hashtags or links.",
      maxLength: 8000,
      icon: MessageSquare
    },
    {
      name: "scheduled_date",
      type: "string",
      required: false,
      description: "ISO 8601 date/time for scheduling. If set, post will be scheduled.",
      example: "2026-01-15T09:00:00Z",
      icon: Calendar
    },
    {
      name: "timezone",
      type: "string",
      required: false,
      default: "UTC",
      description: "Timezone for the scheduled post.",
      example: "America/New_York, Europe/London",
      icon: Globe
    }
  ];

  return (
    <div className="min-h-screen bg-background">
      <DocPageHeader
        isAuthenticated={!!user}
        title="Facebook API"
        subtitle="Complete guide to posting on Facebook via n8n API"
        icon={Facebook}
        variant="sky"
        headingPreset="sky-violet"
        ctaGradient="from-sky-500 via-blue-500 to-indigo-500"
        badges={[
          { label: "Photos", icon: Image },
          { label: "Videos", icon: Video },
          { label: "Reels", icon: Film },
          { label: "Stories", icon: Clock },
          { label: "Text Posts", icon: MessageSquare },
          { label: "Scheduling", icon: Calendar },
        ]}
      />

      <main className="container mx-auto px-6 py-12 max-w-5xl">

        {/* Quick Start */}
        <Card className="mb-8 border-blue-500/20 bg-blue-500/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-blue-500" />
              Quick Start
            </CardTitle>
            <CardDescription>Get your first Facebook post published in 2 minutes</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-blue-600 text-white flex items-center justify-center text-sm font-bold">1</div>
              <div>
                <p className="font-medium">Get your API Key</p>
                <p className="text-sm text-muted-foreground">Navigate to <Link to="/api-keys" className="text-blue-500 hover:underline">Settings → API Keys</Link> to get your API key</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-blue-600 text-white flex items-center justify-center text-sm font-bold">2</div>
              <div>
                <p className="font-medium">Get your Account Identifier</p>
                <p className="text-sm text-muted-foreground">Run the accounts endpoint to find your Facebook page name</p>
              </div>
            </div>
            <CodeBlock code={curlGetAccounts} language="bash" id="get-accounts" title="Get your accounts" />
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-blue-600 text-white flex items-center justify-center text-sm font-bold">3</div>
              <div>
                <p className="font-medium">Post to Facebook</p>
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
            <TabsList className="grid w-full grid-cols-5 lg:grid-cols-10 h-auto gap-1">
              <TabsTrigger value="basic" className="text-xs">Basic</TabsTrigger>
              <TabsTrigger value="full" className="text-xs">All Fields</TabsTrigger>
              <TabsTrigger value="carousel" className="text-xs">Multiple</TabsTrigger>
              <TabsTrigger value="base64" className="text-xs">Base64</TabsTrigger>
              <TabsTrigger value="reels" className="text-xs">Reels</TabsTrigger>
              <TabsTrigger value="stories" className="text-xs">Stories</TabsTrigger>
              <TabsTrigger value="video" className="text-xs">Video</TabsTrigger>
              <TabsTrigger value="scheduled" className="text-xs">Scheduled</TabsTrigger>
              <TabsTrigger value="text" className="text-xs">Text</TabsTrigger>
              <TabsTrigger value="cross" className="text-xs">Cross-Post</TabsTrigger>
            </TabsList>

            <TabsContent value="basic" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Image className="w-5 h-5" />
                    Basic Photo Post
                  </CardTitle>
                  <CardDescription>Simple post with a single image URL to your Facebook Page</CardDescription>
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
                      <li>• Uploads it to your Facebook Page</li>
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
                  <CardDescription>Using all available Facebook-specific options</CardDescription>
                </CardHeader>
                <CardContent>
                  <CodeBlock code={curlWithAllFields} language="bash" id="full-post" />
                  <div className="mt-4 p-4 rounded-lg bg-muted/50">
                    <h4 className="font-medium mb-2 flex items-center gap-2">
                      <Info className="w-4 h-4 text-blue-500" />
                      Features used:
                    </h4>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      <li>• <strong>facebook_page_id:</strong> Target a specific Facebook Page</li>
                      <li>• <strong>alt_text:</strong> Accessibility text for the image</li>
                      <li>• <strong>first_comment:</strong> Auto-posts hashtags as first comment</li>
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
                    Multiple Images Post
                  </CardTitle>
                  <CardDescription>Post multiple images in a single Facebook post</CardDescription>
                </CardHeader>
                <CardContent>
                  <CodeBlock code={curlMultipleImages} language="bash" id="carousel-post" />
                  <div className="mt-4 p-4 rounded-lg bg-blue-500/10 border border-blue-500/20">
                    <h4 className="font-medium mb-2 flex items-center gap-2 text-blue-600">
                      <Info className="w-4 h-4" />
                      Tips for Multiple Images:
                    </h4>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      <li>• Facebook supports multiple images in a single post</li>
                      <li>• All images will be displayed in a gallery format</li>
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

            <TabsContent value="reels" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Film className="w-5 h-5 text-blue-600" />
                    Facebook Reels
                  </CardTitle>
                  <CardDescription>Post short-form vertical videos as Reels</CardDescription>
                </CardHeader>
                <CardContent>
                  <CodeBlock code={curlReels} language="bash" id="reels-post" />
                  <div className="mt-4 p-4 rounded-lg bg-blue-500/10 border border-blue-500/20">
                    <h4 className="font-medium mb-2 flex items-center gap-2 text-blue-600">
                      <Film className="w-4 h-4" />
                      Reels Requirements:
                    </h4>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      <li>• Aspect ratio: 9:16 (vertical video)</li>
                      <li>• Recommended resolution: 1080x1920</li>
                      <li>• Maximum duration: 90 seconds</li>
                      <li>• Supported formats: MP4, MOV</li>
                      <li>• Set <code className="text-xs bg-muted px-1 rounded">facebook_media_type: "REELS"</code></li>
                    </ul>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="stories" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Clock className="w-5 h-5 text-blue-500" />
                    Facebook Stories
                  </CardTitle>
                  <CardDescription>Post ephemeral content to Facebook Stories</CardDescription>
                </CardHeader>
                <CardContent>
                  <CodeBlock code={curlStories} language="bash" id="stories-post" />
                  <div className="mt-4 p-4 rounded-lg bg-amber-500/10 border border-amber-500/20">
                    <h4 className="font-medium mb-2 flex items-center gap-2 text-amber-600">
                      <AlertCircle className="w-4 h-4" />
                      Stories Notes:
                    </h4>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      <li>• Stories disappear after 24 hours</li>
                      <li>• Recommended aspect ratio: 9:16 (1080x1920)</li>
                      <li>• Title/caption is not displayed on stories</li>
                      <li>• Videos should be 20 seconds or less</li>
                      <li>• Set <code className="text-xs bg-muted px-1 rounded">facebook_media_type: "STORIES"</code></li>
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
                    Video Post
                  </CardTitle>
                  <CardDescription>Upload regular videos to Facebook Page</CardDescription>
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
                      <li>• Maximum duration: 240 minutes</li>
                      <li>• Recommended resolution: 1080p or higher</li>
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
                      <li>• Use ISO 8601 format: <code className="text-xs bg-muted px-1 rounded">2026-01-15T09:00:00Z</code></li>
                      <li>• Specify timezone with the <code className="text-xs bg-muted px-1 rounded">timezone</code> field</li>
                      <li>• Common timezones: UTC, America/New_York, Europe/London, Asia/Tokyo</li>
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
                  <CardDescription>Post text without any media</CardDescription>
                </CardHeader>
                <CardContent>
                  <CodeBlock code={curlTextOnly} language="bash" id="text-post" />
                  <div className="mt-4 p-4 rounded-lg bg-green-500/10 border border-green-500/20">
                    <h4 className="font-medium mb-2 flex items-center gap-2 text-green-600">
                      <CheckCircle2 className="w-4 h-4" />
                      Text Post Tips:
                    </h4>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      <li>• Facebook supports text-only posts natively</li>
                      <li>• Maximum character limit: 63,206 characters</li>
                      <li>• Use emojis to increase engagement</li>
                      <li>• Ask questions to encourage comments</li>
                    </ul>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="cross" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Users className="w-5 h-5 text-purple-500" />
                    Cross-Platform Post
                  </CardTitle>
                  <CardDescription>Post to Facebook and Instagram simultaneously</CardDescription>
                </CardHeader>
                <CardContent>
                  <CodeBlock code={curlCrossPost} language="bash" id="cross-post" />
                  <div className="mt-4 p-4 rounded-lg bg-purple-500/10 border border-purple-500/20">
                    <h4 className="font-medium mb-2 flex items-center gap-2 text-purple-600">
                      <Info className="w-4 h-4" />
                      Cross-Posting Tips:
                    </h4>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      <li>• Include both platforms in the <code className="text-xs bg-muted px-1 rounded">platforms</code> array</li>
                      <li>• Provide account IDs for each platform</li>
                      <li>• Use platform-specific fields for each (e.g., instagram_first_comment)</li>
                      <li>• The same media will be used for both platforms</li>
                    </ul>
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
                      <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
                        <field.icon className="w-4 h-4 text-blue-500" />
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
                      {field.options.map((opt) => (
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
                      <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{field.maxLength.toLocaleString()} characters</code>
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
    "caption": "Check out our latest product launch! 🚀",
    "platforms": ["facebook"],
    "media_file_ids": ["media-uuid-1"],
    "status": "pending",
    "created_at": "2026-01-10T12:00:00Z"
  },
  "metadata_applied": {
    "facebook": {
      "pageId": "123456789",
      "mediaType": null
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
  "error": "No valid account IDs found. You can use: internal UUID, platform_user_id, or user_identifier (e.g., \\"pagename (facebook)\\"). Use GET /api/v1/accounts to see your available accounts.",
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
                  <Clock className="w-4 h-4 text-blue-500" />
                  Post at Peak Hours
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Schedule posts for peak engagement times: weekdays 1-4 PM, and weekends 12-1 PM. 
                  Use the <code className="text-xs bg-muted px-1 rounded">scheduled_date</code> field.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Film className="w-4 h-4 text-purple-500" />
                  Leverage Reels
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Facebook Reels get higher organic reach. Use vertical video (9:16) 
                  with <code className="text-xs bg-muted px-1 rounded">facebook_media_type: "REELS"</code>.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <MessageSquare className="w-4 h-4 text-green-500" />
                  Engage with Questions
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Posts with questions get 100% more comments. End your captions with 
                  a question to boost engagement and reach.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Image className="w-4 h-4 text-orange-500" />
                  Optimize Image Quality
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Facebook recommends 1200x630 pixels for link posts and 1080x1080 for 
                  standard image posts. Max file size is 20MB.
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
            <Link to="/n8n/instagram">
              <Button variant="outline" className="gap-2">
                <span className="text-pink-500">📸</span>
                Instagram API
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
                Connect Facebook Page
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
