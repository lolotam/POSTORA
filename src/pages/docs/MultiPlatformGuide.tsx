import { useState } from "react";
import { Link } from "react-router-dom";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/useAuth";
import { PlatformIcon, ExtendedPlatform } from "@/components/PlatformIcon";
import {
  ArrowLeft, Copy, Check, Share2, Image, Video,
  MessageSquare, FileText, AlertCircle,
  CheckCircle2, Info, Calendar, Globe, Zap, Layers, Users,
  ChevronRight, Workflow, Target, Clock, Lightbulb, AlertTriangle
} from "lucide-react";
import { cn } from "@/lib/utils";

const API_BASE = "https://api.postora.cloud/functions/v1/n8n-api";

export default function MultiPlatformGuide() {
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const { user } = useAuth();

  const copyCode = async (code: string, id: string) => {
    await navigator.clipboard.writeText(code);
    setCopiedCode(id);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  const CodeBlock = ({ code, language, id, title }: { code: string; language: string; id: string; title?: string }) => (
    <div className="relative group rounded-xl bg-[#0d1117] border border-[#30363d] overflow-hidden my-4">
      <div className="flex items-center justify-between px-4 py-2 border-b border-[#30363d] bg-[#161b22]">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400 font-mono">{language}</span>
          {title && <span className="text-xs text-gray-500">• {title}</span>}
        </div>
        <Button variant="ghost" size="sm" onClick={() => copyCode(code, id)} className="h-7 text-xs text-gray-300 hover:text-white hover:bg-white/10">
          {copiedCode === id ? <Check className="w-3 h-3 me-1" /> : <Copy className="w-3 h-3 me-1" />}
          {copiedCode === id ? "Copied!" : "Copy"}
        </Button>
      </div>
      <pre className="p-4 overflow-x-auto text-sm"><code className="text-gray-200">{code}</code></pre>
    </div>
  );

  // Cross-posting examples
  const curlBasicCrossPost = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "platforms": ["instagram", "facebook", "twitter"],
    "account_ids": ["instagram-account-id", "facebook-page-id", "twitter-account-id"],
    "caption": "Exciting news! Check out our latest update 🚀",
    "media_urls": "https://example.com/announcement.jpg"
  }'`;

  const curlWithPlatformSettings = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "platforms": ["instagram", "facebook", "linkedin", "twitter"],
    "account_ids": ["ig-id", "fb-page-id", "li-id", "x-id"],
    "caption": "We are thrilled to announce our new product! 🎉",
    "media_urls": "https://example.com/product-launch.jpg",
    
    "instagram_media_type": "feed",
    "instagram_first_comment": "#launch #newproduct #announcement",
    
    "facebook_media_type": null,
    
    "linkedin_visibility": "PUBLIC",
    "linkedin_allow_comments": true,
    
    "twitter_reply_settings": "everyone",
    
    "first_comment": "Link in bio for more details!"
  }'`;

  const curlVideoCrossPost = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_video",
    "platforms": ["youtube", "tiktok", "instagram"],
    "account_ids": ["yt-channel-id", "tiktok-id", "ig-id"],
    "title": "Amazing Tutorial - Watch Now! 🎬",
    "caption": "Learn something new today! #tutorial #howto",
    "media_urls": "https://example.com/tutorial-video.mp4",
    
    "youtube_privacy_status": "public",
    "youtube_category_id": "22",
    "youtube_tags": ["tutorial", "howto", "guide"],
    "youtube_made_for_kids": false,
    
    "tiktok_privacy_level": "PUBLIC_TO_EVERYONE",
    "tiktok_disable_comment": false,
    
    "instagram_media_type": "feed"
  }'`;

  const curlScheduledCrossPost = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "platforms": ["instagram", "facebook", "pinterest", "linkedin"],
    "account_ids": ["ig-id", "fb-id", "pinterest-id", "li-id"],
    "caption": "Coming soon! Mark your calendars 📅",
    "media_urls": "https://example.com/teaser.jpg",
    "scheduled_date": "2026-02-01T09:00:00Z",
    "timezone": "America/New_York",
    
    "pinterest_board_id": "board-id-here",
    "pinterest_link": "https://yoursite.com/launch"
  }'`;

  const curlCommaSeparated = `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "operation": "upload_photos",
    "platforms": "instagram,facebook,twitter",
    "account_ids": "17841478425635377,942626662258010,12345678",
    "caption": "Using comma-separated format! 🎯",
    "media_urls": "https://example.com/image.jpg"
  }'`;

  const curlN8nDynamicValues = `// In n8n HTTP Request node body:
{
  "operation": "upload_photos",
  "platforms": ["{{ $json.platform1 }}", "{{ $json.platform2 }}"],
  "account_ids": ["{{ $json.account1 }}", "{{ $json.account2 }}"],
  "caption": "{{ $json.captionText }}",
  "media_urls": [
    "{{ $json.images[0].url }}",
    "{{ $json.images[1].url }}"
  ]
}

// Or using comma-separated format:
{
  "operation": "upload_photos",
  "platforms": "{{ $json.platformList }}",
  "account_ids": "{{ $json.accountList }}",
  "caption": "{{ $json.captionText }}",
  "media_urls": "{{ $json.imageUrl }}"
}`;

  const platformCombinations: { platforms: ExtendedPlatform[]; description: string; useCase: string }[] = [
    {
      platforms: ["instagram", "facebook"],
      description: "Meta ecosystem - shared media library",
      useCase: "Most common combo for visual content"
    },
    {
      platforms: ["twitter", "linkedin"],
      description: "Professional & news updates",
      useCase: "B2B announcements, thought leadership"
    },
    {
      platforms: ["youtube", "tiktok"],
      description: "Short-form video platforms",
      useCase: "Repurpose vertical videos across platforms"
    },
    {
      platforms: ["instagram", "pinterest"],
      description: "Visual discovery platforms",
      useCase: "Product showcases, lifestyle content"
    },
    {
      platforms: ["instagram", "facebook", "twitter", "linkedin"],
      description: "Full social presence",
      useCase: "Major announcements, brand campaigns"
    }
  ];

  const bestPractices = [
    {
      icon: Target,
      title: "Tailor Captions per Platform",
      description: "Use platform-specific fields like instagram_first_comment for hashtags, keeping main caption clean."
    },
    {
      icon: Clock,
      title: "Schedule for Peak Times",
      description: "Use different scheduled times per platform based on when your audience is most active."
    },
    {
      icon: Image,
      title: "Optimize Media Dimensions",
      description: "Use 1:1 for Instagram feed, 9:16 for TikTok/Reels, 16:9 for YouTube/Twitter."
    },
    {
      icon: Lightbulb,
      title: "Platform-Specific Features",
      description: "Leverage unique features: Instagram collaborators, TikTok duets, Pinterest links, etc."
    },
    {
      icon: Users,
      title: "Use Account IDs Consistently",
      description: "Store account IDs and reference them - supports internal UUID, platform_user_id, or user_identifier."
    },
    {
      icon: Workflow,
      title: "Handle Failures Gracefully",
      description: "Each platform posts independently - if one fails, others still succeed. Check per-platform results."
    }
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-border bg-background">
        <div className="container mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 sm:gap-4 min-w-0">
            <Link to="/" className="shrink-0"><Logo /></Link>
            <span className="text-muted-foreground max-sm:hidden">/</span>
            <Link to="/docs" className="text-muted-foreground hover:text-foreground max-sm:hidden">Docs</Link>
            <span className="text-muted-foreground">/</span>
            <span className="font-medium flex items-center gap-2 min-w-0">
              <Share2 className="w-4 h-4 shrink-0 text-primary" />
              <span className="truncate">Multi-Platform Guide</span>
            </span>
          </div>
          <div className="flex items-center gap-4 shrink-0">
            {user ? (
              <Link to="/dashboard"><Button variant="gradient">Dashboard</Button></Link>
            ) : (
              <Link to="/auth"><Button variant="gradient">Get Started</Button></Link>
            )}
          </div>
        </div>
      </header>

      <main className="container mx-auto px-6 py-12 max-w-5xl">
        {/* Back link */}
        <Link to="/n8n" className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground mb-8 transition-colors">
          <ArrowLeft className="w-4 h-4" />
          Back to n8n Integration
        </Link>

        {/* Hero */}
        <div className="mb-12">
          <div className="flex items-center gap-4 mb-4">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center bg-primary">
              <Share2 className="w-8 h-8 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-4xl font-bold">Multi-Platform Posting Guide</h1>
              <p className="text-muted-foreground">Post to multiple social platforms with a single API call</p>
            </div>
          </div>
          
          <div className="flex flex-wrap gap-2 mt-6">
            <Badge variant="secondary" className="gap-1"><Layers className="w-3 h-3" /> Cross-Posting</Badge>
            <Badge variant="secondary" className="gap-1"><Zap className="w-3 h-3" /> One API Call</Badge>
            <Badge variant="secondary" className="gap-1"><Calendar className="w-3 h-3" /> Scheduling</Badge>
            <Badge variant="secondary" className="gap-1"><Target className="w-3 h-3" /> Platform-Specific</Badge>
          </div>
        </div>

        {/* Overview */}
        <Card className="mb-8 border-primary/20 bg-primary/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-primary" />
              How It Works
            </CardTitle>
            <CardDescription>Post once, publish everywhere</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">1</div>
              <div>
                <p className="font-medium">Specify Multiple Platforms</p>
                <p className="text-sm text-muted-foreground">Include all target platforms in the <code className="px-1 bg-muted rounded">platforms</code> array</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">2</div>
              <div>
                <p className="font-medium">Provide Account IDs</p>
                <p className="text-sm text-muted-foreground">Include corresponding <code className="px-1 bg-muted rounded">account_ids</code> for each platform</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">3</div>
              <div>
                <p className="font-medium">Add Platform-Specific Settings</p>
                <p className="text-sm text-muted-foreground">Optionally include fields like <code className="px-1 bg-muted rounded">instagram_first_comment</code>, <code className="px-1 bg-muted rounded">tiktok_privacy_level</code>, etc.</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">4</div>
              <div>
                <p className="font-medium">Send One Request</p>
                <p className="text-sm text-muted-foreground">The API handles posting to all platforms and returns per-platform results</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Array Format Card */}
        <Card className="mb-8 border-green-500/20 bg-green-500/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-green-500" />
              Supported Array Formats
            </CardTitle>
            <CardDescription>Multiple formats for platforms, account_ids, and media_urls fields</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div className="p-4 rounded-lg bg-background border">
                <h4 className="font-medium mb-2 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-green-500" />
                  JSON Array Format
                </h4>
                <code className="text-xs bg-muted px-2 py-1 rounded block mb-2">["instagram", "facebook", "twitter"]</code>
                <code className="text-xs bg-muted px-2 py-1 rounded block">["17841478425635377", "942626662258010"]</code>
                <p className="text-xs text-muted-foreground mt-2">Best for n8n with dynamic values</p>
              </div>
              <div className="p-4 rounded-lg bg-background border">
                <h4 className="font-medium mb-2 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-green-500" />
                  Comma-Separated Format
                </h4>
                <code className="text-xs bg-muted px-2 py-1 rounded block mb-2">instagram,facebook,twitter</code>
                <code className="text-xs bg-muted px-2 py-1 rounded block">17841478425635377,942626662258010</code>
                <p className="text-xs text-muted-foreground mt-2">Simple and easy to construct</p>
              </div>
            </div>
            <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 mb-3">
              <p className="text-sm flex items-start gap-2">
                <Zap className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
                <span><strong>n8n Tip:</strong> Both formats work in HTTP Request body fields. String JSON arrays like <code className="px-1 bg-muted rounded text-xs">{`'["instagram", "facebook"]'`}</code> are also automatically parsed.</span>
              </p>
            </div>
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 mb-3">
              <p className="text-sm flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
                <span><strong>Strict Field Naming:</strong> Only <code className="px-1 bg-muted rounded text-xs">account_ids</code> or <code className="px-1 bg-muted rounded text-xs">ACCOUNT_IDS</code> are accepted. Any other variant (account_id, id, social_account_id, etc.) will return a <strong>400 error</strong>.</span>
              </p>
            </div>
            <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <p className="text-sm flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
                <span><strong>⚠️ Large IDs:</strong> Always send numeric IDs as <strong>strings</strong> (e.g., <code className="px-1 bg-muted rounded text-xs">"34767551309502570"</code>). Numbers exceeding JavaScript's safe integer limit (9007199254740991) will lose precision.</span>
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Popular Combinations */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-6">Popular Platform Combinations</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {platformCombinations.map((combo, index) => (
              <Card key={index} className="hover:border-primary/50 transition-colors">
                <CardContent className="pt-6">
                  <div className="flex items-center gap-2 mb-3">
                    {combo.platforms.map((platform) => (
                      <div key={platform} className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center">
                        <PlatformIcon platform={platform} className="w-4 h-4" />
                      </div>
                    ))}
                  </div>
                  <p className="font-medium text-sm">{combo.description}</p>
                  <p className="text-xs text-muted-foreground mt-1">{combo.useCase}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* Code Examples */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-6">Cross-Posting Examples</h2>
          
          <Tabs defaultValue="basic" className="w-full">
            <TabsList className="grid w-full grid-cols-3 lg:grid-cols-6 h-auto gap-1">
              <TabsTrigger value="basic" className="text-xs">Basic</TabsTrigger>
              <TabsTrigger value="settings" className="text-xs">With Settings</TabsTrigger>
              <TabsTrigger value="video" className="text-xs">Video</TabsTrigger>
              <TabsTrigger value="scheduled" className="text-xs">Scheduled</TabsTrigger>
              <TabsTrigger value="comma" className="text-xs">Comma Format</TabsTrigger>
              <TabsTrigger value="n8n" className="text-xs">n8n Dynamic</TabsTrigger>
            </TabsList>

            <TabsContent value="basic" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Layers className="w-5 h-5" />
                    Basic Cross-Platform Post
                  </CardTitle>
                  <CardDescription>Post the same content to Instagram, Facebook, and Twitter</CardDescription>
                </CardHeader>
                <CardContent>
                  <CodeBlock code={curlBasicCrossPost} language="bash" id="basic-cross" />
                  <div className="mt-4 p-4 rounded-lg bg-muted/50">
                    <h4 className="font-medium mb-2 flex items-center gap-2">
                      <Info className="w-4 h-4 text-blue-500" />
                      What happens:
                    </h4>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      <li>• Downloads media from URL once</li>
                      <li>• Creates posts on all 3 platforms</li>
                      <li>• Returns per-platform results (success/failure)</li>
                      <li>• Uses same caption for all platforms</li>
                    </ul>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="settings" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Target className="w-5 h-5 text-foreground" />
                    Cross-Post with Platform Settings
                  </CardTitle>
                  <CardDescription>Customize settings for each platform</CardDescription>
                </CardHeader>
                <CardContent>
                  <CodeBlock code={curlWithPlatformSettings} language="bash" id="settings-cross" />
                  <div className="mt-4 p-4 rounded-lg bg-muted border border-border">
                    <h4 className="font-medium mb-2 flex items-center gap-2 text-foreground">
                      <Lightbulb className="w-4 h-4" />
                      Platform-Specific Fields:
                    </h4>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      <li>• <code className="px-1 bg-muted rounded">instagram_first_comment</code> - Keep hashtags separate</li>
                      <li>• <code className="px-1 bg-muted rounded">linkedin_visibility</code> - Control audience</li>
                      <li>• <code className="px-1 bg-muted rounded">twitter_reply_settings</code> - Manage replies</li>
                      <li>• <code className="px-1 bg-muted rounded">first_comment</code> - Applied to all platforms</li>
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
                    Video Cross-Platform Post
                  </CardTitle>
                  <CardDescription>Share video across YouTube, TikTok, and Instagram</CardDescription>
                </CardHeader>
                <CardContent>
                  <CodeBlock code={curlVideoCrossPost} language="bash" id="video-cross" />
                  <div className="mt-4 p-4 rounded-lg bg-red-500/10 border border-red-500/20">
                    <h4 className="font-medium mb-2 flex items-center gap-2 text-red-600">
                      <AlertCircle className="w-4 h-4" />
                      Video Considerations:
                    </h4>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      <li>• Same video file is used for all platforms</li>
                      <li>• YouTube requires title; TikTok/Instagram use caption</li>
                      <li>• Consider aspect ratios: 16:9 for YouTube, 9:16 for TikTok/Reels</li>
                      <li>• Video duration limits vary by platform</li>
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
                    Scheduled Cross-Platform Post
                  </CardTitle>
                  <CardDescription>Schedule posts for multiple platforms at once</CardDescription>
                </CardHeader>
                <CardContent>
                  <CodeBlock code={curlScheduledCrossPost} language="bash" id="scheduled-cross" />
                  <div className="mt-4 p-4 rounded-lg bg-blue-500/10 border border-blue-500/20">
                    <h4 className="font-medium mb-2 flex items-center gap-2 text-blue-600">
                      <Clock className="w-4 h-4" />
                      Scheduling Notes:
                    </h4>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      <li>• All platforms will post at the same scheduled time</li>
                      <li>• Use ISO 8601 format: 2026-02-01T09:00:00Z</li>
                      <li>• Specify timezone for accurate local time</li>
                      <li>• Posts are processed every minute by the scheduler</li>
                    </ul>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="comma" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <FileText className="w-5 h-5 text-green-500" />
                    Comma-Separated Format
                  </CardTitle>
                  <CardDescription>Simpler format for platforms and account_ids</CardDescription>
                </CardHeader>
                <CardContent>
                  <CodeBlock code={curlCommaSeparated} language="bash" id="comma-cross" />
                  <div className="mt-4 p-4 rounded-lg bg-green-500/10 border border-green-500/20">
                    <h4 className="font-medium mb-2 flex items-center gap-2 text-green-600">
                      <CheckCircle2 className="w-4 h-4" />
                      When to use comma format:
                    </h4>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      <li>• Quick testing and simple workflows</li>
                      <li>• When values are static/hardcoded</li>
                      <li>• Easier to type in curl commands</li>
                      <li>• Works identically to JSON array format</li>
                    </ul>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="n8n" className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Workflow className="w-5 h-5 text-orange-500" />
                    n8n Dynamic Values
                  </CardTitle>
                  <CardDescription>Using expressions in n8n HTTP Request node</CardDescription>
                </CardHeader>
                <CardContent>
                  <CodeBlock code={curlN8nDynamicValues} language="json" id="n8n-dynamic" />
                  <div className="mt-4 p-4 rounded-lg bg-orange-500/10 border border-orange-500/20">
                    <h4 className="font-medium mb-2 flex items-center gap-2 text-orange-600">
                      <Zap className="w-4 h-4" />
                      n8n Integration Tips:
                    </h4>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      <li>• Use expressions like <code className="px-1 bg-muted rounded">{`{{ $json.fieldName }}`}</code></li>
                      <li>• Arrays work with bracket notation: <code className="px-1 bg-muted rounded">{`{{ $json.images[0].url }}`}</code></li>
                      <li>• Both JSON array and comma-separated formats are supported</li>
                      <li>• String JSON arrays are automatically parsed</li>
                    </ul>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </section>

        {/* Best Practices */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-6">Best Practices</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {bestPractices.map((practice, index) => (
              <Card key={index}>
                <CardContent className="pt-6">
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                      <practice.icon className="w-5 h-5 text-primary" />
                    </div>
                    <div>
                      <h4 className="font-medium">{practice.title}</h4>
                      <p className="text-sm text-muted-foreground mt-1">{practice.description}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* Platform Limitations */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-6">Platform-Specific Limitations</h2>
          
          <Card className="border-amber-500/30 bg-amber-500/5">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-amber-500" />
                Important: Carousel & Multi-Image Support
              </CardTitle>
              <CardDescription>Not all platforms support carousels through API</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Pinterest Limitation */}
              <div className="p-4 rounded-lg bg-background border">
                <div className="flex items-center gap-3 mb-2">
                  <PlatformIcon platform="pinterest" className="w-5 h-5" />
                  <h4 className="font-medium">Pinterest: No Carousel Support</h4>
                </div>
                <p className="text-sm text-muted-foreground mb-2">
                  Pinterest's standard API does not support carousel pins. When you provide multiple images:
                </p>
                <ul className="text-sm text-muted-foreground space-y-1 ms-4 list-disc">
                  <li>Each image creates a <strong>separate pin</strong> on the same board</li>
                  <li>Pins get numbered titles: "My Post (1/3)", "My Post (2/3)", etc.</li>
                  <li>All pins share the same description, link, and settings</li>
                  <li>A 500ms delay is applied between pins to avoid rate limits</li>
                </ul>
                <div className="mt-3 p-2 bg-amber-500/10 rounded text-xs text-amber-700 dark:text-amber-300">
                  <strong>Carousel Alternative:</strong> Carousel pins are only available through Pinterest Ads API (paid) or manual creation on Pinterest's web interface.
                </div>
              </div>

              {/* Platform Comparison Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-start py-2 pe-4">Platform</th>
                      <th className="text-center py-2 px-4">Single Image</th>
                      <th className="text-center py-2 px-4">Carousel/Multi</th>
                      <th className="text-center py-2 px-4">Video</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b">
                      <td className="py-2 pe-4 flex items-center gap-2"><PlatformIcon platform="instagram" size="sm" /> Instagram</td>
                      <td className="text-center py-2 px-4"><CheckCircle2 className="w-4 h-4 text-green-500 mx-auto" /></td>
                      <td className="text-center py-2 px-4"><CheckCircle2 className="w-4 h-4 text-green-500 mx-auto" /></td>
                      <td className="text-center py-2 px-4"><CheckCircle2 className="w-4 h-4 text-green-500 mx-auto" /></td>
                    </tr>
                    <tr className="border-b">
                      <td className="py-2 pe-4 flex items-center gap-2"><PlatformIcon platform="facebook" size="sm" /> Facebook</td>
                      <td className="text-center py-2 px-4"><CheckCircle2 className="w-4 h-4 text-green-500 mx-auto" /></td>
                      <td className="text-center py-2 px-4"><CheckCircle2 className="w-4 h-4 text-green-500 mx-auto" /></td>
                      <td className="text-center py-2 px-4"><CheckCircle2 className="w-4 h-4 text-green-500 mx-auto" /></td>
                    </tr>
                    <tr className="border-b">
                      <td className="py-2 pe-4 flex items-center gap-2"><PlatformIcon platform="twitter" size="sm" /> Twitter/X</td>
                      <td className="text-center py-2 px-4"><CheckCircle2 className="w-4 h-4 text-green-500 mx-auto" /></td>
                      <td className="text-center py-2 px-4"><CheckCircle2 className="w-4 h-4 text-green-500 mx-auto" /></td>
                      <td className="text-center py-2 px-4"><CheckCircle2 className="w-4 h-4 text-green-500 mx-auto" /></td>
                    </tr>
                    <tr className="border-b">
                      <td className="py-2 pe-4 flex items-center gap-2"><PlatformIcon platform="linkedin" size="sm" /> LinkedIn</td>
                      <td className="text-center py-2 px-4"><CheckCircle2 className="w-4 h-4 text-green-500 mx-auto" /></td>
                      <td className="text-center py-2 px-4"><CheckCircle2 className="w-4 h-4 text-green-500 mx-auto" /></td>
                      <td className="text-center py-2 px-4"><CheckCircle2 className="w-4 h-4 text-green-500 mx-auto" /></td>
                    </tr>
                    <tr className="border-b">
                      <td className="py-2 pe-4 flex items-center gap-2"><PlatformIcon platform="pinterest" size="sm" /> Pinterest</td>
                      <td className="text-center py-2 px-4"><CheckCircle2 className="w-4 h-4 text-green-500 mx-auto" /></td>
                      <td className="text-center py-2 px-4"><span className="text-xs text-amber-500">Separate pins</span></td>
                      <td className="text-center py-2 px-4"><CheckCircle2 className="w-4 h-4 text-green-500 mx-auto" /></td>
                    </tr>
                    <tr className="border-b">
                      <td className="py-2 pe-4 flex items-center gap-2"><PlatformIcon platform="tiktok" size="sm" /> TikTok</td>
                      <td className="text-center py-2 px-4"><span className="text-xs text-muted-foreground">Limited</span></td>
                      <td className="text-center py-2 px-4"><span className="text-xs text-muted-foreground">—</span></td>
                      <td className="text-center py-2 px-4"><CheckCircle2 className="w-4 h-4 text-green-500 mx-auto" /></td>
                    </tr>
                    <tr>
                      <td className="py-2 pe-4 flex items-center gap-2"><PlatformIcon platform="youtube" size="sm" /> YouTube</td>
                      <td className="text-center py-2 px-4"><span className="text-xs text-muted-foreground">—</span></td>
                      <td className="text-center py-2 px-4"><span className="text-xs text-muted-foreground">—</span></td>
                      <td className="text-center py-2 px-4"><CheckCircle2 className="w-4 h-4 text-green-500 mx-auto" /></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* Response Handling */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-6">Response Handling</h2>
          <Card>
            <CardHeader>
              <CardTitle>Understanding Multi-Platform Responses</CardTitle>
              <CardDescription>Each platform returns its own status independently</CardDescription>
            </CardHeader>
            <CardContent>
              <CodeBlock 
                code={`{
  "success": true,
  "message": "Post created successfully",
  "post_id": "abc123-def456",
  "platforms": {
    "instagram": {
      "success": true,
      "platform_post_id": "17841478425635377"
    },
    "facebook": {
      "success": true,
      "platform_post_id": "942626662258010"
    },
    "twitter": {
      "success": false,
      "error": "Rate limit exceeded"
    }
  }
}`}
                language="json"
                id="response-example"
              />
              <div className="mt-4 p-4 rounded-lg bg-amber-500/10 border border-amber-500/20">
                <h4 className="font-medium mb-2 flex items-center gap-2 text-amber-600">
                  <AlertTriangle className="w-4 h-4" />
                  Important:
                </h4>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>• Overall <code className="px-1 bg-muted rounded">success: true</code> means at least one platform succeeded</li>
                  <li>• Check individual platform results for failures</li>
                  <li>• Failed platforms can be retried separately</li>
                  <li>• Use webhooks for async status updates on scheduled posts</li>
                </ul>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* Quick Links */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-6">Platform-Specific Documentation</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { platform: "instagram" as ExtendedPlatform, link: "/docs/instagram-api" },
              { platform: "facebook" as ExtendedPlatform, link: "/docs/facebook-api" },
              { platform: "twitter" as ExtendedPlatform, link: "/docs/twitter-api" },
              { platform: "linkedin" as ExtendedPlatform, link: "/docs/linkedin-api" },
              { platform: "youtube" as ExtendedPlatform, link: "/docs/youtube-api" },
              { platform: "tiktok" as ExtendedPlatform, link: "/docs/tiktok-api" },
              { platform: "pinterest" as ExtendedPlatform, link: "/docs/pinterest-api" },
            ].map((item) => (
              <Link key={item.platform} to={item.link}>
                <Card className="hover:border-primary/50 transition-colors cursor-pointer">
                  <CardContent className="pt-6 flex items-center gap-3">
                    <PlatformIcon platform={item.platform} className="w-6 h-6" />
                    <span className="font-medium capitalize">{item.platform}</span>
                    <ChevronRight className="w-4 h-4 ms-auto text-muted-foreground" />
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
