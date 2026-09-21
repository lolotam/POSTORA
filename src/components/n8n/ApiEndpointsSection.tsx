import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CodeBlock } from "@/components/docs";
import { Zap, Wand2, Code2 } from "lucide-react";
import { Icon3D, GradientHeading, Reveal } from "@/components/fx";

const API_BASE = "https://api.postora.cloud/functions/v1";

const bodyFields = [
  { name: "caption", type: "string", value: "My post caption! 🎉" },
  { name: "platforms", type: "array", value: '["instagram", "facebook", "tiktok"]' },
  { name: "media_file_ids", type: "array", value: '["uuid-from-upload"]' },
  { name: "media_base64", type: "string|array", value: '["data:image/jpeg;base64,..."]' },
  { name: "scheduled_at", type: "string|null", value: "2026-01-15T10:00:00Z" },
];

const postJsonExample = `{
  "caption": "Check out our latest update! 🚀 #socialmedia #automation",
  "platforms": ["instagram", "facebook", "tiktok", "youtube"],
  "media_file_ids": ["{{ $json.media_file.id }}"],
  "scheduled_at": null,
  
  "youtube_privacy": "public",
  "youtube_title": "My Video Title",
  "youtube_description": "Full video description here",
  "youtube_tags": ["tag1", "tag2", "tag3"],
  
  "tiktok_post_mode": "DIRECT_POST",
  "tiktok_allow_comments": true,
  "tiktok_allow_duet": true,
  "tiktok_allow_stitch": true,
  
  "instagram_collaborators": ["username1", "username2"],
  "instagram_share_to_feed": true,
  
  "pinterest_board_id": "your-board-id",
  "pinterest_title": "Pin Title",
  "pinterest_link": "https://yourwebsite.com"
}`;

const webhookRegisterExample = `{
  "webhook_url": "https://your-n8n-instance.com/webhook/postora",
  "events": ["post.completed", "post.failed", "post.published"]
}`;

const webhookTestExample = `{
  "webhook_url": "https://your-n8n-instance.com/webhook/postora"
}`;

// Background Removal curl examples
const bgRemovalJsonCurl = `curl -X POST \\
  "${API_BASE}/remove-background" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "image_url": "https://example.com/image.jpg"
  }'

# Or with base64:
curl -X POST \\
  "${API_BASE}/remove-background" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "image_base64": "iVBORw0KGgoAAAANSUhEUgAA..."
  }'`;

const bgRemovalFormDataCurl = `curl -X POST \\
  "${API_BASE}/remove-background" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "file=@/path/to/your/image.jpg"

# Or with URL in form-data:
curl -X POST \\
  "${API_BASE}/remove-background" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "image_url=https://example.com/image.jpg"`;

const bgRemovalResponse = `{
  "success": true,
  "original_url": "https://example.com/image.jpg",
  "processed_url": "https://res.cloudinary.com/.../e_background_removal/...",
  "public_id": "postora/user-id/processed/abc123",
  "width": 1920,
  "height": 1080,
  "format": "png",
  "bytes": 245678
}`;

// Upscale curl examples - Cloudinary
const upscaleJsonCurl = `# Cloudinary Upscaling (default)
curl -X POST \\
  "${API_BASE}/upscale-image" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "image_url": "https://example.com/image.jpg",
    "scale": 2,
    "platform": "cloudinary"
  }'

# Or with base64:
curl -X POST \\
  "${API_BASE}/upscale-image" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "image_base64": "iVBORw0KGgoAAAANSUhEUgAA...",
    "scale": 4,
    "platform": "cloudinary"
  }'`;

const upscaleFormDataCurl = `curl -X POST \\
  "${API_BASE}/upscale-image" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "file=@/path/to/your/image.jpg" \\
  -F "scale=2" \\
  -F "platform=cloudinary"

# Or with URL in form-data:
curl -X POST \\
  "${API_BASE}/upscale-image" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "image_url=https://example.com/image.jpg" \\
  -F "scale=4" \\
  -F "platform=cloudinary"`;

// AtlasCloud 4K Upscale examples
const upscaleAtlasJsonCurl = `# AtlasCloud 4K Upscaling (premium)
curl -X POST \\
  "${API_BASE}/upscale-image" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "image_url": "https://example.com/image.jpg",
    "platform": "atlascloud",
    "scale": 4
  }'`;

const upscaleAtlasFormDataCurl = `# AtlasCloud via form-data
curl -X POST \\
  "${API_BASE}/upscale-image" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "image_url=https://example.com/image.jpg" \\
  -F "platform=atlascloud" \\
  -F "scale=4"`;

