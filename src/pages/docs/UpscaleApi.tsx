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
    "output_format": "png",
    "quality": 95,
    "denoise": true,
    "face_enhance": true
  }'`;

  const curlFormData = `curl -X POST "${API_BASE}/upscale-image" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "file=@/path/to/image.jpg" \\
  -F "scale=2" \\
  -F "output_format=png"`;

  const n8nExample = `{
  "image_url": "{{ $json.imageUrl }}",
  "scale": 2,
  "output_format": "png",
  "face_enhance": true
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
      description: "Base64 encoded image data. Include the data URI prefix.",
      example: "data:image/jpeg;base64,/9j/4AAQ...",
      icon: FileText
    },
    {
      name: "scale",
      type: "number",
      required: false,
      default: "2",
      description: "Upscale factor. Doubles or quadruples the image dimensions.",
      options: ["2", "4"],
      icon: Maximize2
    },
    {
      name: "output_format",
      type: "string",
      required: false,
      default: "png",
      description: "Output image format.",
      options: ["png", "jpeg", "webp"],
      icon: Download
    },
    {
      name: "quality",
      type: "number",
      required: false,
      default: "90",
      description: "Output quality (1-100). Applies to JPEG and WebP.",
      example: "95",
      icon: Sparkles
    },
    {
      name: "denoise",
      type: "boolean",
      required: false,
      default: "false",
      description: "Apply noise reduction during upscaling.",
      icon: Sparkles
    },
    {
      name: "face_enhance",
      type: "boolean",
      required: false,
      default: "false",
      description: "Apply face enhancement for portraits.",
      icon: ZoomIn
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
          { label: "Face Enhance", icon: ZoomIn },
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
                  <li>• Face enhancement available</li>
                </ul>
              </div>
              <div className="p-4 rounded-lg bg-background border">
                <h4 className="font-medium mb-2">Limitations</h4>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>• Max input size: 10MB</li>
                  <li>• Max input dimensions: 2048x2048</li>
                  <li>• Max output: 8192x8192</li>
                  <li>• Formats: JPEG, PNG, WebP, GIF</li>
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
                <TabsTrigger value="error">Error</TabsTrigger>
              </TabsList>
              <TabsContent value="success">
                <CodeBlock 
                  code={`{
  "success": true,
  "image_url": "https://storage.example.com/upscaled/abc123.png",
  "image_base64": "data:image/png;base64,iVBORw0KGgo...",
  "original_size": {
    "width": 512,
    "height": 512
  },
  "upscaled_size": {
    "width": 2048,
    "height": 2048
  },
  "scale": 4,
  "format": "png"
}`}
                  language="json"
                  id="success-response"
                  title="Success response"
                />
              </TabsContent>
              <TabsContent value="error">
                <CodeBlock 
                  code={`{
  "success": false,
  "error": "Image too large",
  "details": "Input image exceeds maximum dimensions of 2048x2048"
}`}
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
