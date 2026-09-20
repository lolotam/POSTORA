/**
 * Debug panel showing Cloudinary transformation details and request IDs
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Bug,
  ChevronDown,
  ChevronUp,
  Copy,
  Trash2,
  CheckCircle2,
  XCircle,
  Clock,
} from "lucide-react";
import { useVideoProcessingDebug } from "@/contexts/VideoProcessingDebugContext";
import { cn } from "@/lib/utils";

interface VideoProcessingDebugPanelProps {
  className?: string;
  compact?: boolean;
}

export function VideoProcessingDebugPanel({ className, compact = false }: VideoProcessingDebugPanelProps) {
  const { t } = useTranslation("postmedia");
  const { debugMode, toggleDebugMode, debugLogs, clearDebugLogs } = useVideoProcessingDebug();
  const [isOpen, setIsOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopy = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };

  if (compact) {
    return (
      <div className={cn("flex items-center gap-2", className)}>
        <Switch
          id="debug-mode-compact"
          checked={debugMode}
          onCheckedChange={toggleDebugMode}
          className="scale-90"
        />
        <Label htmlFor="debug-mode-compact" className="text-xs text-muted-foreground flex items-center gap-1">
          <Bug className="w-3 h-3" />
          {t("debugPanel.debug", "Debug")}
        </Label>
      </div>
    );
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className={className}>
      <Card className="border-border/50">
        <CollapsibleTrigger asChild>
          <CardHeader className="p-3 cursor-pointer hover:bg-muted/50 transition-colors">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Bug className="w-4 h-4" />
                {t("debugPanel.title", "Video Processing Debug")}
                {debugMode && (
                  <Badge variant="secondary" className="text-[10px] h-4">
                    {t("debugPanel.active", "Active")}
                  </Badge>
                )}
              </CardTitle>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                  <Switch
                    id="debug-mode"
                    checked={debugMode}
                    onCheckedChange={toggleDebugMode}
                    className="scale-90"
                  />
                  <Label htmlFor="debug-mode" className="text-xs text-muted-foreground">
                    {debugMode ? t("debugPanel.on", "On") : t("debugPanel.off", "Off")}
                  </Label>
                </div>
                {isOpen ? (
                  <ChevronUp className="w-4 h-4 text-muted-foreground" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-muted-foreground" />
                )}
              </div>
            </div>
          </CardHeader>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <CardContent className="p-3 pt-0 space-y-3">
            {!debugMode && (
              <p className="text-xs text-muted-foreground text-center py-2">
                {t("debugPanel.enableDesc", "Enable debug mode to see Cloudinary transformation details")}
              </p>
            )}

            {debugMode && debugLogs.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-2">
                {t("debugPanel.noLogs", "No debug logs yet. Process a video to see details.")}
              </p>
            )}

            {debugMode && debugLogs.length > 0 && (
              <>
                <div className="flex justify-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={clearDebugLogs}
                    className="h-6 text-xs gap-1"
                  >
                    <Trash2 className="w-3 h-3" />
                    {t("debugPanel.clearLogs", "Clear logs")}
                  </Button>
                </div>

                <ScrollArea className="h-[200px]">
                  <div className="space-y-2">
                    {debugLogs.map((log, index) => (
                      <div
                        key={index}
                        className={cn(
                          "rounded-lg border p-2.5 text-xs space-y-1.5",
                          log.status === "success" && "border-green-500/30 bg-green-500/5",
                          log.status === "error" && "border-destructive/50 bg-destructive/5"
                        )}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5">
                            {log.status === "success" ? (
                              <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                            ) : (
                              <XCircle className="w-3.5 h-3.5 text-destructive" />
                            )}
                            <Badge variant="outline" className="text-[10px] h-4">
                              {log.operation}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-1 text-muted-foreground">
                            <Clock className="w-3 h-3" />
                            {formatTime(log.timestamp)}
                          </div>
                        </div>

                        {log.transformation && (
                          <div className="flex items-start gap-1.5">
                            <span className="text-muted-foreground shrink-0">{t("debugPanel.transform", "Transform:")}</span>
                            <code className="text-[10px] bg-muted px-1 py-0.5 rounded break-all flex-1">
                              {log.transformation}
                            </code>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-5 w-5 shrink-0"
                              onClick={() => handleCopy(log.transformation, `transform-${index}`)}
                            >
                              {copiedId === `transform-${index}` ? (
                                <CheckCircle2 className="w-3 h-3 text-green-500" />
                              ) : (
                                <Copy className="w-3 h-3" />
                              )}
                            </Button>
                          </div>
                        )}

                        {log.request_id && (
                          <div className="flex items-center gap-1.5">
                            <span className="text-muted-foreground">{t("debugPanel.requestId", "Request ID:")}</span>
                            <code className="text-[10px] bg-muted px-1 py-0.5 rounded">
                              {log.request_id}
                            </code>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-5 w-5"
                              onClick={() => handleCopy(log.request_id!, `request-${index}`)}
                            >
                              {copiedId === `request-${index}` ? (
                                <CheckCircle2 className="w-3 h-3 text-green-500" />
                              ) : (
                                <Copy className="w-3 h-3" />
                              )}
                            </Button>
                          </div>
                        )}

                        {log.video_metadata && (
                          <div className="text-muted-foreground">
                            {t("debugPanel.dimensions", "Dimensions:")} {log.video_metadata.width}×{log.video_metadata.height}
                            {log.video_metadata.duration && ` • ${Math.round(log.video_metadata.duration)}s`}
                          </div>
                        )}

                        {log.error && (
                          <div className="text-destructive bg-destructive/10 rounded p-1.5 mt-1">
                            {log.error}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
