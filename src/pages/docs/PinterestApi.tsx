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
  CheckCircle2, Info, Calendar, Globe, Zap, Hash, Layers, Users, Pin
} from "lucide-react";
import { cn } from "@/lib/utils";

const API_BASE = "https://api.postora.cloud/functions/v1/n8n-api";

export default function PinterestApi() {
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
  const curlJsonBasicPin = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_username (pinterest)",
    "platforms": ["pinterest"],
    "title": "Beautiful sunset photography 🌅",
    "media_urls": "https://res.cloudinary.com/demo/image/upload/sample.jpg",
    "pinterest_board_id": "board-id-here"
  }'`;

  const curlJsonWithAllFields = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_username (pinterest)",
    "platforms": ["pinterest"],
    "title": "10 Amazing Home Decor Ideas for 2026 ✨",
    "media_urls": "https://res.cloudinary.com/demo/image/upload/home-decor.jpg",
    "pinterest_board_id": "board-id-here",
    "pinterest_link": "https://yourblog.com/home-decor-ideas",
    "first_comment": "Check out our blog for more ideas!",
    "alt_text": "Modern living room with minimalist furniture",
    "description": "Discover the top 10 home decor trends for 2026",
    "pinterest_title": "Home Decor Ideas 2026",
    "pinterest_alt_text": "Modern living room with minimalist furniture and natural lighting",
    "pinterest_description": "Check out our blog for more amazing home decor inspiration! #homedecor #interior"
  }'`;

  const curlJsonVideoPin = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_video",
    "user_identifier": "your_username (pinterest)",
    "platforms": ["pinterest"],
    "title": "DIY Room Makeover Tutorial 🎨",
    "media_urls": "https://res.cloudinary.com/demo/video/upload/room-makeover.mp4",
    "pinterest_board_id": "board-id-here",
    "pinterest_link": "https://yourblog.com/diy-room-makeover",
    "pinterest_alt_text": "Step by step room makeover tutorial video"
  }'`;

  const curlJsonMultipleImages = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_username (pinterest)",
    "platforms": ["pinterest"],
    "title": "Summer Fashion Collection 2026 👗",
    "media_urls": [
      "https://res.cloudinary.com/demo/image/upload/fashion1.jpg",
      "https://res.cloudinary.com/demo/image/upload/fashion2.jpg",
      "https://res.cloudinary.com/demo/image/upload/fashion3.jpg"
    ],
    "pinterest_board_id": "board-id-here",
    "pinterest_link": "https://yourshop.com/summer-collection"
  }'`;

  const curlJsonScheduled = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_username (pinterest)",
    "platforms": ["pinterest"],
    "title": "Holiday Gift Guide 2026 🎁",
    "media_urls": "https://res.cloudinary.com/demo/image/upload/gift-guide.jpg",
    "pinterest_board_id": "board-id-here",
    "pinterest_link": "https://yourblog.com/gift-guide",
    "scheduled_date": "2026-12-01T10:00:00Z",
    "timezone": "America/New_York"
  }'`;

  const curlJsonBase64 = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_username (pinterest)",
    "platforms": ["pinterest"],
    "title": "AI Generated Art 🎨",
    "media_base64": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAA...",
    "pinterest_board_id": "board-id-here",
    "pinterest_alt_text": "AI generated digital artwork"
  }'`;

  // Form-Data Examples
  const curlFormBasicPin = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "operation=upload_photos" \\
  -F "user_identifier=your_username (pinterest)" \\
  -F "platforms=pinterest" \\
  -F "title=Beautiful sunset photography 🌅" \\
  -F "media_url=https://res.cloudinary.com/demo/image/upload/sample.jpg" \\
  -F "pinterest_board_id=board-id-here"`;

  const curlFormWithFile = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "operation=upload_photos" \\
  -F "user_identifier=your_username (pinterest)" \\
  -F "platforms=pinterest" \\
  -F "title=My Recipe Pin 🍕" \\
  -F "file=@/path/to/recipe-image.jpg" \\
  -F "pinterest_board_id=board-id-here" \\
  -F "pinterest_link=https://yourblog.com/recipe"`;

  const curlFormVideo = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "operation=upload_video" \\
  -F "user_identifier=your_username (pinterest)" \\
  -F "platforms=pinterest" \\
  -F "title=Quick Recipe Tutorial 🎬" \\
  -F "file=@/path/to/recipe-video.mp4" \\
  -F "pinterest_board_id=board-id-here" \\
  -F "pinterest_link=https://yourblog.com/recipe-video"`;

  const curlFormAllFields = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "operation=upload_photos" \\
  -F "user_identifier=your_username (pinterest)" \\
  -F "platforms=pinterest" \\
  -F "title=10 Home Organization Tips ✨" \\
  -F "media_url=https://res.cloudinary.com/demo/image/upload/organization.jpg" \\
  -F "pinterest_board_id=board-id-here" \\
  -F "pinterest_link=https://yourblog.com/organization-tips" \\
  -F "first_comment=Save this for later!" \\
  -F "alt_text=Neatly organized closet" \\
  -F "description=Tips for organizing your home" \\
  -F "pinterest_title=Home Organization Tips" \\
  -F "pinterest_alt_text=Neatly organized closet with labeled storage bins" \\
  -F "pinterest_description=Save this pin for later! #organization #home"`;

  const curlGetAccounts = `curl -X GET "${API_BASE}/api/v1/accounts" \\
  -H "x-api-key: YOUR_API_KEY"`;

  const curlGetBoards = `curl -X GET "${API_BASE}/api/v1/pinterest-boards?account_id=YOUR_PINTEREST_ACCOUNT_ID" \\
  -H "x-api-key: YOUR_API_KEY"`;

  const fields = [
    {
      name: "operation",
      type: "string",
      required: false,
      default: "upload_photos",
      description: "The type of content to upload",
      options: ["upload_photos", "upload_video"],
      icon: Zap
    },
    {
      name: "user_identifier",
      type: "string",
      required: true,
      description: "Account identifier in format: \"username (pinterest)\"",
      example: "myaccount (pinterest)",
      icon: Hash
    },
    {
      name: "platforms",
      type: "string | array",
      required: true,
      description: "Platforms to post to. Accepts multiple formats for flexibility with n8n.",
      example: "[\"pinterest\"] or pinterest or pinterest,instagram",
      formats: [
        { format: "JSON array", example: '["pinterest", "instagram"]' },
        { format: "String JSON array", example: '\'["pinterest", "instagram"]\'' },
        { format: "Comma-separated", example: "pinterest,instagram" },
        { format: "Single value", example: "pinterest" }
      ],
      n8nTip: "In n8n HTTP Request, use: [\"pinterest\", \"instagram\"] or: pinterest,instagram",
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
      name: "title",
      type: "string",
      required: true,
      description: "The pin title / main content. This is displayed prominently on the pin.",
      maxLength: 100,
      icon: FileText
    },
    {
      name: "media_urls",
      type: "string | array",
      required: false,
      description: "Single URL or array of URLs for images/videos (Photos - Files or URLs). Accepts JSON array, stringified JSON array, comma-separated URLs, or single URL.",
      example: "https://res.cloudinary.com/demo/image/upload/sample.jpg",
      formats: [
        { format: "JSON array", example: "[\"url1\", \"url2\"]" },
        { format: "String JSON array", example: "'[\"url1\", \"url2\"]'" },
        { format: "Comma-separated", example: "url1,url2" },
        { format: "Single URL", example: "https://example.com/image.jpg" }
      ],
      n8nField: "Photos (Files or URLs)",
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
      name: "first_comment",
      type: "string",
      required: false,
      description: "Auto-posted first comment on the pin. Great for hashtags or additional context.",
      maxLength: 500,
      n8nField: "First Comment",
      icon: MessageSquare
    },
    {
      name: "alt_text",
      type: "string",
      required: false,
      description: "Extended alt text for accessibility. Describes the image for visually impaired users.",
      maxLength: 500,
      n8nField: "Alt Text (Extended)",
      icon: FileText
    },
    {
      name: "description",
      type: "string",
      required: false,
      description: "Optional description for the pin content.",
      maxLength: 500,
      n8nField: "Description (Optional)",
      icon: FileText
    },
    {
      name: "pinterest_board_id",
      type: "string",
      required: true,
      description: "The Pinterest board name or ID where the pin will be saved. Get board IDs from the /api/v1/pinterest-boards endpoint or use manual entry.",
      example: "123456789 or My Board Name",
      n8nField: "Pinterest Board Name or ID",
      icon: Layers
    },
    {
      name: "pinterest_link",
      type: "string",
      required: false,
      description: "Destination URL when users click on the pin (Photo/Video link). Great for driving traffic to your website.",
      example: "https://yourblog.com/article",
      n8nField: "Pinterest Link (Photo/Video)",
      icon: LinkIcon
    },
    {
      name: "pinterest_title",
      type: "string",
      required: false,
      description: "Override title specifically for Pinterest (if different from main title). Maximum 100 characters - titles will be truncated with '...' if longer.",
      maxLength: 100,
      n8nField: "Pinterest Title (Override)",
      icon: FileText
    },
    {
      name: "pinterest_alt_text",
      type: "string",
      required: false,
      description: "Override alt text specifically for Pinterest (if different from main alt_text).",
      maxLength: 500,
      n8nField: "Pinterest Alt Text (Override)",
      icon: FileText
    },
    {
      name: "pinterest_description",
      type: "string",
      required: false,
      description: "Override description specifically for Pinterest. Can include hashtags for discoverability.",
      maxLength: 500,
      n8nField: "Pinterest Description (Override)",
      icon: MessageSquare
    },
    {
      name: "scheduled_date",
      type: "string",
      required: false,
      description: "ISO 8601 date/time for scheduling. If set, pin will be scheduled instead of posted immediately.",
      example: "2026-01-15T14:00:00Z",
      n8nField: "Scheduled Date",
      icon: Calendar
    },
    {
      name: "timezone",
      type: "string",
      required: false,
      default: "UTC",
      description: "Timezone for the scheduled pin.",
      example: "Europe/Madrid, America/New_York",
      n8nField: "Timezone",
      icon: Globe
    }
  ];

  return (
    <div className="min-h-screen bg-background">
      <DocPageHeader
        isAuthenticated={!!user}
        title="Pinterest API"
        subtitle="Complete guide to creating Pins via the Postora API"
        icon={Pin}
        variant="rose"
        headingPreset="amber-rose-violet"
        ctaGradient="from-rose-500 via-red-500 to-orange-500"
        badges={[
          { label: "Image Pins", icon: Image },
          { label: "Video Pins", icon: Video },
          { label: "Boards", icon: Layers },
          { label: "Link Pins", icon: LinkIcon },
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
            <CardDescription>Get your first Pin published in 3 minutes</CardDescription>
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
                <p className="font-medium">Get your Pinterest Account & Board IDs</p>
                <p className="text-sm text-muted-foreground">Run the accounts endpoint to find your Pinterest username, then get board IDs</p>
              </div>
            </div>
            <CodeBlock code={curlGetAccounts} language="bash" id="get-accounts" title="Get your accounts" />
            <CodeBlock code={curlGetBoards} language="bash" id="get-boards" title="Get your Pinterest boards" />
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">3</div>
              <div>
                <p className="font-medium">Create your first Pin</p>
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
                <code className="text-xs bg-muted px-2 py-1 rounded block mb-2">["pinterest", "instagram"]</code>
                <code className="text-xs bg-muted px-2 py-1 rounded block">["board_id_1", "board_id_2"]</code>
              </div>
              <div className="p-4 rounded-lg bg-background border">
                <h4 className="font-medium mb-2">Comma-Separated Format</h4>
                <code className="text-xs bg-muted px-2 py-1 rounded block mb-2">pinterest,instagram</code>
                <code className="text-xs bg-muted px-2 py-1 rounded block">board_id_1,board_id_2</code>
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
            <CardTitle className="flex items-center gap-2 text-amber-500">
              <AlertCircle className="w-5 h-5" />
              Important Notes
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-green-500 mt-0.5 shrink-0" />
              <p><strong>Board ID Required:</strong> Every pin must be saved to a board. Use the <code className="px-1 bg-secondary rounded">/api/v1/pinterest-boards</code> endpoint to get your board IDs.</p>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-green-500 mt-0.5 shrink-0" />
              <p><strong>Image Dimensions:</strong> Pinterest recommends 2:3 aspect ratio (1000x1500px) for optimal display. Square and landscape images are also supported.</p>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-green-500 mt-0.5 shrink-0" />
              <p><strong>Video Limits:</strong> Videos can be up to 2GB in size and 15 minutes in duration. Minimum 4 seconds, recommended 6-15 seconds for best engagement.</p>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-green-500 mt-0.5 shrink-0" />
              <p><strong>Link Pins:</strong> Adding a <code className="px-1 bg-secondary rounded">pinterest_link</code> creates a "Rich Pin" that drives traffic to your website when users click.</p>
            </div>
            <div className="flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
              <p><strong>No Carousel Support:</strong> Pinterest's standard API does not support carousel pins. Multiple images create <strong>separate pins</strong> with numbered titles (e.g., "My Post (1/3)").</p>
            </div>
          </CardContent>
        </Card>

        {/* JSON Body Examples */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
            <FileText className="w-6 h-6" />
            JSON Body Examples
          </h2>
          
          <Tabs defaultValue="basic" className="w-full">
            <TabsList className="grid w-full grid-cols-3 lg:grid-cols-6 h-auto gap-1">
              <TabsTrigger value="basic" className="text-xs">Basic Pin</TabsTrigger>
              <TabsTrigger value="full" className="text-xs">All Fields</TabsTrigger>
              <TabsTrigger value="video" className="text-xs">Video Pin</TabsTrigger>
              <TabsTrigger value="multi" className="text-xs">Multiple</TabsTrigger>
              <TabsTrigger value="scheduled" className="text-xs">Scheduled</TabsTrigger>
              <TabsTrigger value="base64" className="text-xs">Base64</TabsTrigger>
            </TabsList>

            <TabsContent value="basic" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Image className="w-5 h-5" />
                    Basic Image Pin
                  </CardTitle>
                  <CardDescription>Simple pin with a single image URL</CardDescription>
                </CardHeader>
                <CardContent>
                  <CodeBlock code={curlJsonBasicPin} language="bash" id="json-basic" />
                  <div className="mt-4 p-4 rounded-lg bg-muted/50">
                    <h4 className="font-medium mb-2 flex items-center gap-2">
                      <Info className="w-4 h-4 text-blue-500" />
                      What this does:
                    </h4>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      <li>• Downloads the image from the provided URL</li>
                      <li>• Creates a new Pin on the specified board</li>
                      <li>• Sets the pin title from the title field</li>
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
                    Complete Pin with All Fields
                  </CardTitle>
                  <CardDescription>Pin with link, alt text, and description</CardDescription>
                </CardHeader>
                <CardContent>
                  <CodeBlock code={curlJsonWithAllFields} language="bash" id="json-full" />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="video" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Video className="w-5 h-5 text-foreground" />
                    Video Pin
                  </CardTitle>
                  <CardDescription>Create a video pin with a link</CardDescription>
                </CardHeader>
                <CardContent>
                  <CodeBlock code={curlJsonVideoPin} language="bash" id="json-video" />
                  <div className="mt-4 p-4 rounded-lg bg-muted/50">
                    <h4 className="font-medium mb-2">Video Requirements:</h4>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      <li>• Format: MP4, MOV, M4V</li>
                      <li>• Max size: 2GB</li>
                      <li>• Duration: 4 seconds to 15 minutes</li>
                      <li>• Aspect ratio: 2:3, 9:16, or 1:1 recommended</li>
                    </ul>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="multi" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Layers className="w-5 h-5 text-blue-500" />
                    Multiple Images
                  </CardTitle>
                  <CardDescription>Post multiple images to Pinterest</CardDescription>
                </CardHeader>
                <CardContent>
                  <CodeBlock code={curlJsonMultipleImages} language="bash" id="json-multi" />
                  
                  {/* Important Carousel Limitation Notice */}
                  <div className="mt-4 p-4 rounded-lg bg-amber-500/10 border border-amber-500/30">
                    <h4 className="font-medium mb-2 flex items-center gap-2 text-amber-600">
                      <AlertCircle className="w-4 h-4" />
                      Important: Pinterest Carousel Limitation
                    </h4>
                    <p className="text-sm text-muted-foreground mb-3">
                      <strong>Pinterest's standard API does not support carousel pins.</strong> Carousel pins are only available through:
                    </p>
                    <ul className="text-sm text-muted-foreground space-y-1 mb-3">
                      <li>• <strong>Pinterest Ads API</strong> - Requires paid advertising account</li>
                      <li>• <strong>Product Catalogs</strong> - Requires linked product data feed</li>
                      <li>• <strong>Manual creation</strong> - Via Pinterest's web interface only</li>
                    </ul>
                  </div>

                  {/* How Multiple Images Work */}
                  <div className="mt-4 p-4 rounded-lg bg-blue-500/10 border border-blue-500/30">
                    <h4 className="font-medium mb-2 flex items-center gap-2 text-blue-600">
                      <Info className="w-4 h-4" />
                      How Multiple Images Work
                    </h4>
                    <p className="text-sm text-muted-foreground mb-3">
                      When you provide multiple image URLs, each image is posted as a <strong>separate pin</strong> to the same board:
                    </p>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      <li>• Each pin gets a numbered title: <code className="px-1 bg-secondary rounded">"Summer Fashion (1/3)"</code>, <code className="px-1 bg-secondary rounded">"Summer Fashion (2/3)"</code>, etc.</li>
                      <li>• All pins share the same description, link, and alt text</li>
                      <li>• A 500ms delay is applied between pins to avoid rate limiting</li>
                      <li>• The response includes all created pin IDs (comma-separated)</li>
                      <li>• If some pins fail, successful ones are still created</li>
                    </ul>
                  </div>

                  {/* Example Response */}
                  <div className="mt-4 p-4 rounded-lg bg-muted/50">
                    <h4 className="font-medium mb-2">Example Response (3 images):</h4>
                    <pre className="text-xs bg-background p-3 rounded border overflow-x-auto">
{`{
  "success": true,
  "results": [{
    "platform": "pinterest",
    "status": "success",
    "post_id": "pin_id_1,pin_id_2,pin_id_3",
    "post_url": "https://pinterest.com/pin/pin_id_1"
  }]
}`}
                    </pre>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="scheduled" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Calendar className="w-5 h-5 text-orange-500" />
                    Scheduled Pin
                  </CardTitle>
                  <CardDescription>Schedule a pin for future publication</CardDescription>
                </CardHeader>
                <CardContent>
                  <CodeBlock code={curlJsonScheduled} language="bash" id="json-scheduled" />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="base64" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Image className="w-5 h-5 text-cyan-500" />
                    Base64 Image
                  </CardTitle>
                  <CardDescription>Upload image using Base64 encoding</CardDescription>
                </CardHeader>
                <CardContent>
                  <CodeBlock code={curlJsonBase64} language="bash" id="json-base64" />
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </section>

        {/* Form-Data Examples */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
            <FileText className="w-6 h-6" />
            Form-Data Examples
          </h2>
          
          <Tabs defaultValue="basic" className="w-full">
            <TabsList className="grid w-full grid-cols-2 lg:grid-cols-4 h-auto gap-1">
              <TabsTrigger value="basic" className="text-xs">Basic Pin</TabsTrigger>
              <TabsTrigger value="file" className="text-xs">File Upload</TabsTrigger>
              <TabsTrigger value="video" className="text-xs">Video</TabsTrigger>
              <TabsTrigger value="full" className="text-xs">All Fields</TabsTrigger>
            </TabsList>

            <TabsContent value="basic" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Image className="w-5 h-5" />
                    Basic Pin with URL
                  </CardTitle>
                  <CardDescription>Simple form-data request with image URL</CardDescription>
                </CardHeader>
                <CardContent>
                  <CodeBlock code={curlFormBasicPin} language="bash" id="form-basic" />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="file" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Image className="w-5 h-5 text-green-500" />
                    Direct File Upload
                  </CardTitle>
                  <CardDescription>Upload a local file directly</CardDescription>
                </CardHeader>
                <CardContent>
                  <CodeBlock code={curlFormWithFile} language="bash" id="form-file" />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="video" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Video className="w-5 h-5 text-foreground" />
                    Video File Upload
                  </CardTitle>
                  <CardDescription>Upload a video file directly</CardDescription>
                </CardHeader>
                <CardContent>
                  <CodeBlock code={curlFormVideo} language="bash" id="form-video" />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="full" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <CheckCircle2 className="w-5 h-5 text-green-500" />
                    Complete Form-Data Request
                  </CardTitle>
                  <CardDescription>All fields using form-data format</CardDescription>
                </CardHeader>
                <CardContent>
                  <CodeBlock code={curlFormAllFields} language="bash" id="form-full" />
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </section>

        {/* API Fields Reference */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-6">API Fields Reference</h2>
          
          <div className="space-y-4">
            {fields.map((field, index) => (
              <Card key={index} className="overflow-hidden">
                <div className="flex items-start gap-4 p-4">
                  <div className="w-10 h-10 rounded-lg bg-secondary flex items-center justify-center shrink-0">
                    <field.icon className="w-5 h-5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <code className="text-sm font-mono text-primary">{field.name}</code>
                      <Badge variant="outline" className="text-xs">{field.type}</Badge>
                      {field.required && <Badge variant="destructive" className="text-xs">Required</Badge>}
                      {field.default && <Badge variant="secondary" className="text-xs">Default: {field.default}</Badge>}
                    </div>
                    <p className="text-sm text-muted-foreground mb-2">{field.description}</p>
                    {field.n8nField && (
                      <p className="text-xs text-primary mb-2">
                        <span className="font-medium">n8n Field:</span> {field.n8nField}
                      </p>
                    )}
                    {field.options && (
                      <div className="flex flex-wrap gap-1 mb-2">
                        {field.options.map((opt, i) => (
                          <code key={i} className="text-xs bg-muted px-1.5 py-0.5 rounded">{opt}</code>
                        ))}
                      </div>
                    )}
                    {field.example && (
                      <p className="text-xs text-muted-foreground">
                        <span className="font-medium">Example:</span> <code className="bg-muted px-1 rounded">{field.example}</code>
                      </p>
                    )}
                    {field.maxLength && (
                      <p className="text-xs text-muted-foreground">
                        <span className="font-medium">Max length:</span> {field.maxLength} characters
                      </p>
                    )}
                    {field.formats && (
                      <div className="mt-2 p-2 rounded bg-muted/50">
                        <p className="text-xs font-medium mb-1">Supported Formats:</p>
                        <div className="grid grid-cols-2 gap-1">
                          {field.formats.map((f, i) => (
                            <p key={i} className="text-xs text-muted-foreground">
                              <span className="font-medium">{f.format}:</span> <code className="text-[10px]">{f.example}</code>
                            </p>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </section>

        {/* Response Examples */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-6">Response Examples</h2>
          
          <Tabs defaultValue="success" className="w-full">
            <TabsList>
              <TabsTrigger value="success">Success</TabsTrigger>
              <TabsTrigger value="scheduled">Scheduled</TabsTrigger>
              <TabsTrigger value="error">Error</TabsTrigger>
            </TabsList>

            <TabsContent value="success" className="mt-6">
              <CodeBlock 
                code={`{
  "success": true,
  "message": "Post created successfully",
  "post_id": "abc123-def456-ghi789",
  "platforms": {
    "pinterest": {
      "success": true,
      "pin_id": "1234567890",
      "pin_url": "https://pinterest.com/pin/1234567890"
    }
  }
}`} 
                language="json" 
                id="resp-success" 
              />
            </TabsContent>

            <TabsContent value="scheduled" className="mt-6">
              <CodeBlock 
                code={`{
  "success": true,
  "message": "Post scheduled successfully",
  "post_id": "abc123-def456-ghi789",
  "scheduled_at": "2026-12-01T10:00:00Z",
  "status": "scheduled"
}`} 
                language="json" 
                id="resp-scheduled" 
              />
            </TabsContent>

            <TabsContent value="error" className="mt-6">
              <CodeBlock 
                code={`{
  "success": false,
  "error": "Board not found",
  "details": "The specified pinterest_board_id does not exist or you don't have access to it.",
  "code": "BOARD_NOT_FOUND"
}`} 
                language="json" 
                id="resp-error" 
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

          <Card className="mb-6">
            <CardHeader>
              <CardTitle>HTTP Request Node Settings</CardTitle>
              <CardDescription>Configure your n8n HTTP Request node with these settings</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-start py-2 font-medium">Setting</th>
                      <th className="text-start py-2 font-medium">JSON Method</th>
                      <th className="text-start py-2 font-medium">Form-Data Method</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b">
                      <td className="py-2">Method</td>
                      <td className="py-2 text-muted-foreground">POST</td>
                      <td className="py-2 text-muted-foreground">POST</td>
                    </tr>
                    <tr className="border-b">
                      <td className="py-2">URL</td>
                      <td className="py-2 text-muted-foreground font-mono text-xs" colSpan={2}>{API_BASE}/api/v1/post</td>
                    </tr>
                    <tr className="border-b">
                      <td className="py-2">Body Content Type</td>
                      <td className="py-2 text-muted-foreground">JSON</td>
                      <td className="py-2 text-muted-foreground">Form-Data</td>
                    </tr>
                    <tr className="border-b">
                      <td className="py-2">Authentication</td>
                      <td className="py-2 text-muted-foreground" colSpan={2}>Header Auth with x-api-key</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <div className="flex gap-4">
            <Link to="/n8n">
              <Button variant="outline" className="gap-2">
                <Zap className="w-4 h-4" />
                Full n8n Guide
                <ExternalLink className="w-3 h-3" />
              </Button>
            </Link>
          </div>
        </section>

        {/* Footer Navigation */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between pt-8 border-t">
          <Link to="/docs" className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4" />
            Back to Documentation
          </Link>
          <div className="flex flex-wrap gap-4">
            <Link to="/n8n/instagram">
              <Button variant="outline" size="sm" className="gap-2">
                <PlatformIcon platform="instagram" size="xs" />
                Instagram API
              </Button>
            </Link>
            <Link to="/n8n/facebook">
              <Button variant="outline" size="sm" className="gap-2">
                <PlatformIcon platform="facebook" size="xs" />
                Facebook API
              </Button>
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
