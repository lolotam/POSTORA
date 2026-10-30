import { useState } from "react";
import { Link } from "react-router-dom";
import { DocPageHeader } from "@/components/docs";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/useAuth";
import {
  ArrowLeft, Copy, Check, Image, Maximize2,
  FileText, AlertCircle, CheckCircle2, Zap,
  Download, Upload, Sparkles, Shield, ZoomIn
} from "lucide-react";

const API_BASE = "https://api.postora.cloud/functions/v1";

export default function UpscaleApi() {
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

  // Curl examples
  const curlBasic2x = `curl -X POST "${API_BASE}/upscale-image" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "image_url": "https://example.com/photo.jpg",
    "scale": 2
  }'`;

  const curlBasic4x = `curl -X POST "${API_BASE}/upscale-image" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "image_url": "https://example.com/photo.jpg",
    "scale": 4
  }'`;

  const curlFromBase64 = `curl -X POST "${API_BASE}/upscale-image" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "image_base64": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAA...",
    "scale": 2
  }'`;

  const curlWithOptions = `curl -X POST "${API_BASE}/upscale-image" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "image_url": "https://example.com/photo.jpg",
    "scale": 4,
    "platform": "atlascloud"
  }'`;

  const curlFormData = `curl -X POST "${API_BASE}/upscale-image" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "file=@/path/to/image.jpg" \\
  -F "scale=2"`;

  const n8nExample = `{
  "image_url": "{{ $json.imageUrl }}",
  "scale": 2
}`;

  const fields = [
    {
      name: "image_url",
      type: "string",
      required: false,
      description: "URL of the image to upscale. Either image_url or image_base64 is required.",
      example: "https://example.com/photo.jpg",
      icon: Image
    },
    {
      name: "image_base64",
      type: "string",
      required: false,
      description: "Base64 encoded image data, raw or as a data URI.",
      example: "data:image/jpeg;base64,/9j/4AAQ...",
      icon: FileText
    },
    {
      name: "scale",
      type: "number",
      required: false,
      default: "2",
      description: "Upscale factor, 1 to 4. With AtlasCloud, 2 or lower gives 2K output and higher gives 4K.",
      options: ["1", "2", "3", "4"],
      icon: Maximize2
    },
    {
      name: "platform",
      type: "string",
      required: false,
      description: "Omit to let Postora choose: Cloudinary while it is available, otherwise AtlasCloud. \"atlascloud\" always uses AtlasCloud; \"cloudinary\" falls back to AtlasCloud when Cloudinary is unavailable (the response says which one ran).",
      options: ["atlascloud", "cloudinary"],
      icon: Sparkles
    },
    {
      name: "output_format",
      type: "string",
      required: false,
      description: "Output format of an AtlasCloud upscale. When omitted, a PNG source gives PNG (transparency is kept) and anything else gives JPEG.",
      options: ["png", "jpeg"],
      icon: Download
    },
    {
      name: "file",
      type: "binary",
      required: false,
      description: "Image file for a multipart/form-data request, instead of image_url or image_base64. When a file and image_url are both sent, the file is used.",
      icon: Upload
    },
    {
      name: "prediction_id",
      type: "string",
      required: false,
      description: "The id from an earlier HTTP 202 answer. Send it alone (no image) to collect that job's result.",
      icon: Zap
    }
  ];

  return (
    <div className="min-h-screen bg-background">
      <DocPageHeader
        isAuthenticated={!!user}
        title="Upscale Image API"
        subtitle="AI-powered image upscaling up to 4x resolution"
        icon={Maximize2}
        variant="cyan"
        headingPreset="emerald-cyan-sky"
        ctaGradient="from-cyan-500 via-sky-500 to-blue-500"
        badges={[
          { label: "JPEG/PNG/WebP", icon: Image },
          { label: "AI Powered", icon: Sparkles },
          { label: "2x or 4x Scale", icon: Maximize2 },
          { label: "4K via AtlasCloud", icon: ZoomIn },
        ]}
      />

      <main className="container mx-auto px-6 py-12 max-w-5xl">

        {/* Features */}
        <Card className="mb-8 border-green-500/20 bg-green-500/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-green-500" />
              Features & Limits
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 rounded-lg bg-background border">
                <h4 className="font-medium mb-2">Upscale Options</h4>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>• 2x scale: 512px → 1024px</li>
                  <li>• 4x scale: 512px → 2048px</li>
                  <li>• AI-enhanced details</li>
                  <li>• AtlasCloud output: 2K or 4K, stored in Postora storage</li>
                </ul>
              </div>
              <div className="p-4 rounded-lg bg-background border">
                <h4 className="font-medium mb-2">Limitations</h4>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>• Max upload size: 10MB (image_base64 or file)</li>
                  <li>• Formats: JPEG, PNG, WebP, GIF</li>
                  <li>• Slow jobs answer HTTP 202 with a prediction_id; send it back to collect the result</li>
                  <li>• HTTP 503 PROVIDER_UNAVAILABLE when no AI provider is available</li>
                </ul>
              </div>
            </div>
            <div className="mt-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <p className="text-sm flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-amber-500" />
                4x upscaling of large images may take 10-30 seconds to process.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Quick Start */}
        <Card className="mb-8 border-primary/20 bg-primary/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-primary" />
              Quick Start
            </CardTitle>
            <CardDescription>Upscale an image with a single API call</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">1</div>
              <div>
                <p className="font-medium">Get your API Key</p>
                <p className="text-sm text-muted-foreground">Navigate to <Link to="/api-keys" className="text-primary hover:underline">Settings → API Keys</Link></p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">2</div>
              <div>
                <p className="font-medium">Send your image</p>
                <p className="text-sm text-muted-foreground">Provide an image URL or base64 data with desired scale</p>
              </div>
            </div>
            <CodeBlock code={curlBasic2x} language="bash" id="quick-start" title="2x upscale from URL" />
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">3</div>
              <div>
                <p className="font-medium">Get the result</p>
                <p className="text-sm text-muted-foreground">Receive the upscaled image with enhanced details</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Examples */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle>Request Examples</CardTitle>
            <CardDescription>Different ways to use the Upscale API</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="2x" className="w-full">
              <TabsList className="grid grid-cols-5 mb-4">
                <TabsTrigger value="2x">2x Scale</TabsTrigger>
                <TabsTrigger value="4x">4x Scale</TabsTrigger>
                <TabsTrigger value="base64">Base64</TabsTrigger>
                <TabsTrigger value="options">All Options</TabsTrigger>
                <TabsTrigger value="formdata">Form Data</TabsTrigger>
              </TabsList>
              <TabsContent value="2x">
                <CodeBlock code={curlBasic2x} language="bash" id="2x-example" title="2x upscale" />
              </TabsContent>
              <TabsContent value="4x">
                <CodeBlock code={curlBasic4x} language="bash" id="4x-example" title="4x upscale" />
              </TabsContent>
              <TabsContent value="base64">
                <CodeBlock code={curlFromBase64} language="bash" id="base64-example" title="From base64" />
              </TabsContent>
              <TabsContent value="options">
                <CodeBlock code={curlWithOptions} language="bash" id="options-example" title="With all options" />
              </TabsContent>
              <TabsContent value="formdata">
                <CodeBlock code={curlFormData} language="bash" id="formdata-example" title="Multipart form-data" />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        {/* API Fields */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle>API Fields Reference</CardTitle>
            <CardDescription>Available parameters for the upscale endpoint</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {fields.map((field) => (
              <div key={field.name} className="p-4 rounded-lg border bg-card">
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <field.icon className="w-4 h-4 text-primary" />
                    <code className="text-sm font-mono font-bold">{field.name}</code>
                    <Badge variant="outline" className="text-xs">{field.type}</Badge>
                    {field.required && <Badge className="text-xs bg-red-500">Required</Badge>}
                  </div>
                </div>
                <p className="text-sm text-muted-foreground mb-2">{field.description}</p>
                {field.options && (
                  <div className="flex flex-wrap gap-1 mb-2">
                    {field.options.map((opt) => (
                      <Badge key={opt} variant="secondary" className="text-xs">{opt}</Badge>
                    ))}
                  </div>
                )}
                {field.example && (
                  <p className="text-xs text-muted-foreground">Example: <code className="bg-muted px-1 rounded">{field.example}</code></p>
                )}
                {field.default && (
                  <p className="text-xs text-muted-foreground">Default: <code className="bg-muted px-1 rounded">{field.default}</code></p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Response Examples */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle>Response Examples</CardTitle>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="success">
              <TabsList className="mb-4">
                <TabsTrigger value="success">Success</TabsTrigger>
                <TabsTrigger value="processing">Still processing (202)</TabsTrigger>
                <TabsTrigger value="error">Error</TabsTrigger>
              </TabsList>
              <TabsContent value="success">
                <CodeBlock 
                  code={`{
  "success": true,
  "status": "completed",
  "original_url": "https://example.com/photo.jpg",
  "upscaled_url": "https://cdn.postora.cloud/t/postora.cloud/postora/user-id/upscaled/abc123.jpg",
  "prediction_id": "pred_abc123",
  "target_resolution": "4k",
  "scale": 4,
  "output_format": "jpeg",
  "platform": "atlascloud",
  "stored_in": "openinary"
}`}
                  language="json"
                  id="success-response"
                  title="Success response"
                />
              </TabsContent>
              <TabsContent value="processing">
                <CodeBlock
                  code={`# 1. The first request answers within about 45 seconds. A slower job returns HTTP 202:
{
  "success": true,
  "status": "processing",
  "prediction_id": "eyJwcmVkaWN0aW9uIjoi...",
  "retry_after_seconds": 3,
  "platform": "atlascloud",
  "target_resolution": "4k",
  "scale": 4,
  "output_format": "jpeg"
}

# 2. Ask again with only that id until you get the normal success response (HTTP 200).
#    Keep the same x-api-key. The id works for you only, for this endpoint, for one hour.
curl -X POST "${API_BASE}/upscale-image" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{ "prediction_id": "eyJwcmVkaWN0aW9uIjoi..." }'`}
                  language="bash"
                  id="processing-response"
                  title="Job still running"
                />
              </TabsContent>
              <TabsContent value="error">
                <CodeBlock
                  code={`{
  "success": false,
  "error": "Image upscaling is temporarily unavailable",
  "code": "PROVIDER_UNAVAILABLE"
}

// HTTP 503: no AI provider is available right now, retry later.
// HTTP 400 INVALID_INPUT: missing or unsupported image. HTTP 413: image over 10MB.
// HTTP 429 RATE_LIMITED: more than 30 AtlasCloud jobs this hour, or the provider is busy. HTTP 502/504: the job failed or timed out.
// HTTP 400 INVALID_PREDICTION: unknown prediction_id. HTTP 410 PREDICTION_EXPIRED: older than one hour, start again.`}
                  language="json"
                  id="error-response"
                  title="Error response"
                />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        {/* n8n Integration */}
        <Card className="mb-8 border-amber-500/20 bg-amber-500/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-amber-500" />
              n8n HTTP Request Configuration
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div className="p-3 rounded bg-background border">
                  <p className="text-muted-foreground">Method</p>
                  <p className="font-mono font-bold">POST</p>
                </div>
                <div className="p-3 rounded bg-background border">
                  <p className="text-muted-foreground">URL</p>
                  <p className="font-mono text-xs break-all">{API_BASE}/upscale-image</p>
                </div>
              </div>
              <div className="p-3 rounded bg-background border">
                <p className="text-muted-foreground text-sm mb-2">Headers</p>
                <code className="text-xs block">Content-Type: application/json</code>
                <code className="text-xs block">x-api-key: {"{{ $credentials.postora.apiKey }}"}</code>
              </div>
              <div className="p-3 rounded bg-background border">
                <p className="text-muted-foreground text-sm mb-2">Body (JSON)</p>
                <CodeBlock code={n8nExample} language="json" id="n8n-body" title="n8n body example" />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Footer navigation */}
        <div className="flex justify-between items-center pt-8 border-t">
          <Link to="/docs/remove-background" className="text-muted-foreground hover:text-foreground flex items-center gap-2">
            <ArrowLeft className="w-4 h-4" />
            Remove Background API
          </Link>
          <Link to="/docs/webhooks" className="text-primary hover:underline flex items-center gap-2">
            Webhook Guide
            <ArrowLeft className="w-4 h-4 rotate-180" />
          </Link>
        </div>
      </main>
    </div>
  );
}
