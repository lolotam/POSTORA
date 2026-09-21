import { useState } from "react";
import { Link } from "react-router-dom";
import { DocPageHeader } from "@/components/docs";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/useAuth";
import {
  ArrowLeft, Copy, Check, Image, Wand2,
  FileText, AlertCircle, CheckCircle2, Zap,
  Download, Upload, Sparkles, Shield
} from "lucide-react";

const API_BASE = "https://api.postora.cloud/functions/v1";

export default function RemoveBackgroundApi() {
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
  const curlFromUrl = `curl -X POST "${API_BASE}/remove-background" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "image_url": "https://example.com/photo.jpg"
  }'`;

  const curlFromBase64 = `curl -X POST "${API_BASE}/remove-background" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "image_base64": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAA..."
  }'`;

  const curlWithOptions = `curl -X POST "${API_BASE}/remove-background" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "image_url": "https://example.com/photo.jpg",
    "output_format": "png",
    "quality": 95
  }'`;

  const curlFormData = `curl -X POST "${API_BASE}/remove-background" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "file=@/path/to/image.jpg" \\
  -F "output_format=png"`;

  const n8nExample = `{
  "image_url": "{{ $json.imageUrl }}",
  "output_format": "png"
}`;

  const fields = [
    {
      name: "image_url",
      type: "string",
      required: false,
      description: "URL of the image to process. Either image_url or image_base64 is required.",
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
      name: "output_format",
      type: "string",
      required: false,
      default: "png",
      description: "Output image format. PNG recommended for transparency.",
      options: ["png", "webp"],
      icon: Download
    },
    {
      name: "quality",
      type: "number",
      required: false,
      default: 90,
      description: "Output quality (1-100). Only applies to webp format.",
      example: "90",
      icon: Sparkles
    }
  ];

  return (
    <div className="min-h-screen bg-background">
      <DocPageHeader
        isAuthenticated={!!user}
        title="Remove Background API"
        subtitle="AI-powered background removal for your images"
        icon={Wand2}
        variant="violet"
        headingPreset="sky-violet-pink"
        ctaGradient="from-violet-500 via-fuchsia-500 to-pink-500"
        badges={[
          { label: "JPEG/PNG/WebP", icon: Image },
          { label: "AI Powered", icon: Sparkles },
          { label: "Transparent PNG", icon: Download },
          { label: "URL or Base64", icon: Upload },
        ]}
      />

      <main className="container mx-auto px-6 py-12 max-w-5xl">

        {/* Features */}
        <Card className="mb-8 border-purple-500/20 bg-purple-500/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-purple-500" />
              Features & Limits
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 rounded-lg bg-background border">
                <h4 className="font-medium mb-2">Supported Formats</h4>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>• Input: JPEG, PNG, WebP, GIF</li>
                  <li>• Output: PNG (transparent), WebP</li>
                  <li>• Max file size: 10MB</li>
                  <li>• Max dimensions: 4096x4096</li>
                </ul>
              </div>
              <div className="p-4 rounded-lg bg-background border">
                <h4 className="font-medium mb-2">Best Results</h4>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>• Clear subject-background contrast</li>
                  <li>• Well-lit images</li>
                  <li>• Single subject preferred</li>
                  <li>• Sharp edges work best</li>
                </ul>
              </div>
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
            <CardDescription>Remove background from an image in one API call</CardDescription>
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
                <p className="text-sm text-muted-foreground">Provide an image URL or base64 data</p>
              </div>
            </div>
            <CodeBlock code={curlFromUrl} language="bash" id="quick-start" title="Remove background from URL" />
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">3</div>
              <div>
                <p className="font-medium">Get the result</p>
                <p className="text-sm text-muted-foreground">Receive the processed image with transparent background</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Examples */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle>Request Examples</CardTitle>
            <CardDescription>Different ways to use the Remove Background API</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="url" className="w-full">
              <TabsList className="grid grid-cols-4 mb-4">
                <TabsTrigger value="url">From URL</TabsTrigger>
                <TabsTrigger value="base64">From Base64</TabsTrigger>
                <TabsTrigger value="options">With Options</TabsTrigger>
                <TabsTrigger value="formdata">Form Data</TabsTrigger>
              </TabsList>
              <TabsContent value="url">
                <CodeBlock code={curlFromUrl} language="bash" id="url-example" title="From image URL" />
              </TabsContent>
              <TabsContent value="base64">
                <CodeBlock code={curlFromBase64} language="bash" id="base64-example" title="From base64" />
              </TabsContent>
              <TabsContent value="options">
                <CodeBlock code={curlWithOptions} language="bash" id="options-example" title="With output options" />
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
            <CardDescription>Available parameters for the remove background endpoint</CardDescription>
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
  "image_url": "https://storage.example.com/processed/abc123.png",
  "image_base64": "data:image/png;base64,iVBORw0KGgo...",
  "original_size": {
    "width": 1920,
    "height": 1080
  },
  "processed_size": {
    "width": 1920,
    "height": 1080
  },
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
  "error": "Invalid image format",
  "details": "The provided file is not a supported image format"
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
                  <p className="font-mono text-xs break-all">{API_BASE}/remove-background</p>
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
          <Link to="/docs/reddit-api" className="text-muted-foreground hover:text-foreground flex items-center gap-2">
            <ArrowLeft className="w-4 h-4" />
            Reddit API
          </Link>
          <Link to="/docs/upscale" className="text-primary hover:underline flex items-center gap-2">
            Upscale API
            <ArrowLeft className="w-4 h-4 rotate-180" />
          </Link>
        </div>
      </main>
    </div>
  );
}