const upscaleResponse = `{
  "success": true,
  "original_url": "https://example.com/image.jpg",
  "upscaled_url": "https://res.cloudinary.com/.../e_upscale,w_3840,h_2160/...",
  "enhanced_url": "https://res.cloudinary.com/.../e_improve,e_sharpen/...",
  "public_id": "postora/user-id/upscaled/abc123",
  "original_width": 1920,
  "original_height": 1080,
  "upscaled_width": 3840,
  "upscaled_height": 2160,
  "scale": 2,
  "platform": "cloudinary",
  "format": "jpg"
}`;

const upscaleAtlasResponse = `{
  "success": true,
  "original_url": "https://example.com/image.jpg",
  "upscaled_url": "https://storage.atlascloud.ai/outputs/...",
  "prediction_id": "pred_abc123",
  "target_resolution": "4k",
  "scale": 4,
  "platform": "atlascloud"
}`;

export function ApiEndpointsSection() {
  return (
    <section className="container mx-auto px-6 py-20 border-t border-border/40">
      <Reveal className="text-center mb-12">
        <div className="flex flex-col items-center gap-4">
          <Icon3D icon={Code2} variant="cyan" size="md" />
          <GradientHeading as="h2" preset="emerald-cyan-sky" size="lg">API Endpoints</GradientHeading>
        </div>
      </Reveal>
      
      <div className="max-w-4xl mx-auto space-y-8">
        {/* Upload Media */}
        <Card className="p-6 bg-card/50">
          <div className="flex items-center gap-3 mb-4">
            <span className="px-3 py-1 rounded text-sm font-mono bg-emerald-500/20 text-emerald-500">POST</span>
            <code className="font-mono">/api/v1/upload-media</code>
          </div>
          <p className="text-muted-foreground mb-4">Upload images or videos to use in your posts</p>
          
          <h4 className="font-semibold mb-2">n8n HTTP Request Node Settings:</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border border-border rounded-lg">
              <tbody>
                <tr className="border-b border-border">
                  <td className="py-2 px-4 font-medium bg-secondary/30">Method</td>
                  <td className="py-2 px-4"><code>POST</code></td>
                </tr>
                <tr className="border-b border-border">
                  <td className="py-2 px-4 font-medium bg-secondary/30">URL</td>
                  <td className="py-2 px-4"><code className="text-xs">{API_BASE}/n8n-api/api/v1/upload-media</code></td>
                </tr>
                <tr className="border-b border-border">
                  <td className="py-2 px-4 font-medium bg-secondary/30">Headers</td>
                  <td className="py-2 px-4"><code>x-api-key: YOUR_API_KEY</code></td>
                </tr>
                <tr>
                  <td className="py-2 px-4 font-medium bg-secondary/30">Body</td>
                  <td className="py-2 px-4">Form-Data with <code>file</code> field (binary)</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>

        {/* Create Post */}
        <Card className="p-6 bg-card/50">
          <div className="flex items-center gap-3 mb-4">
            <span className="px-3 py-1 rounded text-sm font-mono bg-emerald-500/20 text-emerald-500">POST</span>
            <code className="font-mono">/api/v1/post</code>
          </div>
          <p className="text-muted-foreground mb-4">Create and publish posts to multiple platforms</p>

          <Tabs defaultValue="json" className="mb-4">
            <TabsList>
              <TabsTrigger value="json">JSON Body</TabsTrigger>
              <TabsTrigger value="fields">Body Fields</TabsTrigger>
            </TabsList>
            
            <TabsContent value="json">
              <CodeBlock id="post-json" language="json" code={postJsonExample} />
            </TabsContent>
            
            <TabsContent value="fields">
              <div className="overflow-x-auto my-4">
                <table className="w-full text-sm border border-border rounded-lg">
                  <thead className="bg-secondary/50">
                    <tr>
                      <th className="text-start py-3 px-4">Field</th>
                      <th className="text-start py-3 px-4">Type</th>
                      <th className="text-start py-3 px-4">Example Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bodyFields.map((row, i) => (
                      <tr key={i} className="border-t border-border">
                        <td className="py-2 px-4 font-mono text-primary text-xs">{row.name}</td>
                        <td className="py-2 px-4 text-muted-foreground">{row.type}</td>
                        <td className="py-2 px-4 font-mono text-xs">{row.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </TabsContent>
          </Tabs>
        </Card>

        {/* Get Accounts */}
        <Card className="p-6 bg-card/50">
          <div className="flex items-center gap-3 mb-4">
            <span className="px-3 py-1 rounded text-sm font-mono bg-primary/20 text-primary">GET</span>
            <code className="font-mono">/api/v1/accounts</code>
          </div>
          <p className="text-muted-foreground">List all connected social media accounts</p>
        </Card>

        {/* Get Posts */}
        <Card className="p-6 bg-card/50">
          <div className="flex items-center gap-3 mb-4">
            <span className="px-3 py-1 rounded text-sm font-mono bg-primary/20 text-primary">GET</span>
            <code className="font-mono">/api/v1/posts</code>
          </div>
          <p className="text-muted-foreground mb-2">Get post history with optional filters</p>
          <p className="text-sm text-muted-foreground">Query params: <code>?limit=50&offset=0&status=published</code></p>
        </Card>

        {/* AI Image Processing Section */}
        <div className="col-span-full mt-8 mb-4">
          <h3 className="text-xl font-bold flex items-center gap-2">
            <Wand2 className="w-5 h-5 text-violet-500" />
            AI Image Processing Endpoints
          </h3>
          <p className="text-muted-foreground mt-1">Process images with AI-powered background removal and upscaling</p>
        </div>

        {/* Remove Background */}
        <Card className="p-6 bg-card/50 border-violet-500/20">
          <div className="flex items-center gap-3 mb-4">
            <span className="px-3 py-1 rounded text-sm font-mono bg-emerald-500/20 text-emerald-500">POST</span>
            <code className="font-mono">/remove-background</code>
          </div>
          <p className="text-muted-foreground mb-4">Remove background from images using AI</p>

          <Tabs defaultValue="json" className="mb-4">
            <TabsList>
              <TabsTrigger value="json">JSON Body (cURL)</TabsTrigger>
              <TabsTrigger value="formdata">Form-Data (cURL)</TabsTrigger>
              <TabsTrigger value="response">Response</TabsTrigger>
            </TabsList>
            
            <TabsContent value="json">
              <CodeBlock id="bg-removal-json" language="bash" code={bgRemovalJsonCurl} />
            </TabsContent>
            
            <TabsContent value="formdata">
              <CodeBlock id="bg-removal-formdata" language="bash" code={bgRemovalFormDataCurl} />
            </TabsContent>

            <TabsContent value="response">
              <CodeBlock id="bg-removal-response" language="json" code={bgRemovalResponse} />
            </TabsContent>
          </Tabs>

          <div className="overflow-x-auto mt-4">
            <table className="w-full text-sm border border-border rounded-lg">
              <thead className="bg-secondary/50">
                <tr>
                  <th className="text-start py-3 px-4">Parameter</th>
                  <th className="text-start py-3 px-4">Type</th>
                  <th className="text-start py-3 px-4">Description</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-border">
                  <td className="py-2 px-4 font-mono text-primary text-xs">image_url</td>
                  <td className="py-2 px-4 text-muted-foreground">string</td>
                  <td className="py-2 px-4">URL of the image to process</td>
                </tr>
                <tr className="border-t border-border">
                  <td className="py-2 px-4 font-mono text-primary text-xs">image_base64</td>
                  <td className="py-2 px-4 text-muted-foreground">string</td>
                  <td className="py-2 px-4">Base64 encoded image data</td>
                </tr>
                <tr className="border-t border-border">
                  <td className="py-2 px-4 font-mono text-primary text-xs">file</td>
                  <td className="py-2 px-4 text-muted-foreground">binary</td>
                  <td className="py-2 px-4">Image file (form-data upload)</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>

        {/* Upscale Image */}
        <Card className="p-6 bg-card/50 border-emerald-500/20">
          <div className="flex items-center gap-3 mb-4">
            <span className="px-3 py-1 rounded text-sm font-mono bg-emerald-500/20 text-emerald-500">POST</span>
            <code className="font-mono">/upscale-image</code>
          </div>
          <p className="text-muted-foreground mb-4">Upscale images using AI - choose between Cloudinary (2x-4x) or AtlasCloud (4K premium)</p>

          <Tabs defaultValue="cloudinary-json" className="mb-4">
            <TabsList className="flex-wrap h-auto">
              <TabsTrigger value="cloudinary-json">Cloudinary JSON</TabsTrigger>
              <TabsTrigger value="cloudinary-form">Cloudinary Form</TabsTrigger>
              <TabsTrigger value="atlas-json">AtlasCloud 4K</TabsTrigger>
              <TabsTrigger value="atlas-form">AtlasCloud Form</TabsTrigger>
              <TabsTrigger value="response">Response</TabsTrigger>
            </TabsList>
            
            <TabsContent value="cloudinary-json">
              <CodeBlock id="upscale-cloudinary-json" language="bash" code={upscaleJsonCurl} />
            </TabsContent>
            
            <TabsContent value="cloudinary-form">
              <CodeBlock id="upscale-cloudinary-formdata" language="bash" code={upscaleFormDataCurl} />
            </TabsContent>

            <TabsContent value="atlas-json">
              <CodeBlock id="upscale-atlas-json" language="bash" code={upscaleAtlasJsonCurl} />
            </TabsContent>

            <TabsContent value="atlas-form">
              <CodeBlock id="upscale-atlas-formdata" language="bash" code={upscaleAtlasFormDataCurl} />
            </TabsContent>

            <TabsContent value="response">
              <div className="space-y-4">
                <div>
                  <p className="text-xs text-muted-foreground mb-2">Cloudinary Response:</p>
                  <CodeBlock id="upscale-response" language="json" code={upscaleResponse} />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-2">AtlasCloud Response:</p>
                  <CodeBlock id="upscale-atlas-response" language="json" code={upscaleAtlasResponse} />
                </div>
              </div>
            </TabsContent>
          </Tabs>

          <div className="overflow-x-auto mt-4">
            <table className="w-full text-sm border border-border rounded-lg">
              <thead className="bg-secondary/50">
                <tr>
                  <th className="text-start py-3 px-4">Parameter</th>
                  <th className="text-start py-3 px-4">Type</th>
                  <th className="text-start py-3 px-4">Description</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-border">
                  <td className="py-2 px-4 font-mono text-primary text-xs">image_url</td>
                  <td className="py-2 px-4 text-muted-foreground">string</td>
                  <td className="py-2 px-4">URL of the image to upscale</td>
                </tr>
                <tr className="border-t border-border">
                  <td className="py-2 px-4 font-mono text-primary text-xs">image_base64</td>
                  <td className="py-2 px-4 text-muted-foreground">string</td>
                  <td className="py-2 px-4">Base64 encoded image data (Cloudinary only)</td>
                </tr>
                <tr className="border-t border-border">
                  <td className="py-2 px-4 font-mono text-primary text-xs">file</td>
                  <td className="py-2 px-4 text-muted-foreground">binary</td>
                  <td className="py-2 px-4">Image file (form-data upload, Cloudinary only)</td>
                </tr>
                <tr className="border-t border-border">
                  <td className="py-2 px-4 font-mono text-primary text-xs">scale</td>
                  <td className="py-2 px-4 text-muted-foreground">number</td>
                  <td className="py-2 px-4">Upscale factor: 1-4 (default: 2)</td>
                </tr>
                <tr className="border-t border-border bg-purple-500/5">
                  <td className="py-2 px-4 font-mono text-purple-500 text-xs">platform</td>
                  <td className="py-2 px-4 text-muted-foreground">string</td>
                  <td className="py-2 px-4">"cloudinary" (default) or "atlascloud" for 4K premium</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>

        {/* Webhooks Section */}
        <div className="col-span-full mt-8 mb-4">
          <h3 className="text-xl font-bold flex items-center gap-2">
            <Zap className="w-5 h-5 text-orange-500" />
            Webhook Endpoints (Real-time Updates)
          </h3>
          <p className="text-muted-foreground mt-1">Receive real-time notifications when posts are published or fail</p>
        </div>

        {/* Register Webhook */}
        <Card className="p-6 bg-card/50 border-orange-500/20">
          <div className="flex items-center gap-3 mb-4">
            <span className="px-3 py-1 rounded text-sm font-mono bg-emerald-500/20 text-emerald-500">POST</span>
            <code className="font-mono">/api/v1/webhooks</code>
          </div>
          <p className="text-muted-foreground mb-4">Register a webhook URL to receive post status updates</p>
          <CodeBlock id="webhook-register" language="json" code={webhookRegisterExample} />
          <p className="text-xs text-muted-foreground mt-2">
            Available events: <code>post.completed</code>, <code>post.failed</code>, <code>post.published</code>, or <code>*</code> for all
          </p>
        </Card>

        {/* List Webhooks */}
        <Card className="p-6 bg-card/50 border-orange-500/20">
          <div className="flex items-center gap-3 mb-4">
            <span className="px-3 py-1 rounded text-sm font-mono bg-primary/20 text-primary">GET</span>
            <code className="font-mono">/api/v1/webhooks</code>
          </div>
          <p className="text-muted-foreground">List all your registered webhooks</p>
        </Card>

        {/* Delete Webhook */}
        <Card className="p-6 bg-card/50 border-orange-500/20">
          <div className="flex items-center gap-3 mb-4">
            <span className="px-3 py-1 rounded text-sm font-mono bg-red-500/20 text-red-500">DELETE</span>
            <code className="font-mono">/api/v1/webhooks/:id</code>
          </div>
          <p className="text-muted-foreground">Remove a registered webhook</p>
        </Card>

        {/* Test Webhook */}
        <Card className="p-6 bg-card/50 border-orange-500/20">
          <div className="flex items-center gap-3 mb-4">
            <span className="px-3 py-1 rounded text-sm font-mono bg-emerald-500/20 text-emerald-500">POST</span>
            <code className="font-mono">/api/v1/webhooks/test</code>
          </div>
          <p className="text-muted-foreground mb-4">Send a test event to verify your webhook is working</p>
          <CodeBlock id="webhook-test" language="json" code={webhookTestExample} />
        </Card>
      </div>
    </section>
  );
}
