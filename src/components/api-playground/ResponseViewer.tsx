import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileJson, Terminal, Eye, Clock, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { ApiResponse } from "./types";

interface ResponseViewerProps {
  requestBody: string;
  generateCurl: () => string;
  response: ApiResponse | null;
  copiedCode: string | null;
  copyCode: (code: string, id: string) => void;
}

export function ResponseViewer({ requestBody, generateCurl, response, copiedCode, copyCode }: ResponseViewerProps) {
  return (
    <div className="space-y-6">
      {/* Request Preview */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg flex items-center gap-2">
              <FileJson className="w-4 h-4" /> Request Body
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={() => copyCode(requestBody, "request")} className="h-8">
              {copiedCode === "request" ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[200px]">
            <pre className="text-sm bg-muted p-4 rounded-lg overflow-x-auto"><code>{requestBody}</code></pre>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* cURL Command */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg flex items-center gap-2">
              <Terminal className="w-4 h-4" /> cURL Command
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={() => copyCode(generateCurl(), "curl")} className="h-8">
              {copiedCode === "curl" ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[150px]">
            <pre className="text-sm bg-[#0d1117] text-gray-200 p-4 rounded-lg overflow-x-auto">
              <code>{generateCurl()}</code>
            </pre>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Response */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg flex items-center gap-2">
              <Eye className="w-4 h-4" /> Response
              {response && (
                <Badge variant={response.success ? "default" : "destructive"} className="ms-2">
                  {response.status}
                </Badge>
              )}
              {response?.duration && (
                <Badge variant="outline" className="ms-1 gap-1">
                  <Clock className="w-3 h-3" /> {response.duration}ms
                </Badge>
              )}
            </CardTitle>
            {response && (
              <Button variant="ghost" size="sm" onClick={() => copyCode(JSON.stringify(response, null, 2), "response")} className="h-8">
                {copiedCode === "response" ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[300px]">
            {response ? (
              <pre className={cn(
                "text-sm p-4 rounded-lg overflow-x-auto",
                response.success ? "bg-green-500/10 border border-green-500/20" : "bg-red-500/10 border border-red-500/20"
              )}>
                <code>{JSON.stringify(response, null, 2)}</code>
              </pre>
            ) : (
              <div className="flex flex-col items-center justify-center h-[280px] text-muted-foreground">
                <Terminal className="w-12 h-12 mb-4 opacity-50" />
                <p className="text-sm">Response will appear here</p>
                <p className="text-xs mt-1">Click &quot;Send Request&quot; to test the API</p>
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
