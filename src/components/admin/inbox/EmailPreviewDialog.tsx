import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Eye, Monitor, Smartphone, Tablet } from "lucide-react";
import { cn } from "@/lib/utils";

interface EmailPreviewDialogProps {
  subject: string;
  htmlContent: string;
  fromAddress: string;
}

type ViewMode = "desktop" | "tablet" | "mobile";

const VIEW_SIZES: Record<ViewMode, { width: string; label: string; icon: React.ReactNode }> = {
  desktop: { width: "100%", label: "Desktop", icon: <Monitor className="h-4 w-4" /> },
  tablet: { width: "768px", label: "Tablet", icon: <Tablet className="h-4 w-4" /> },
  mobile: { width: "375px", label: "Mobile", icon: <Smartphone className="h-4 w-4" /> },
};

export function EmailPreviewDialog({
  subject,
  htmlContent,
  fromAddress,
}: EmailPreviewDialogProps) {
  const [open, setOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("desktop");

  // Wrap content in email client simulation
  const getPreviewHtml = () => {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {
            margin: 0;
            padding: 0;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background-color: #f5f5f5;
          }
          .email-wrapper {
            max-width: 100%;
            margin: 0 auto;
            background: white;
          }
          .email-header {
            background: #f8f9fa;
            border-bottom: 1px solid #e5e5e5;
            padding: 16px 20px;
          }
          .email-from {
            font-size: 14px;
            color: #666;
            margin-bottom: 4px;
          }
          .email-subject {
            font-size: 18px;
            font-weight: 600;
            color: #1a1a1a;
          }
          .email-body {
            padding: 24px 20px;
            min-height: 300px;
          }
        </style>
      </head>
      <body>
        <div class="email-wrapper">
          <div class="email-header">
            <div class="email-from">From: ${fromAddress}</div>
            <div class="email-subject">${subject || "(No Subject)"}</div>
          </div>
          <div class="email-body">
            ${htmlContent || "<p style='color: #999;'>No content</p>"}
          </div>
        </div>
      </body>
      </html>
    `;
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={!htmlContent}>
          <Eye className="h-4 w-4 me-2" />
          Preview
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[900px] max-h-[90vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Eye className="h-5 w-5" />
              Email Preview
            </span>
            <div className="flex items-center gap-1">
              {(Object.keys(VIEW_SIZES) as ViewMode[]).map((mode) => (
                <Button
                  key={mode}
                  variant={viewMode === mode ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setViewMode(mode)}
                  className="gap-1"
                >
                  {VIEW_SIZES[mode].icon}
                  <span className="hidden sm:inline">{VIEW_SIZES[mode].label}</span>
                </Button>
              ))}
            </div>
          </DialogTitle>
        </DialogHeader>

        <div className="mt-4 flex justify-center bg-muted/30 rounded-lg p-4 overflow-auto">
          <div
            className={cn(
              "bg-white rounded-lg shadow-lg overflow-hidden transition-all duration-300",
              viewMode !== "desktop" && "mx-auto"
            )}
            style={{
              width: VIEW_SIZES[viewMode].width,
              maxWidth: "100%",
            }}
          >
            <iframe
              srcDoc={getPreviewHtml()}
              className="w-full h-[500px] border-0"
              title="Email Preview"
              sandbox="allow-same-origin"
            />
          </div>
        </div>

        <div className="mt-4 flex justify-between items-center text-sm text-muted-foreground">
          <p>
            Preview simulates how the email will appear in email clients.
          </p>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
