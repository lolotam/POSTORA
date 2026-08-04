import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Upload,
  FileSpreadsheet,
  Download,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Globe,
} from "lucide-react";
import { Platform } from "@/lib/types";
import { TimezoneSelector } from "./TimezoneSelector";
import { useQuotas } from "@/hooks/useQuotas";

interface ParsedPost {
  caption: string;
  platforms: Platform[];
  scheduled_at: string;
  status: "pending" | "success" | "error";
  error?: string;
}

export function BulkScheduler() {
  const { canCreatePost } = useQuotas();
  const [open, setOpen] = useState(false);
  const [parsedPosts, setParsedPosts] = useState<ParsedPost[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [selectedTimezone, setSelectedTimezone] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { user, profile } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Load user's preferred timezone
  useEffect(() => {
    if (profile?.preferred_timezone) {
      setSelectedTimezone(profile.preferred_timezone);
    }
  }, [profile?.preferred_timezone]);

  const downloadTemplate = () => {
    const csvContent = `caption,platforms,scheduled_at
"Hello world! This is my first scheduled post 🎉","instagram,facebook","2026-01-15T10:00:00"
"Check out our new product launch! #newproduct","instagram,twitter,linkedin","2026-01-16T14:30:00"
"Weekly tip: Always engage with your audience! 💡","tiktok,instagram","2026-01-17T09:00:00"`;

    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "bulk-schedule-template.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  const parseCSV = (text: string): ParsedPost[] => {
    const lines = text.split("\n").filter((line) => line.trim());
    if (lines.length < 2) return [];

    // Skip header
    const dataLines = lines.slice(1);
    const posts: ParsedPost[] = [];

    for (const line of dataLines) {
      try {
        // Parse CSV with quoted fields
        const matches = line.match(/("([^"]*)")|([^,]+)/g);
        if (!matches || matches.length < 3) continue;

        const caption = matches[0].replace(/^"|"$/g, "").trim();
        const platformsStr = matches[1].replace(/^"|"$/g, "").trim();
        const scheduledAt = matches[2].replace(/^"|"$/g, "").trim();

        const platforms = platformsStr
          .split(",")
          .map((p) => p.trim().toLowerCase())
          .filter((p) =>
            ["instagram", "facebook", "tiktok", "twitter", "linkedin"].includes(p)
          ) as Platform[];

        if (platforms.length === 0) {
          posts.push({
            caption,
            platforms: [],
            scheduled_at: scheduledAt,
            status: "error",
            error: "No valid platforms specified",
          });
          continue;
        }

        // Validate date
        const date = new Date(scheduledAt);
        if (isNaN(date.getTime())) {
          posts.push({
            caption,
            platforms,
            scheduled_at: scheduledAt,
            status: "error",
            error: "Invalid date format",
          });
          continue;
        }

        if (date < new Date()) {
          posts.push({
            caption,
            platforms,
            scheduled_at: scheduledAt,
            status: "error",
            error: "Scheduled time is in the past",
          });
          continue;
        }

        posts.push({
          caption,
          platforms,
          scheduled_at: date.toISOString(),
          status: "pending",
        });
      } catch (err) {
        console.error("Parse error:", err);
      }
    }

    return posts;
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      const posts = parseCSV(text);
      setParsedPosts(posts);
      setIsUploading(false);
    };
    reader.onerror = () => {
      toast({
        title: "Failed to read file",
        description: "Please check your file format and try again.",
        variant: "destructive",
      });
      setIsUploading(false);
    };
    reader.readAsText(file);
  };

  const handleScheduleAll = async () => {
    if (!user) return;

    const validPosts = parsedPosts.filter((p) => p.status === "pending");
    if (validPosts.length === 0) {
      toast({
        title: "No valid posts",
        description: "Please fix the errors and try again.",
        variant: "destructive",
      });
      return;
    }

    setIsProcessing(true);
    setProgress(0);

    const updatedPosts = [...parsedPosts];

    for (let i = 0; i < updatedPosts.length; i++) {
      const post = updatedPosts[i];
      if (post.status !== "pending") continue;

      try {
        const quotaCheck = await canCreatePost();
        if (!quotaCheck.allowed) {
          updatedPosts[i] = {
            ...post,
            status: "error",
            error: quotaCheck.message || "Post quota exceeded",
          };
          continue;
        }

        const { error } = await supabase.from("posts").insert({
          user_id: user.id,
          caption: post.caption,
          platforms: post.platforms,
          scheduled_at: post.scheduled_at,
          status: "pending",
          metadata: selectedTimezone ? { schedule_timezone: selectedTimezone } : null,
        });

        if (error) throw error;

        updatedPosts[i] = { ...post, status: "success" };
      } catch (err) {
        const raw = err instanceof Error ? err.message : "Unknown error";
        const friendly = raw.includes("POST_QUOTA_")
          ? raw.replace(/^.*POST_QUOTA_[A-Z_]+:\s*/i, "")
          : raw;
        updatedPosts[i] = {
          ...post,
          status: "error",
          error: friendly,
        };
      }

      setParsedPosts([...updatedPosts]);
      setProgress(((i + 1) / updatedPosts.length) * 100);
    }

    setIsProcessing(false);
    queryClient.invalidateQueries({ queryKey: ["posts"] });

    const successCount = updatedPosts.filter((p) => p.status === "success").length;
    const errorCount = updatedPosts.filter((p) => p.status === "error").length;

    toast({
      title: "Bulk scheduling complete",
      description: `${successCount} posts scheduled successfully${
        errorCount > 0 ? `, ${errorCount} failed` : ""
      }`,
    });
  };

  const resetState = () => {
    setParsedPosts([]);
    setProgress(0);
    // Reset timezone to user's preferred or empty
    setSelectedTimezone(profile?.preferred_timezone || "");
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const pendingCount = parsedPosts.filter((p) => p.status === "pending").length;
  const successCount = parsedPosts.filter((p) => p.status === "success").length;
  const errorCount = parsedPosts.filter((p) => p.status === "error").length;

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        setOpen(isOpen);
        if (!isOpen) resetState();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <FileSpreadsheet className="w-4 h-4" />
          Bulk Schedule
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="w-5 h-5 text-primary" />
            Bulk Schedule Posts
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6 pt-4">
          {/* Instructions */}
          <Card className="p-4 bg-secondary/30 border-border">
            <h4 className="font-medium mb-2">How to use:</h4>
            <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
              <li>Download the CSV template below</li>
              <li>Fill in your posts with captions, platforms, and scheduled times</li>
              <li>Upload the completed CSV file</li>
              <li>Review and confirm to schedule all posts</li>
            </ol>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={downloadTemplate}
            >
              <Download className="w-4 h-4 mr-2" />
              Download Template
            </Button>
          </Card>

          {/* Timezone Selection */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 mb-2">
              <Globe className="w-4 h-4 text-muted-foreground" />
              <Label>Timezone for All Posts (Optional)</Label>
            </div>
            <TimezoneSelector
              value={selectedTimezone}
              onChange={setSelectedTimezone}
            />
            <p className="text-xs text-muted-foreground">
              All scheduled times in your CSV will be interpreted in this timezone.
              {profile?.preferred_timezone && (
                <span className="block mt-1">
                  Your saved preference ({profile.preferred_timezone}) is pre-selected.
                </span>
              )}
            </p>
          </div>

          {/* File Upload */}
          <div className="space-y-2">
            <Label>Upload CSV File</Label>
            <div
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-border rounded-xl p-8 text-center cursor-pointer hover:border-primary/50 hover:bg-secondary/30 transition-colors"
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                onChange={handleFileUpload}
                className="hidden"
              />
              {isUploading ? (
                <Loader2 className="w-8 h-8 mx-auto mb-2 animate-spin text-primary" />
              ) : (
                <Upload className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
              )}
              <p className="text-sm text-muted-foreground">
                Click to upload or drag and drop your CSV file
              </p>
            </div>
          </div>

          {/* Parsed Posts Preview */}
          {parsedPosts.length > 0 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="font-medium">
                  Preview ({parsedPosts.length} posts)
                </h4>
                <div className="flex items-center gap-2">
                  {pendingCount > 0 && (
                    <Badge variant="secondary">{pendingCount} pending</Badge>
                  )}
                  {successCount > 0 && (
                    <Badge className="bg-emerald-500/20 text-emerald-500">
                      {successCount} success
                    </Badge>
                  )}
                  {errorCount > 0 && (
                    <Badge variant="destructive">{errorCount} errors</Badge>
                  )}
                </div>
              </div>

              {isProcessing && (
                <Progress value={progress} className="h-2" />
              )}

              <div className="space-y-2 max-h-[300px] overflow-y-auto">
                {parsedPosts.map((post, index) => (
                  <Card
                    key={index}
                    className={`p-3 border ${
                      post.status === "success"
                        ? "border-emerald-500/30 bg-emerald-500/5"
                        : post.status === "error"
                        ? "border-destructive/30 bg-destructive/5"
                        : "border-border bg-card/50"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="shrink-0 mt-0.5">
                        {post.status === "success" ? (
                          <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                        ) : post.status === "error" ? (
                          <XCircle className="w-5 h-5 text-destructive" />
                        ) : (
                          <AlertTriangle className="w-5 h-5 text-muted-foreground" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm line-clamp-2">{post.caption}</p>
                        <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                          <span>{post.platforms.join(", ")}</span>
                          <span>•</span>
                          <span>
                            {new Date(post.scheduled_at).toLocaleString()}
                          </span>
                        </div>
                        {post.error && (
                          <p className="text-xs text-destructive mt-1">
                            {post.error}
                          </p>
                        )}
                      </div>
                    </div>
                  </Card>
                ))}
              </div>

              <div className="flex gap-3">
                <Button
                  onClick={handleScheduleAll}
                  disabled={isProcessing || pendingCount === 0}
                  className="flex-1"
                >
                  {isProcessing ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Scheduling...
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="w-4 h-4 mr-2" />
                      Schedule {pendingCount} Posts
                    </>
                  )}
                </Button>
                <Button variant="outline" onClick={resetState}>
                  Clear
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
