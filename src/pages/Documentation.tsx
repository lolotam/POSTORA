import { useState } from "react";
import { Link } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { PlatformIcon, getPlatformName, ExtendedPlatform } from "@/components/PlatformIcon";
import { 
  DocsHeader, DocsHero, DocsSidebar, CodeBlock, ParamTable, SectionTitle, SubSection,
  docsNavItems, supportedPlatforms, platformDescriptions, quickstartSteps, 
  apiEndpoints, featureCards, aiFeatures, httpStatusCodes, faqItems
} from "@/components/docs";
import { IntroFeatureGrid } from "@/components/docs/sections/IntroFeatureGrid";
import { EndpointCard } from "@/components/docs/sections/EndpointCard";
import { Callout } from "@/components/docs/sections/Callout";
import { Reveal, GradientRingCard, Icon3D } from "@/components/fx";
import {
  ExternalLink, Globe, Shield, Hash, Clock, Image, Sparkles, HelpCircle
} from "lucide-react";
import { cn } from "@/lib/utils";
import { McpConnectionPanel } from "@/components/mcp/McpConnectionPanel";

const API_BASE = "https://api.postora.cloud/functions/v1/n8n-api";

export default function Documentation() {
  const [activeSection, setActiveSection] = useState("introduction");

  return (
    <div className="min-h-screen bg-background">
      <DocsHeader breadcrumbs={[{ label: "Docs" }]} />

      <DocsHero
        title="Postora API"
        description="Complete API documentation for posting content to multiple social media platforms with AI-powered features."
        badge="API Documentation"
        platforms={[...supportedPlatforms]}
        variant="violet"
      />

      {/* Main Content */}
      <div className="container mx-auto px-6 py-12">
        <div className="grid lg:grid-cols-[260px_1fr] gap-12">
          <DocsSidebar 
            navItems={docsNavItems} 
            activeSection={activeSection} 
            onSectionClick={setActiveSection} 
          />

          {/* Content */}
          <div className="space-y-16 max-w-4xl min-w-0">
            {/* Introduction */}
            <Reveal>
              <section id="introduction">
                <SectionTitle id="intro-title">Introduction</SectionTitle>
                <p className="text-muted-foreground mb-6">
                  Postora provides a powerful REST API for uploading and managing content across multiple social media platforms.
                  With a single API call, you can post videos, photos, and text to Instagram, Facebook, TikTok, Twitter/X, LinkedIn, YouTube, Pinterest, Threads, Bluesky, and Reddit.
                </p>
                <IntroFeatureGrid features={featureCards} />

                <SubSection id="supported-platforms">Supported Platforms</SubSection>
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {supportedPlatforms.map((platform) => (
                    <GradientRingCard
                      key={platform}
                      variant="sky"
                      ringIntensity="subtle"
                      hoverLift={false}
                      innerClassName="p-4"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl ring-1 ring-border flex items-center justify-center shrink-0 bg-muted">
                          <PlatformIcon platform={platform} size="md" />
                        </div>
                        <div>
                          <h4 className="font-semibold">{getPlatformName(platform)}</h4>
                          <p className="text-xs text-muted-foreground">{platformDescriptions[platform]}</p>
                        </div>
                      </div>
                    </GradientRingCard>
                  ))}
                </div>
              </section>
            </Reveal>

            {/* Quickstart */}
            <Reveal delay={60}>
            <section id="quickstart">
              <SectionTitle id="qs-title">Quickstart Guide</SectionTitle>
              <p className="text-muted-foreground mb-6">Get started with the Postora API in minutes:</p>

              <div className="space-y-6">
                {quickstartSteps.map(s => (
                  <div key={s.step} className="flex gap-4 items-start">
                    <div className="relative shrink-0">
                      <div className="relative w-10 h-10 rounded-full ring-1 ring-white/30 flex items-center justify-center shadow-lg bg-neutral-900 dark:bg-neutral-800">
                        <span className="text-white font-bold tabular-nums">{s.step}</span>
                      </div>
                    </div>
                    <div className="flex-1 rounded-2xl border border-border/60 bg-card p-4">
                      <h3 className="font-semibold mb-1">{s.title}</h3>
                      <p className="text-sm text-muted-foreground mb-3">{s.desc}</p>
                      {s.link.startsWith('http') ? (
                        <a href={s.link} target="_blank" rel="noopener noreferrer">
                          <Button variant="outline" size="sm" className="rounded-full gap-2">
                            {s.linkText}<ExternalLink className="w-3 h-3" />
                          </Button>
                        </a>
                      ) : (
                        <Link to={s.link}>
                          <Button variant="outline" size="sm" className="rounded-full gap-2">
                            {s.linkText}<ExternalLink className="w-3 h-3" />
                          </Button>
                        </Link>
                      )}
                    </div>
                  </div>
                ))}

                <div className="flex gap-4 items-start">
                  <div className="relative shrink-0">
                    <div className="relative w-10 h-10 rounded-full ring-1 ring-white/30 flex items-center justify-center shadow-lg bg-neutral-900 dark:bg-neutral-800">
                      <span className="text-white font-bold tabular-nums">4</span>
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold mb-2">Make Your First API Call</h3>
                    <CodeBlock id="first-call" language="bash" code={`curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Authorization: Apikey YOUR_API_KEY" \\
  -F "caption=My post! 🎉" \\
  -F "platforms=facebook" \\
  -F "platforms=instagram" \\
  -F "media_file_ids=257a8fab-2f0c-4de0-9c84-11be6b97b36f" \\
  -F "account_ids=abc123-facebook-account-id" \\
  -F "account_ids=ghi789-instagram-account-id"`} />
                  </div>
                </div>
              </div>
            </section>
            </Reveal>

            {/* Authentication */}
            <Reveal delay={60}>
            <section id="authentication">
              <SectionTitle id="auth-title">Authentication</SectionTitle>
              <p className="text-muted-foreground mb-4">
                All API requests require authentication. You can use either <code className="px-1.5 py-0.5 rounded bg-secondary text-sm">x-api-key</code> or <code className="px-1.5 py-0.5 rounded bg-secondary text-sm">Authorization</code> header:
              </p>

              <SubSection id="auth-formats">Supported Header Formats</SubSection>
              <ParamTable params={[
                { name: "x-api-key", type: "Just the key", required: true, desc: "postora-2f4a5bed-d2b2-4cc9-bb45-83013eaa4e3e" },
                { name: "Authorization", type: "Just the key", required: true, desc: "postora-2f4a5bed-d2b2-4cc9-bb45-83013eaa4e3e" },
                { name: "Authorization", type: "With Apikey prefix", required: true, desc: "Apikey postora-2f4a5bed-..." },
                { name: "Authorization", type: "Bearer style", required: true, desc: "Bearer postora-2f4a5bed-..." },
              ]} />

              <div className="space-y-3 mb-4">
                <Callout tone="info" title="For n8n setup">
                  Use <code className="px-1.5 py-0.5 rounded bg-secondary text-xs">Authorization</code> header with your API key directly (no prefix needed).
                </Callout>
                <Callout tone="warning" title="Security Note">
                  Keep your API key secret. Never expose it in client-side code or public repositories.
                </Callout>
              </div>

              <SubSection id="auth-best">Security Best Practices</SubSection>
              <ul className="list-disc list-inside text-muted-foreground space-y-2">
                <li>Store API keys in environment variables</li>
                <li>Rotate keys periodically (regenerate from API Keys page)</li>
                <li>Use HTTPS for all API requests</li>
                <li>Monitor your API usage for anomalies</li>
              </ul>
            </section>
            </Reveal>

            {/* API Reference */}
            <Reveal delay={60}>
            <section id="api-reference">
              <SectionTitle id="ref-title">API Reference</SectionTitle>
              <p className="text-muted-foreground mb-4">Complete list of available API endpoints:</p>
              <p className="text-sm text-muted-foreground mb-6">
                <span className="font-bold text-foreground">Base URL: </span>
                <code className="font-mono text-sm bg-muted px-2 py-1 rounded">https://api.postora.cloud/functions/v1/n8n-api</code>
                <span className="text-muted-foreground">{" "}+ endpoint path below</span>
              </p>

              <div className="space-y-4">
                {apiEndpoints.map((ep, i) => (
                  <EndpointCard key={i} method={ep.method} path={ep.path} desc={ep.desc} />
                ))}
              </div>
            </section>
            </Reveal>

            {/* MCP Reference */}
            <Reveal delay={60}>
            <section id="mcp-reference">
              <SectionTitle id="mcp-title">MCP Reference</SectionTitle>
              <p className="text-muted-foreground mb-4">
                Postora ships a <strong>Model Context Protocol</strong> server so AI agents (Claude, Cursor, ChatGPT, n8n AI nodes, custom LLM apps) can post, schedule, upload media, and manage webhooks on your behalf — using the same API key as the REST API.
              </p>
              <p className="text-sm text-muted-foreground mb-6">
                Use MCP when an AI agent should drive Postora end-to-end. Use the REST API above for scripted automations and backend integrations.
              </p>
              <McpConnectionPanel />
            </section>
            </Reveal>

            {/* Create Post */}
            <Reveal delay={60}>
            <section id="create-post">
              <SectionTitle id="post-title">Create Post</SectionTitle>
              <p className="text-muted-foreground mb-4">Create and publish posts to multiple platforms with a single API call.</p>

              <div className="mb-4">
                <EndpointCard method="POST" path="/api/v1/post" />
              </div>

              <Tabs defaultValue="curl" className="mb-6">
                <TabsList><TabsTrigger value="curl">cURL</TabsTrigger><TabsTrigger value="js">JavaScript</TabsTrigger><TabsTrigger value="python">Python</TabsTrigger></TabsList>
                <TabsContent value="curl">
                  <CodeBlock id="post-curl" language="bash" code={`curl -X POST \\
  ${API_BASE}/api/v1/post \\
  -H 'x-api-key: YOUR_API_KEY' \\
  -H 'Content-Type: application/json' \\
  -d '{
    "caption": "Check out our new product! 🎉",
    "platforms": ["instagram", "facebook", "twitter"],
    "media_ids": ["media-id-1"],
    "scheduled_at": "2026-01-15T10:00:00Z"
  }'`} />
                </TabsContent>
                <TabsContent value="js">
                  <CodeBlock id="post-js" language="javascript" code={`const response = await fetch(
  '${API_BASE}/api/v1/post',
  {
    method: 'POST',
    headers: {
      'x-api-key': 'YOUR_API_KEY',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      caption: 'Check out our new product! 🎉',
      platforms: ['instagram', 'facebook', 'twitter'],
      media_ids: ['media-id-1'],
      scheduled_at: '2026-01-15T10:00:00Z',
    }),
  }
);
const result = await response.json();`} />
                </TabsContent>
                <TabsContent value="python">
                  <CodeBlock id="post-py" language="python" code={`import requests

response = requests.post(
    '${API_BASE}/api/v1/post',
    headers={
        'x-api-key': 'YOUR_API_KEY',
        'Content-Type': 'application/json',
    },
    json={
        'caption': 'Check out our new product! 🎉',
        'platforms': ['instagram', 'facebook', 'twitter'],
        'media_ids': ['media-id-1'],
        'scheduled_at': '2026-01-15T10:00:00Z',
    }
)
print(response.json())`} />
                </TabsContent>
              </Tabs>

              <SubSection id="post-params">Request Parameters</SubSection>
              <ParamTable params={[
                { name: "caption", type: "string", required: false, desc: "Post caption/text content" },
                { name: "platforms", type: "string[]", required: true, desc: "Target platforms (instagram, facebook, tiktok, twitter, linkedin, youtube, pinterest, threads, bluesky, reddit)" },
                { name: "media_ids", type: "string[]", required: false, desc: "IDs of previously uploaded media" },
                { name: "media_urls", type: "string[]", required: false, desc: "URLs of media to include" },
                { name: "media_base64", type: "string | string[]", required: false, desc: "Base64 encoded media with data URI prefix (e.g., data:image/jpeg;base64,...). Alternative to media_urls for direct file upload. Supports multiple files as an array." },
                { name: "scheduled_at", type: "string", required: false, desc: "ISO 8601 timestamp for scheduling" },
                { name: "first_comment", type: "string", required: false, desc: "First comment to add after posting" },
              ]} />
            </section>
            </Reveal>

            {/* Upload Media */}
            <Reveal delay={60}>
            <section id="upload-media">
              <SectionTitle id="media-title">Upload Media</SectionTitle>
              <p className="text-muted-foreground mb-4">
                Upload images and videos to use in your posts. Supports JSON body, Form-Data, URLs, and Base64 encoding.
              </p>

              <div className="mb-4">
                <EndpointCard method="POST" path="/api/v1/upload-media" />
              </div>

              <div className="space-y-4 mb-6">
                <Callout tone="info" title="Supported URL Sources">
                  Upload from any publicly accessible URL: Google Drive, Dropbox, AWS S3, or any direct file URL.
                </Callout>
                <Callout tone="success" title="API File Validation">
                  <div className="grid sm:grid-cols-2 gap-4 mt-2">
                    <div>
                      <p className="font-medium text-foreground mb-1">Videos</p>
                      <ul className="space-y-1">
                        <li>• Max size: 500MB (API limit)</li>
                        <li>• Formats: MP4, MOV, WebM, MPEG, AVI</li>
                      </ul>
                    </div>
                    <div>
                      <p className="font-medium text-foreground mb-1">Images</p>
                      <ul className="space-y-1">
                        <li>• Max size: 20MB (API limit)</li>
                        <li>• Formats: JPEG, PNG, GIF, WebP</li>
                      </ul>
                    </div>
                  </div>
                </Callout>
              </div>

              <Tabs defaultValue="url" className="mb-6">
                <TabsList><TabsTrigger value="url">Using URL</TabsTrigger><TabsTrigger value="form">Form-Data</TabsTrigger><TabsTrigger value="base64">Base64</TabsTrigger></TabsList>
                <TabsContent value="url">
                  <CodeBlock id="upload-json-url" language="bash" code={`curl -X POST \\
  ${API_BASE}/api/v1/upload-media \\
  -H 'x-api-key: YOUR_API_KEY' \\
  -H 'Content-Type: application/json' \\
  -d '{
    "media_url": "https://example.com/video.mp4",
    "file_type": "video"
  }'`} />
                </TabsContent>
                <TabsContent value="form">
                  <CodeBlock id="upload-form-single" language="bash" code={`curl -X POST \\
  ${API_BASE}/api/v1/upload-media \\
  -H 'x-api-key: YOUR_API_KEY' \\
  -F 'file=@/path/to/video.mp4' \\
  -F 'file_type=video'`} />
                </TabsContent>
                <TabsContent value="base64">
                  <CodeBlock id="upload-json-base64" language="bash" code={`curl -X POST \\
  ${API_BASE}/api/v1/upload-media \\
  -H 'x-api-key: YOUR_API_KEY' \\
  -H 'Content-Type: application/json' \\
  -d '{
    "file_data": "data:image/jpeg;base64,/9j/4AAQSkZJRg...",
    "file_name": "my-image.jpg",
    "file_type": "image"
  }'`} />
                </TabsContent>
              </Tabs>

              <SubSection id="media-params">Request Parameters</SubSection>
              <ParamTable params={[
                { name: "file", type: "file", required: false, desc: "Binary file upload (Form-Data only)" },
                { name: "media_url", type: "string", required: false, desc: "URL of media file to download" },
                { name: "file_data", type: "string", required: false, desc: "Base64 encoded file with data URI prefix" },
                { name: "file_type", type: "string", required: false, desc: "'image' or 'video' (auto-detected if not provided)" },
              ]} />
            </section>
            </Reveal>

            {/* Platforms */}
            <Reveal delay={60}>
            <section id="platforms">
              <SectionTitle id="plat-title">Platform-Specific Settings</SectionTitle>
              <p className="text-muted-foreground mb-6">Each platform has unique settings and requirements:</p>

              <Accordion type="single" collapsible className="w-full">
                <AccordionItem value="instagram">
                  <AccordionTrigger className="text-start"><div className="flex items-center gap-3"><PlatformIcon platform="instagram" size="sm" />Instagram</div></AccordionTrigger>
                  <AccordionContent>
                    <ul className="list-disc list-inside text-muted-foreground space-y-1 text-sm">
                      <li>Supports photos, carousels (up to 10 images), and Reels</li>
                      <li>Caption limit: 2,200 characters</li>
                      <li>Add collaborators with <code className="text-xs bg-secondary px-1 rounded">instagram_collaborators</code></li>
                    </ul>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="tiktok">
                  <AccordionTrigger className="text-start"><div className="flex items-center gap-3"><PlatformIcon platform="tiktok" size="sm" />TikTok</div></AccordionTrigger>
                  <AccordionContent>
                    <ul className="list-disc list-inside text-muted-foreground space-y-1 text-sm">
                      <li>Videos and photo carousels</li>
                      <li>Caption limit: 4,000 characters</li>
                      <li>Post modes: DIRECT_POST or MEDIA_UPLOAD (draft)</li>
                    </ul>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="youtube">
                  <AccordionTrigger className="text-start"><div className="flex items-center gap-3"><PlatformIcon platform="youtube" size="sm" />YouTube</div></AccordionTrigger>
                  <AccordionContent>
                    <ul className="list-disc list-inside text-muted-foreground space-y-1 text-sm">
                      <li>Supports Videos and YouTube Shorts</li>
                      <li>Privacy: public, unlisted, private</li>
                      <li>Add custom thumbnails</li>
                    </ul>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="threads">
                  <AccordionTrigger className="text-start"><div className="flex items-center gap-3"><PlatformIcon platform="threads" size="sm" />Threads</div></AccordionTrigger>
                  <AccordionContent>
                    <ul className="list-disc list-inside text-muted-foreground space-y-1 text-sm">
                      <li>Text posts with up to 500 characters</li>
                      <li>Images and videos supported</li>
                      <li>Reply control settings available</li>
                    </ul>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="bluesky">
                  <AccordionTrigger className="text-start"><div className="flex items-center gap-3"><PlatformIcon platform="bluesky" size="sm" />Bluesky</div></AccordionTrigger>
                  <AccordionContent>
                    <ul className="list-disc list-inside text-muted-foreground space-y-1 text-sm">
                      <li>Posts up to 300 characters</li>
                      <li>Up to 4 images per post</li>
                      <li>Video support up to 60 seconds</li>
                    </ul>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="reddit">
                  <AccordionTrigger className="text-start"><div className="flex items-center gap-3"><PlatformIcon platform="reddit" size="sm" />Reddit</div></AccordionTrigger>
                  <AccordionContent>
                    <ul className="list-disc list-inside text-muted-foreground space-y-1 text-sm">
                      <li>Text, link, and image posts</li>
                      <li>Requires subreddit selection</li>
                      <li>Flair support available</li>
                    </ul>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </section>
            </Reveal>

            {/* AI Features */}
            <Reveal delay={60}>
            <section id="ai-features">
              <SectionTitle id="ai-title">AI Features</SectionTitle>
              <p className="text-muted-foreground mb-6">Postora includes powerful AI features to enhance your content creation:</p>

              <div className="grid sm:grid-cols-2 gap-6">
                {[
                  { icon: Sparkles, title: "Caption Generation", desc: "Generate engaging captions using Google's Gemini AI.", features: ["Platform-optimized content", "Multiple tone options", "Emoji suggestions"] },
                  { icon: Hash, title: "Hashtag Suggestions", desc: "AI-powered hashtag recommendations based on your content.", features: ["Trending hashtags", "Niche-specific tags", "Platform optimization"] },
                  { icon: Image, title: "Image Generation", desc: "Create stunning images with AI from text prompts.", features: ["Multiple aspect ratios", "Reference image support", "HD quality"] },
                  { icon: Clock, title: "Best Time Suggestions", desc: "Optimal posting time recommendations.", features: ["Platform-specific timing", "Engagement optimization", "Audience analysis"] },
                ].map((f, i) => {
                  const variants = ["violet", "emerald", "sky", "amber"] as const;
                  const variant = variants[i % variants.length];
                  return (
                    <GradientRingCard key={i} variant={variant} ringIntensity="subtle" innerClassName="p-6">
                      <div className="group flex flex-col gap-3">
                        <Icon3D icon={f.icon} variant={variant} size="sm" />
                        <h3 className="font-semibold">{f.title}</h3>
                        <p className="text-sm text-muted-foreground">{f.desc}</p>
                        <ul className="text-sm text-muted-foreground space-y-1">
                          {f.features.map((feat, j) => <li key={j}>• {feat}</li>)}
                        </ul>
                      </div>
                    </GradientRingCard>
                  );
                })}
              </div>
            </section>
            </Reveal>

            {/* Scheduling */}
            <Reveal delay={60}>
            <section id="scheduling">
              <SectionTitle id="sched-title">Scheduling</SectionTitle>
              <p className="text-muted-foreground mb-4">Schedule posts for future publishing by including the <code className="text-xs bg-secondary px-1.5 py-0.5 rounded">scheduled_at</code> parameter:</p>

              <CodeBlock id="schedule-ex" language="json" code={`{
  "caption": "Scheduled post example",
  "platforms": ["instagram"],
  "scheduled_at": "2026-01-15T10:00:00+03:00"
}`} />

              <div className="mt-4">
                <Callout tone="info" title="Note">
                  Use ISO 8601 format with timezone. View scheduled posts in the Calendar page.
                </Callout>
              </div>
            </section>
            </Reveal>

            {/* Error Handling */}
            <Reveal delay={60}>
            <section id="error-handling">
              <SectionTitle id="err-title">Error Handling</SectionTitle>
              <p className="text-muted-foreground mb-4">API responses include per-platform results:</p>

              <CodeBlock id="err-resp" language="json" code={`{
  "success": true,
  "results": {
    "instagram": { "success": true, "post_id": "123..." },
    "facebook": { "success": true, "post_id": "456..." },
    "linkedin": { "success": false, "error": "Session expired" }
  }
}`} />

              <SubSection id="http-codes">HTTP Status Codes</SubSection>
              <div className="grid sm:grid-cols-2 gap-2">
                {httpStatusCodes.map((c, i) => {
                  const code = parseInt(c.code, 10);
                  const tone =
                    code >= 500 ? "rose" : code >= 400 ? "amber" : "emerald";
                  const cls =
                    tone === "emerald"
                      ? "bg-emerald-500/10 border-emerald-400/40 text-emerald-700 dark:text-emerald-300"
                      : tone === "amber"
                        ? "bg-amber-500/10 border-amber-400/40 text-amber-700 dark:text-amber-300"
                        : "bg-rose-500/10 border-rose-400/40 text-rose-700 dark:text-rose-300";
                  return (
                    <div
                      key={i}
                      className={cn(
                        "flex items-center gap-3 px-3 py-2 rounded-lg border",
                        cls,
                      )}
                    >
                      <code className="font-mono font-bold tabular-nums text-sm">{c.code}</code>
                      <span className="text-sm text-muted-foreground">{c.desc}</span>
                    </div>
                  );
                })}
              </div>
            </section>
            </Reveal>

            {/* FAQ */}
            <Reveal delay={60}>
            <section id="faq">
              <SectionTitle id="faq-title">Frequently Asked Questions</SectionTitle>
              <Accordion type="single" collapsible className="w-full rounded-2xl border border-border/60 bg-card px-4">
                {faqItems.map((item, i) => (
                  <AccordionItem key={i} value={`faq-${i}`} className="border-border/40">
                    <AccordionTrigger className="text-start hover:text-foreground dark:hover:text-neutral-200">
                      <span className="flex items-center gap-2">
                        <HelpCircle className="w-4 h-4 text-foreground" />
                        {item.q}
                      </span>
                    </AccordionTrigger>
                    <AccordionContent><p className="text-muted-foreground">{item.a}</p></AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </section>
            </Reveal>
          </div>
        </div>
      </div>
    </div>
  );
}
