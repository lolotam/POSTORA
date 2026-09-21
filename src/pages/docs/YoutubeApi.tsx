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
  Clock, Shield, Eye, Users, Lock, Music, Languages, MapPin, Youtube
} from "lucide-react";
import { cn } from "@/lib/utils";

const API_BASE = "https://api.postora.cloud/functions/v1/n8n-api";

export default function YoutubeApi() {
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
    "user_identifier": "your_channel (youtube)",
    "platforms": ["youtube"],
    "title": "My Amazing Video 🎬",
    "description": "Check out this amazing video!",
    "media_urls": "https://res.cloudinary.com/demo/video/upload/sample.mp4"
  }'`;

  const curlJsonWithAllFields = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_video",
    "user_identifier": "your_channel (youtube)",
    "platforms": ["youtube"],
    "title": "Complete YouTube Tutorial 2026 📚",
    "description": "Learn everything about YouTube in this comprehensive tutorial!",
    "media_urls": "https://res.cloudinary.com/demo/video/upload/tutorial.mp4",
    "youtube_tags": ["tutorial", "youtube", "2026", "guide"],
    "youtube_category_id": "22",
    "youtube_privacy_status": "public",
    "youtube_embeddable": true,
    "youtube_license": "youtube",
    "youtube_public_stats_viewable": true,
    "youtube_thumbnail": "https://example.com/thumbnail.jpg",
    "youtube_made_for_kids": false,
    "youtube_contains_synthetic_media": false,
    "youtube_default_language": "en",
    "youtube_default_audio_language": "en"
  }'`;

  const curlJsonShort = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_video",
    "user_identifier": "your_channel (youtube)",
    "platforms": ["youtube"],
    "title": "Quick Tip! #shorts",
    "description": "A quick tip for you! #shorts #viral",
    "media_urls": "https://res.cloudinary.com/demo/video/upload/short-video.mp4",
    "youtube_category_id": "22",
    "youtube_privacy_status": "public",
    "youtube_made_for_kids": false
  }'`;

  const curlJsonPrivate = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_video",
    "user_identifier": "your_channel (youtube)",
    "platforms": ["youtube"],
    "title": "Private Video for Review",
    "description": "This video is private and only visible to me",
    "media_urls": "https://res.cloudinary.com/demo/video/upload/private-video.mp4",
    "youtube_privacy_status": "private",
    "youtube_embeddable": false,
    "youtube_public_stats_viewable": false
  }'`;

  const curlJsonScheduled = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_video",
    "user_identifier": "your_channel (youtube)",
    "platforms": ["youtube"],
    "title": "Scheduled Video Premiere 🎉",
    "description": "Coming soon! Subscribe to not miss it!",
    "media_urls": "https://res.cloudinary.com/demo/video/upload/premiere.mp4",
    "youtube_privacy_status": "private",
    "youtube_made_for_kids": false,
    "scheduled_date": "2026-02-01T18:00:00Z",
    "timezone": "America/New_York"
  }'`;

  const curlJsonWithGeoRestrictions = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_video",
    "user_identifier": "your_channel (youtube)",
    "platforms": ["youtube"],
    "title": "Region-Specific Content",
    "description": "This video is only available in certain countries",
    "media_urls": "https://res.cloudinary.com/demo/video/upload/regional.mp4",
    "youtube_privacy_status": "public",
    "youtube_allowed_countries": ["US", "CA", "GB", "AU"],
    "youtube_blocked_countries": [],
    "youtube_default_language": "en"
  }'`;

  const curlJsonWithFirstComment = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_video",
    "user_identifier": "your_channel (youtube)",
    "platforms": ["youtube"],
    "title": "New Tutorial with Engagement Comment",
    "description": "Check out this tutorial! Subscribe for more content.",
    "media_urls": "https://res.cloudinary.com/demo/video/upload/tutorial.mp4",
    "youtube_privacy_status": "public",
    "youtube_first_comment": "Thanks for watching! 🎉 What topic should I cover next? Let me know in the replies!",
    "youtube_made_for_kids": false
  }'`;

  // Form-Data Examples
  const curlFormBasicVideo = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "operation=upload_video" \\
  -F "user_identifier=your_channel (youtube)" \\
  -F "platforms=youtube" \\
  -F "title=My Amazing Video 🎬" \\
  -F "description=Check out this amazing video!" \\
  -F "media_url=https://res.cloudinary.com/demo/video/upload/sample.mp4"`;

  const curlFormWithFile = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "operation=upload_video" \\
  -F "user_identifier=your_channel (youtube)" \\
  -F "platforms=youtube" \\
  -F "title=My Uploaded Video 📹" \\
  -F "description=Uploaded directly from my computer!" \\
  -F "file=@/path/to/my-video.mp4" \\
  -F "youtube_category_id=22" \\
  -F "youtube_privacy_status=public"`;

  const curlFormWithThumbnail = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "operation=upload_video" \\
  -F "user_identifier=your_channel (youtube)" \\
  -F "platforms=youtube" \\
  -F "title=Video with Custom Thumbnail" \\
  -F "description=This video has a custom thumbnail!" \\
  -F "file=@/path/to/video.mp4" \\
  -F "youtube_thumbnail=https://example.com/custom-thumbnail.jpg" \\
  -F "youtube_category_id=22" \\
  -F "youtube_tags=tutorial,guide,howto"`;

  const curlFormAllFields = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "operation=upload_video" \\
  -F "user_identifier=your_channel (youtube)" \\
  -F "platforms=youtube" \\
  -F "title=Complete Video with All Settings" \\
  -F "description=Full description with all settings configured" \\
  -F "file=@/path/to/video.mp4" \\
  -F "youtube_tags=tutorial,complete,guide" \\
  -F "youtube_category_id=22" \\
  -F "youtube_privacy_status=public" \\
  -F "youtube_embeddable=true" \\
  -F "youtube_license=youtube" \\
  -F "youtube_public_stats_viewable=true" \\
  -F "youtube_thumbnail=https://example.com/thumb.jpg" \\
  -F "youtube_made_for_kids=false" \\
  -F "youtube_contains_synthetic_media=false" \\
  -F "youtube_default_language=en" \\
  -F "youtube_default_audio_language=en"`;

  const curlGetAccounts = `curl -X GET "${API_BASE}/api/v1/accounts" \\
  -H "x-api-key: YOUR_API_KEY"`;

  const fields = [
    {
      name: "operation",
      type: "string",
      required: false,
      default: "upload_video",
      description: "The type of content to upload. YouTube only supports video uploads.",
      options: ["upload_video"],
      icon: Zap
    },
    {
      name: "user_identifier",
      type: "string",
      required: true,
      description: "Account identifier in format: \"channel_name (youtube)\"",
      example: "mychannel (youtube)",
      icon: Hash
    },
    {
      name: "platforms",
      type: "string | array",
      required: true,
      description: "Platforms to post to. Accepts multiple formats for flexibility with n8n.",
      example: "[\"youtube\"] or youtube or youtube,tiktok",
      formats: [
        { format: "JSON array", example: '["youtube", "tiktok"]' },
        { format: "String JSON array", example: '\'["youtube", "tiktok"]\'' },
        { format: "Comma-separated", example: "youtube,tiktok" },
        { format: "Single value", example: "youtube" }
      ],
      n8nTip: "In n8n HTTP Request, use: [\"youtube\", \"tiktok\"] or: youtube,tiktok",
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
      description: "The video title. This is the main title displayed on YouTube.",
      maxLength: 100,
      icon: FileText
    },
    {
      name: "description",
      type: "string",
      required: false,
      description: "The video description. Can include links, timestamps, and hashtags.",
      maxLength: 5000,
      icon: MessageSquare
    },
    {
      name: "media_urls",
      type: "string | array",
      required: false,
      description: "Video URL to upload. Accepts cloud-hosted video URLs.",
      example: "https://res.cloudinary.com/demo/video/upload/sample.mp4",
      n8nField: "Video (File or URL)",
      icon: Video
    },
    {
      name: "media_base64",
      type: "string | array",
      required: false,
      description: "Base64 encoded video with data URI prefix. Alternative to media_urls for direct file upload without hosting. In n8n, use Binary Data media source with comma-separated property names for multiple files.",
      example: "data:video/mp4;base64,AAAAIGZ0eXBpc29t...",
      icon: Video
    },
    {
      name: "youtube_tags",
      type: "array | string",
      required: false,
      description: "Tags for the video to improve discoverability. Can be array or comma-separated string.",
      example: "[\"tutorial\", \"guide\", \"howto\"] or \"tutorial,guide,howto\"",
      n8nField: "YouTube Tags",
      icon: Hash
    },
    {
      name: "youtube_category_id",
      type: "string",
      required: false,
      default: "22",
      description: "YouTube category ID for the video. Common categories: 1 (Film & Animation), 10 (Music), 15 (Pets & Animals), 17 (Sports), 20 (Gaming), 22 (People & Blogs), 23 (Comedy), 24 (Entertainment), 25 (News & Politics), 26 (Howto & Style), 27 (Education), 28 (Science & Technology)",
      example: "22",
      n8nField: "YouTube Category ID",
      icon: Layers
    },
    {
      name: "youtube_privacy_status",
      type: "string",
      required: false,
      default: "public",
      description: "Privacy status of the video. Controls who can view the video.",
      options: ["public", "private", "unlisted"],
      n8nField: "YouTube Privacy Status",
      icon: Lock
    },
    {
      name: "youtube_embeddable",
      type: "boolean",
      required: false,
      default: true,
      description: "Whether the video can be embedded on other websites.",
      n8nField: "YouTube Embeddable",
      icon: LinkIcon
    },
    {
      name: "youtube_license",
      type: "string",
      required: false,
      default: "youtube",
      description: "License type for the video.",
      options: ["youtube (Standard YouTube License)", "creativeCommon (Creative Commons)"],
      n8nField: "YouTube License",
      icon: Shield
    },
    {
      name: "youtube_public_stats_viewable",
      type: "boolean",
      required: false,
      default: true,
      description: "Whether the extended video statistics (like count, dislike count) are publicly viewable.",
      n8nField: "YouTube Public Stats Viewable",
      icon: Eye
    },
    {
      name: "youtube_thumbnail",
      type: "string",
      required: false,
      description: "Custom thumbnail URL or file path. Recommended size: 1280x720 pixels.",
      example: "https://example.com/thumbnail.jpg",
      n8nField: "YouTube Thumbnail (File or URL)",
      icon: Image
    },
    {
      name: "youtube_made_for_kids",
      type: "boolean",
      required: false,
      default: false,
      description: "Indicates whether the video is made for children. Required by COPPA regulations.",
      n8nField: "YouTube Self Declared Made For Kids",
      icon: Users
    },
    {
      name: "youtube_contains_synthetic_media",
      type: "boolean",
      required: false,
      default: false,
      description: "Whether the video contains AI-generated or synthetic media that appears realistic.",
      n8nField: "YouTube Contains Synthetic Media",
      icon: AlertCircle
    },
    {
      name: "youtube_default_language",
      type: "string",
      required: false,
      description: "The default language of the video's title and description.",
      example: "en, es, fr, de",
      n8nField: "YouTube Default Language",
      icon: Languages
    },
    {
      name: "youtube_default_audio_language",
      type: "string",
      required: false,
      description: "The default audio language of the video.",
      example: "en, es, fr, de",
      n8nField: "YouTube Default Audio Language",
      icon: Music
    },
    {
      name: "youtube_allowed_countries",
      type: "array | string",
      required: false,
      description: "List of country codes where the video is allowed. Uses ISO 3166-1 alpha-2 codes.",
      example: "[\"US\", \"CA\", \"GB\"] or \"US,CA,GB\"",
      n8nField: "YouTube Allowed Countries",
      icon: MapPin
    },
    {
      name: "youtube_blocked_countries",
      type: "array | string",
      required: false,
      description: "List of country codes where the video is blocked. Uses ISO 3166-1 alpha-2 codes.",
      example: "[\"CN\", \"RU\"] or \"CN,RU\"",
      n8nField: "YouTube Blocked Countries",
      icon: MapPin
    },
    {
      name: "youtube_has_paid_product_placement",
      type: "boolean",
      required: false,
      default: false,
      description: "Whether the video contains paid product placement or endorsements.",
      n8nField: "YouTube Has Paid Product Placement",
      icon: AlertCircle
    },
    {
      name: "youtube_recording_date",
      type: "string",
      required: false,
      description: "The date the video was recorded. ISO 8601 format.",
      example: "2026-01-10T00:00:00Z",
      n8nField: "YouTube Recording Date",
      icon: Calendar
    },
    {
      name: "youtube_first_comment",
      type: "string",
      required: false,
      description: "First comment to post automatically after video is published. Will be posted as a pinned comment by the channel owner.",
      example: "Thanks for watching! Let me know your thoughts in the comments!",
      n8nField: "YouTube First Comment",
      maxLength: 10000,
      icon: MessageSquare
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
      example: "Europe/Madrid, America/New_York",
      n8nField: "Timezone",
      icon: Globe
    },
    {
      name: "poll_interval",
      type: "number",
      required: false,
      default: 10,
      description: "Interval in seconds to poll for upload status.",
      n8nField: "Poll Interval (Seconds)",
      icon: Clock
    },
    {
      name: "timeout",
      type: "number",
      required: false,
      default: 600,
      description: "Maximum time in seconds to wait for upload to complete.",
      n8nField: "Timeout (Seconds)",
      icon: Clock
    }
  ];

  const categoryList = [
    { id: "1", name: "Film & Animation" },
    { id: "2", name: "Autos & Vehicles" },
    { id: "10", name: "Music" },
    { id: "15", name: "Pets & Animals" },
    { id: "17", name: "Sports" },
    { id: "18", name: "Short Movies" },
    { id: "19", name: "Travel & Events" },
    { id: "20", name: "Gaming" },
    { id: "21", name: "Videoblogging" },
    { id: "22", name: "People & Blogs" },
    { id: "23", name: "Comedy" },
    { id: "24", name: "Entertainment" },
    { id: "25", name: "News & Politics" },
    { id: "26", name: "Howto & Style" },
    { id: "27", name: "Education" },
    { id: "28", name: "Science & Technology" },
    { id: "29", name: "Nonprofits & Activism" },
    { id: "30", name: "Movies" },
    { id: "31", name: "Anime/Animation" },
    { id: "32", name: "Action/Adventure" },
    { id: "33", name: "Classics" },
    { id: "34", name: "Comedy" },
    { id: "35", name: "Documentary" },
    { id: "36", name: "Drama" },
    { id: "37", name: "Family" },
    { id: "38", name: "Foreign" },
    { id: "39", name: "Horror" },
    { id: "40", name: "Sci-Fi/Fantasy" },
    { id: "41", name: "Thriller" },
    { id: "42", name: "Shorts" },
    { id: "43", name: "Shows" },
    { id: "44", name: "Trailers" }
  ];

  return (
    <div className="min-h-screen bg-background">
      <DocPageHeader
        isAuthenticated={!!user}
        title="YouTube API"
        subtitle="Complete guide to uploading videos via the Postora API"
        icon={Youtube}
        variant="rose"
        headingPreset="amber-rose-violet"
        ctaGradient="from-rose-500 via-red-500 to-orange-500"
        badges={[
          { label: "Video Upload", icon: Video },
          { label: "Custom Thumbnails", icon: Image },
          { label: "Privacy Controls", icon: Lock },
          { label: "Geo-Restrictions", icon: MapPin },
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
            <CardDescription>Get your first YouTube video uploaded in 3 minutes</CardDescription>
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
                <p className="font-medium">Get your YouTube Channel ID</p>
                <p className="text-sm text-muted-foreground">Run the accounts endpoint to find your YouTube channel name</p>
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
                <code className="text-xs bg-muted px-2 py-1 rounded block mb-2">["youtube", "tiktok"]</code>
                <code className="text-xs bg-muted px-2 py-1 rounded block">["channel_id_1", "channel_id_2"]</code>
              </div>
              <div className="p-4 rounded-lg bg-background border">
                <h4 className="font-medium mb-2">Comma-Separated Format</h4>
                <code className="text-xs bg-muted px-2 py-1 rounded block mb-2">youtube,tiktok</code>
                <code className="text-xs bg-muted px-2 py-1 rounded block">channel_id_1,channel_id_2</code>
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
              <p className="text-sm"><strong>Video Format:</strong> YouTube supports MP4, MOV, AVI, WMV, FLV, 3GPP, MPEG4, WebM, and MPEGPS formats.</p>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-green-500 mt-0.5 flex-shrink-0" />
              <p className="text-sm"><strong>File Size:</strong> Maximum file size is 256GB or 12 hours of video, whichever is less.</p>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-green-500 mt-0.5 flex-shrink-0" />
              <p className="text-sm"><strong>Shorts:</strong> For YouTube Shorts, use vertical videos (9:16 aspect ratio) under 60 seconds and include #shorts in the title or description.</p>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-green-500 mt-0.5 flex-shrink-0" />
              <p className="text-sm"><strong>Thumbnail:</strong> Recommended thumbnail size is 1280x720 pixels (16:9 aspect ratio).</p>
            </div>
            <div className="flex items-start gap-2">
              <Info className="w-4 h-4 text-blue-500 mt-0.5 flex-shrink-0" />
              <p className="text-sm"><strong>COPPA Compliance:</strong> You must correctly set the "Made for Kids" field for all videos.</p>
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
              <TabsTrigger value="shorts">Shorts</TabsTrigger>
              <TabsTrigger value="private">Private</TabsTrigger>
              <TabsTrigger value="scheduled">Scheduled</TabsTrigger>
              <TabsTrigger value="geo">Geo-Restricted</TabsTrigger>
            </TabsList>
            <TabsContent value="basic">
              <CodeBlock code={curlJsonBasicVideo} language="bash" id="json-basic" title="Basic video upload" />
            </TabsContent>
            <TabsContent value="all-fields">
              <CodeBlock code={curlJsonWithAllFields} language="bash" id="json-all" title="Video with all fields" />
            </TabsContent>
            <TabsContent value="shorts">
              <CodeBlock code={curlJsonShort} language="bash" id="json-shorts" title="YouTube Shorts upload" />
            </TabsContent>
            <TabsContent value="private">
              <CodeBlock code={curlJsonPrivate} language="bash" id="json-private" title="Private video" />
            </TabsContent>
            <TabsContent value="scheduled">
              <CodeBlock code={curlJsonScheduled} language="bash" id="json-scheduled" title="Scheduled video" />
            </TabsContent>
            <TabsContent value="geo">
              <CodeBlock code={curlJsonWithGeoRestrictions} language="bash" id="json-geo" title="Geo-restricted video" />
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
            Upload videos directly using multipart/form-data
          </p>

          <Tabs defaultValue="basic-form" className="w-full">
            <TabsList className="grid w-full grid-cols-2 lg:grid-cols-4 mb-4">
              <TabsTrigger value="basic-form">Basic</TabsTrigger>
              <TabsTrigger value="file-form">File Upload</TabsTrigger>
              <TabsTrigger value="thumb-form">With Thumbnail</TabsTrigger>
              <TabsTrigger value="all-form">All Fields</TabsTrigger>
            </TabsList>
            <TabsContent value="basic-form">
              <CodeBlock code={curlFormBasicVideo} language="bash" id="form-basic" title="Basic video upload" />
            </TabsContent>
            <TabsContent value="file-form">
              <CodeBlock code={curlFormWithFile} language="bash" id="form-file" title="Direct file upload" />
            </TabsContent>
            <TabsContent value="thumb-form">
              <CodeBlock code={curlFormWithThumbnail} language="bash" id="form-thumb" title="Video with custom thumbnail" />
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

        {/* YouTube Categories */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
            <Layers className="w-6 h-6" />
            YouTube Category IDs
          </h2>
          <Card>
            <CardContent className="pt-6">
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                {categoryList.map((cat) => (
                  <div key={cat.id} className="flex items-center gap-2 text-sm">
                    <code className="bg-muted px-2 py-0.5 rounded text-xs font-mono">{cat.id}</code>
                    <span className="text-muted-foreground">{cat.name}</span>
                  </div>
                ))}
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
    "youtube": {
      "success": true,
      "video_id": "dQw4w9WgXcQ",
      "video_url": "https://youtube.com/watch?v=dQw4w9WgXcQ",
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
    "youtube": {
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
  "message": "The video file is too large or in an unsupported format",
  "details": {
    "platform": "youtube",
    "error_code": "VIDEO_FORMAT_ERROR",
    "supported_formats": ["MP4", "MOV", "AVI", "WMV", "WebM"]
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
              <CardDescription>Configure n8n to upload YouTube videos automatically</CardDescription>
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
                <div className="grid grid-cols-3 gap-4 items-center">
                  <span className="text-sm font-medium">Poll Interval</span>
                  <span className="col-span-2 text-sm text-muted-foreground">10 seconds (default)</span>
                </div>
                <div className="grid grid-cols-3 gap-4 items-center">
                  <span className="text-sm font-medium">Timeout</span>
                  <span className="col-span-2 text-sm text-muted-foreground">600 seconds (10 minutes)</span>
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
          <Link to="/docs/pinterest-api" className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4" />
            Pinterest API
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
