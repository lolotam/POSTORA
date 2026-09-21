import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, History, Check, X } from "lucide-react";
import { format } from "date-fns";
import { ScrollArea } from "@/components/ui/scroll-area";

interface AuditLogEntry {
  id: string;
  feature_key: string;
  old_value: boolean | null;
  new_value: boolean;
  changed_by: string | null;
  change_type: string;
  notes: string | null;
  created_at: string;
  admin_email?: string;
}

const FLAG_LABELS: Record<string, string> = {
  feature_video_compress: "Video Compression",
  feature_tiktok_transcode: "TikTok Transcode",
  feature_image_crop: "Image Cropping",
  feature_ai_caption: "AI Caption",
  feature_ai_hashtags: "AI Hashtags",
  feature_ai_thumbnails: "AI Thumbnails",
  feature_ai_image: "AI Image",
};

export function FeatureFlagAuditLog() {
  const { data: logs = [], isLoading } = useQuery({
    queryKey: ["feature-flag-audit-log"],
    queryFn: async (): Promise<AuditLogEntry[]> => {
      const { data, error } = await supabase
        .from("feature_flag_audit_log")
        .select(`
          *,
          profiles:changed_by(email)
        `)
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) throw error;

      return (data || []).map((log: any) => ({
        ...log,
        admin_email: log.profiles?.email,
      }));
    },
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <History className="w-5 h-5 text-muted-foreground" />
          <div>
            <CardTitle className="text-lg">Activity Log</CardTitle>
            <CardDescription>Track feature flag changes</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : logs.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            No activity recorded yet
          </p>
        ) : (
          <ScrollArea className="h-[300px] pe-4">
            <div className="space-y-3">
              {logs.map((log) => (
                <div
                  key={log.id}
                  className="flex items-start gap-3 p-3 rounded-lg border bg-muted/30"
                >
                  <div className="mt-0.5">
                    {log.new_value ? (
                      <div className="w-6 h-6 rounded-full bg-green-500/20 flex items-center justify-center">
                        <Check className="w-3.5 h-3.5 text-green-600" />
                      </div>
                    ) : (
                      <div className="w-6 h-6 rounded-full bg-destructive/20 flex items-center justify-center">
                        <X className="w-3.5 h-3.5 text-destructive" />
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">
                        {FLAG_LABELS[log.feature_key] || log.feature_key}
                      </span>
                      <Badge variant="outline" className="text-xs">
                        {log.change_type}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {log.old_value !== null && (
                        <>
                          <span className={log.old_value ? "text-green-600" : "text-destructive"}>
                            {log.old_value ? "On" : "Off"}
                          </span>
                          {" → "}
                        </>
                      )}
                      <span className={log.new_value ? "text-green-600" : "text-destructive"}>
                        {log.new_value ? "On" : "Off"}
                      </span>
                      {" • "}
                      {format(new Date(log.created_at), "MMM d, yyyy 'at' h:mm a")}
                    </p>
                    {log.admin_email && (
                      <p className="text-xs text-muted-foreground">
                        by {log.admin_email}
                      </p>
                    )}
                    {log.notes && (
                      <p className="text-xs text-muted-foreground mt-1 italic">
                        "{log.notes}"
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
