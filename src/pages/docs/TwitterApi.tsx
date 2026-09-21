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
  AtSign, Reply, Quote, MapPin, Users, Twitter
} from "lucide-react";
import { cn } from "@/lib/utils";

const API_BASE = "https://api.postora.cloud/functions/v1/n8n-api";

export default function TwitterApi() {
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
  const curlJsonBasicTweet = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_handle (twitter)",
    "platforms": ["twitter"],
    "caption": "Hello Twitter! 🐦 #firsttweet"
  }'`;

  const curlJsonWithImage = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_handle (twitter)",
    "platforms": ["twitter"],
    "caption": "Check out this amazing photo! 📸",
    "media_urls": "https://res.cloudinary.com/demo/image/upload/sample.jpg"
  }'`;

  const curlJsonWithAllFields = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_handle (twitter)",
    "platforms": ["twitter"],
    "caption": "🚀 Big announcement coming soon!\\n\\nStay tuned for something exciting!\\n\\n#announcement #exciting",
    "media_urls": "https://res.cloudinary.com/demo/image/upload/announcement.jpg",
    "twitter_reply_settings": "mentionedUsers",
    "twitter_for_super_followers_only": false,
    "twitter_place_id": "5a110d312052166f",
    "first_comment": "Follow us for more updates!"
  }'`;

  const curlJsonVideoTweet = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_video",
    "user_identifier": "your_handle (twitter)",
    "platforms": ["twitter"],
    "caption": "New video just dropped! 🎬",
    "media_urls": "https://res.cloudinary.com/demo/video/upload/sample.mp4"
  }'`;

  const curlJsonReplyTweet = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_handle (twitter)",
    "platforms": ["twitter"],
    "caption": "Great point! I totally agree 💯",
    "twitter_reply_to_tweet_id": "1234567890123456789"
  }'`;

  const curlJsonQuoteTweet = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_handle (twitter)",
    "platforms": ["twitter"],
    "caption": "This is so true! Everyone needs to see this 👇",
    "twitter_quote_tweet_id": "1234567890123456789"
  }'`;

  const curlJsonScheduled = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_handle (twitter)",
    "platforms": ["twitter"],
    "caption": "Scheduled tweet going out at the perfect time! ⏰",
    "media_urls": "https://res.cloudinary.com/demo/image/upload/scheduled.jpg",
    "scheduled_date": "2026-02-01T14:00:00Z",
    "timezone": "America/Los_Angeles"
  }'`;

  const curlJsonMultipleImages = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "user_identifier": "your_handle (twitter)",
    "platforms": ["twitter"],
    "caption": "Thread of amazing photos! 🧵 (1/4)",
    "media_urls": [
      "https://res.cloudinary.com/demo/image/upload/photo1.jpg",
      "https://res.cloudinary.com/demo/image/upload/photo2.jpg",
      "https://res.cloudinary.com/demo/image/upload/photo3.jpg",
      "https://res.cloudinary.com/demo/image/upload/photo4.jpg"
    ]
  }'`;

  // Form-Data Examples
  const curlFormBasicTweet = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "operation=upload_photos" \\
  -F "user_identifier=your_handle (twitter)" \\
  -F "platforms=twitter" \\
  -F "caption=Hello Twitter! 🐦"`;

  const curlFormWithFile = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "operation=upload_photos" \\
  -F "user_identifier=your_handle (twitter)" \\
  -F "platforms=twitter" \\
  -F "caption=Direct upload from my computer! 📤" \\
  -F "file=@/path/to/image.jpg"`;

  const curlFormVideo = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "operation=upload_video" \\
  -F "user_identifier=your_handle (twitter)" \\
  -F "platforms=twitter" \\
  -F "caption=Check out this video! 🎥" \\
  -F "file=@/path/to/video.mp4"`;

  const curlFormAllFields = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "operation=upload_photos" \\
  -F "user_identifier=your_handle (twitter)" \\
  -F "platforms=twitter" \\
  -F "caption=Tweet with all settings! ⚙️" \\
  -F "file=@/path/to/image.jpg" \\
  -F "twitter_reply_settings=everyone" \\
  -F "twitter_for_super_followers_only=false" \\
  -F "first_comment=Thanks for reading!"`;

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
      description: "Account identifier in format: \"handle (twitter)\"",
      example: "elonmusk (twitter)",
      icon: AtSign
    },
    {
      name: "platforms",
      type: "string | array",
      required: true,
      description: "Platforms to post to. Accepts multiple formats for flexibility with n8n.",
      example: "[\"twitter\"] or twitter or twitter,instagram",
      formats: [
        { format: "JSON array", example: '["twitter", "instagram"]' },
        { format: "String JSON array", example: '\'["twitter", "instagram"]\'' },
        { format: "Comma-separated", example: "twitter,instagram" },
        { format: "Single value", example: "twitter" }
      ],
      n8nTip: "In n8n HTTP Request, use: [\"twitter\", \"instagram\"] or: twitter,instagram",
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
      description: "The tweet text. Supports mentions, hashtags, and emojis.",
      maxLength: 280,
      icon: MessageSquare
    },
    {
      name: "media_urls",
      type: "string | array",
      required: false,
      description: "Image or video URL(s) to include. Twitter supports up to 4 images or 1 video per tweet.",
      example: "https://res.cloudinary.com/demo/image/upload/sample.jpg",
      n8nField: "Photos (Files or URLs)",
      icon: Image
    },
    {
      name: "media_base64",
      type: "string | array",
      required: false,
      description: "Base64 encoded media with data URI prefix. Alternative to media_urls for direct file upload without hosting. Supports up to 4 images or 1 video. In n8n, use Binary Data media source.",
      example: "data:image/jpeg;base64,/9j/4AAQSkZJRg...",
      icon: Image
    },
    {
      name: "twitter_custom_title",
      type: "string",
      required: false,
      description: "Custom title for X/Twitter that overrides the main caption.",
      example: "Breaking News!",
      n8nField: "X Title (Override)",
      icon: FileText
    },
    {
      name: "twitter_thumbnail_url",
      type: "string",
      required: false,
      description: "Custom thumbnail URL for the tweet. Used for video tweets.",
      example: "https://example.com/thumbnail.jpg",
      n8nField: "Twitter Thumbnail URL",
      icon: Image
    },
    {
      name: "first_comment",
      type: "string",
      required: false,
      description: "Auto-posted reply to your own tweet. Great for threads or additional context.",
      maxLength: 280,
      n8nField: "First Comment",
      icon: Reply
    },
    {
      name: "twitter_reply_settings",
      type: "string",
      required: false,
      default: "everyone",
      description: "Controls who can reply to the tweet.",
      options: ["everyone", "following", "mentionedUsers", "subscribers", "verified"],
      n8nField: "X Reply Settings",
      icon: Users
    },
    {
      name: "twitter_reply_to_tweet_id",
      type: "string",
      required: false,
      description: "Tweet ID to reply to. Creates a reply to an existing tweet.",
      example: "1234567890123456789",
      n8nField: "Reply to tweet ID",
      icon: Reply
    },
    {
      name: "twitter_quote_tweet_id",
      type: "string",
      required: false,
      description: "Tweet ID to quote. Creates a quote tweet.",
      example: "1234567890123456789",
      n8nField: "Twitter Quote Tweet ID",
      icon: Quote
    },
    {
      name: "twitter_tagged_user_ids",
      type: "string | array",
      required: false,
      description: "User IDs to tag in the tweet. Comma-separated or JSON array.",
      example: "123456789,987654321",
      n8nField: "X Tagged User IDs",
      icon: AtSign
    },
    {
      name: "twitter_exclude_reply_user_ids",
      type: "string | array",
      required: false,
      description: "User IDs to exclude from reply thread. Requires reply_to_tweet_id.",
      example: "123456789,987654321",
      n8nField: "Exclude reply user IDs",
      icon: Users
    },
    {
      name: "twitter_for_super_followers_only",
      type: "boolean",
      required: false,
      default: false,
      description: "Whether the tweet is only visible to Super Followers.",
      n8nField: "X For Super Followers Only",
      icon: Users
    },
    {
      name: "twitter_share_with_followers",
      type: "boolean",
      required: false,
      default: true,
      description: "Whether to share the tweet with followers.",
      n8nField: "X Share with Followers",
      icon: Users
    },
    {
      name: "twitter_nullcast",
      type: "boolean",
      required: false,
      default: false,
      description: "If true, tweet won't appear in timelines (no broadcast).",
      n8nField: "X Nullcast",
      icon: AlertCircle
    },
    {
      name: "twitter_place_id",
      type: "string",
      required: false,
      description: "Twitter place ID to tag location. Get place IDs from Twitter API.",
      example: "5a110d312052166f",
      n8nField: "X Place ID (Video)",
      icon: MapPin
    },
    {
      name: "twitter_community_id",
      type: "string",
      required: false,
      description: "Community ID to post the tweet to a specific Twitter Community.",
      example: "1234567890123456789",
      n8nField: "X Community ID",
      icon: Users
    },
    {
      name: "twitter_dm_deep_link",
      type: "string",
      required: false,
      description: "Direct Message deep link URL to include in the tweet.",
      example: "https://twitter.com/messages/compose?recipient_id=123",
      n8nField: "X Direct Message Deep Link",
      icon: LinkIcon
    },
    {
      name: "twitter_thread_mode",
      type: "boolean",
      required: false,
      default: false,
      description: "If true, long content will be split into a thread of tweets.",
      n8nField: "Thread Mode",
      icon: Layers
    },
    {
      name: "twitter_post_as_long_tweet",
      type: "boolean",
      required: false,
      default: false,
      description: "If true, post as a single long tweet (Twitter Blue feature). If false, long content is threaded.",
      n8nField: "X Long Text as Single Post",
      icon: FileText
    },
    {
      name: "twitter_poll_enabled",
      type: "boolean",
      required: false,
      default: false,
      description: "Whether to include a poll in the tweet.",
      n8nField: "Poll Enabled",
      icon: Hash
    },
    {
      name: "twitter_poll_options",
      type: "string | array",
      required: false,
      description: "Poll options (2-4 options). Only used when twitter_poll_enabled is true.",
      example: "[\"Option A\", \"Option B\", \"Option C\"]",
      n8nField: "Poll Options",
      icon: Hash
    },
    {
      name: "twitter_poll_duration",
      type: "number",
      required: false,
      default: 1440,
      description: "Poll duration in minutes (5-10080). Default is 1440 (24 hours).",
      example: "1440",
      n8nField: "Poll Duration (Minutes)",
      icon: Calendar
    },
    {
      name: "scheduled_date",
      type: "string",
      required: false,
      description: "ISO 8601 date/time for scheduling. If set, tweet will be scheduled instead of posted immediately.",
      example: "2026-01-15T14:00:00Z",
      n8nField: "Scheduled Date",
      icon: Calendar
    },
    {
      name: "timezone",
      type: "string",
      required: false,
      default: "UTC",
      description: "Timezone for the scheduled tweet.",
      example: "America/New_York, Europe/London",
      n8nField: "Timezone",
      icon: Globe
    }
  ];

  return (
    <div className="min-h-screen bg-background">
      <DocPageHeader
        isAuthenticated={!!user}
        title="Twitter/X API"
        subtitle="Complete guide to tweeting via the Postora API"
        icon={Twitter}
        variant="indigo"
        headingPreset="violet-sky"
        ctaGradient="from-indigo-500 via-violet-500 to-purple-500"
        badges={[
          { label: "Tweets", icon: MessageSquare },
          { label: "Image Tweets", icon: Image },
          { label: "Video Tweets", icon: Video },
          { label: "Replies", icon: Reply },
          { label: "Quote Tweets", icon: Quote },
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
            <CardDescription>Get your first tweet published in 3 minutes</CardDescription>
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
                <p className="font-medium">Get your Twitter Handle</p>
                <p className="text-sm text-muted-foreground">Run the accounts endpoint to find your Twitter/X handle</p>
              </div>
            </div>
            <CodeBlock code={curlGetAccounts} language="bash" id="get-accounts" title="Get your accounts" />
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">3</div>
              <div>
                <p className="font-medium">Send your first tweet</p>
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
                <code className="text-xs bg-muted px-2 py-1 rounded block mb-2">["twitter", "instagram"]</code>
                <code className="text-xs bg-muted px-2 py-1 rounded block">["17841478425635377", "942626662258010"]</code>
              </div>
              <div className="p-4 rounded-lg bg-background border">
                <h4 className="font-medium mb-2">Comma-Separated Format</h4>
                <code className="text-xs bg-muted px-2 py-1 rounded block mb-2">twitter,instagram</code>
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
              <p className="text-sm"><strong>Character Limit:</strong> Tweets are limited to 280 characters. URLs count as 23 characters.</p>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-green-500 mt-0.5 flex-shrink-0" />
              <p className="text-sm"><strong>Image Format:</strong> Twitter supports JPEG, PNG, GIF, and WebP. Max 4 images per tweet, 5MB each.</p>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-green-500 mt-0.5 flex-shrink-0" />
              <p className="text-sm"><strong>Video Format:</strong> MP4 and MOV supported. Max 512MB, 2 minutes 20 seconds duration.</p>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-green-500 mt-0.5 flex-shrink-0" />
              <p className="text-sm"><strong>GIFs:</strong> Animated GIFs are supported but count as images (max 15MB).</p>
            </div>
            <div className="flex items-start gap-2">
              <Info className="w-4 h-4 text-blue-500 mt-0.5 flex-shrink-0" />
              <p className="text-sm"><strong>API Limits:</strong> Twitter API has rate limits. Check your usage to avoid hitting limits.</p>
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
            <TabsList className="grid w-full grid-cols-4 lg:grid-cols-8 mb-4">
              <TabsTrigger value="basic">Basic</TabsTrigger>
              <TabsTrigger value="image">Image</TabsTrigger>
              <TabsTrigger value="all-fields">All Fields</TabsTrigger>
              <TabsTrigger value="video">Video</TabsTrigger>
              <TabsTrigger value="reply">Reply</TabsTrigger>
              <TabsTrigger value="quote">Quote</TabsTrigger>
              <TabsTrigger value="multiple">4 Images</TabsTrigger>
              <TabsTrigger value="scheduled">Scheduled</TabsTrigger>
            </TabsList>
            <TabsContent value="basic">
              <CodeBlock code={curlJsonBasicTweet} language="bash" id="json-basic" title="Basic text tweet" />
            </TabsContent>
            <TabsContent value="image">
              <CodeBlock code={curlJsonWithImage} language="bash" id="json-image" title="Tweet with image" />
            </TabsContent>
            <TabsContent value="all-fields">
              <CodeBlock code={curlJsonWithAllFields} language="bash" id="json-all" title="Tweet with all fields" />
            </TabsContent>
            <TabsContent value="video">
              <CodeBlock code={curlJsonVideoTweet} language="bash" id="json-video" title="Video tweet" />
            </TabsContent>
            <TabsContent value="reply">
              <CodeBlock code={curlJsonReplyTweet} language="bash" id="json-reply" title="Reply to tweet" />
            </TabsContent>
            <TabsContent value="quote">
              <CodeBlock code={curlJsonQuoteTweet} language="bash" id="json-quote" title="Quote tweet" />
            </TabsContent>
            <TabsContent value="multiple">
              <CodeBlock code={curlJsonMultipleImages} language="bash" id="json-multiple" title="Tweet with 4 images" />
            </TabsContent>
            <TabsContent value="scheduled">
              <CodeBlock code={curlJsonScheduled} language="bash" id="json-scheduled" title="Scheduled tweet" />
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
              <CodeBlock code={curlFormBasicTweet} language="bash" id="form-basic" title="Basic tweet" />
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
  "message": "Tweet published successfully",
  "post_id": "abc123-def456-ghi789",
  "platform_results": {
    "twitter": {
      "success": true,
      "tweet_id": "1234567890123456789",
      "tweet_url": "https://twitter.com/username/status/1234567890123456789",
      "status": "published"
    }
  }
}`} 
                language="json" 
                id="response-success" 
                title="Successful tweet response" 
              />
            </TabsContent>
            <TabsContent value="scheduled">
              <CodeBlock 
                code={`{
  "success": true,
  "message": "Tweet scheduled successfully",
  "post_id": "abc123-def456-ghi789",
  "scheduled_at": "2026-02-01T14:00:00Z",
  "platform_results": {
    "twitter": {
      "success": true,
      "status": "scheduled",
      "scheduled_time": "2026-02-01T14:00:00Z"
    }
  }
}`} 
                language="json" 
                id="response-scheduled" 
                title="Scheduled tweet response" 
              />
            </TabsContent>
            <TabsContent value="error">
              <CodeBlock 
                code={`{
  "success": false,
  "error": "Tweet failed",
  "message": "Tweet text exceeds character limit",
  "details": {
    "platform": "twitter",
    "error_code": "CHARACTER_LIMIT_EXCEEDED",
    "max_characters": 280,
    "provided_characters": 312
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
              <CardDescription>Configure n8n to tweet automatically</CardDescription>
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
          <Link to="/docs/linkedin-api" className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4" />
            LinkedIn API
          </Link>
          <Link to="/docs/tiktok-api" className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
            TikTok API
            <ExternalLink className="w-4 h-4" />
          </Link>
        </div>
      </main>
    </div>
  );
}
