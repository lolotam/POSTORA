import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PlatformIcon, ExtendedPlatform } from "@/components/PlatformIcon";
import { History, Upload, Download, Trash2, Clock, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { RequestHistoryItem, MAX_HISTORY_ITEMS } from "./types";

interface RequestHistoryPanelProps {
  requestHistory: RequestHistoryItem[];
  fileInputRef: React.RefObject<HTMLInputElement>;
  onImport: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onExport: () => void;
  onClear: () => void;
  onLoad: (item: RequestHistoryItem) => void;
}

export function RequestHistoryPanel({
  requestHistory, fileInputRef, onImport, onExport, onClear, onLoad,
}: RequestHistoryPanelProps) {
  return (
    <Card className="mb-6">
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <History className="w-4 h-4" />
            Request History
            <Badge variant="secondary">{requestHistory.length}/{MAX_HISTORY_ITEMS}</Badge>
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <input ref={fileInputRef} type="file" accept=".json" onChange={onImport} className="hidden" />
            <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} className="gap-2">
              <Upload className="w-4 h-4" /> Import
            </Button>
            {requestHistory.length > 0 && (
              <>
                <Button variant="outline" size="sm" onClick={onExport} className="gap-2">
                  <Download className="w-4 h-4" /> Export
                </Button>
                <Button variant="ghost" size="sm" onClick={onClear} className="text-destructive hover:text-destructive gap-2">
                  <Trash2 className="w-4 h-4" /> Clear All
                </Button>
              </>
            )}
          </div>
        </div>
        <CardDescription>
          Your last {MAX_HISTORY_ITEMS} API requests are saved locally. Export to share or backup.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {requestHistory.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <History className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p>No request history yet</p>
            <p className="text-sm">Send a request to start building history</p>
          </div>
        ) : (
          <ScrollArea className="h-[300px]">
            <div className="space-y-2">
              {requestHistory.map((item) => (
                <div
                  key={item.id}
                  className={cn(
                    "p-3 rounded-lg border cursor-pointer transition-colors hover:bg-muted/50",
                    item.response.success ? "border-green-500/20" : "border-red-500/20"
                  )}
                  onClick={() => onLoad(item)}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Badge variant={item.response.success ? "default" : "destructive"}>
                        {item.response.status}
                      </Badge>
                      <span className="font-medium text-sm">{item.request.operation}</span>
                      <div className="flex items-center gap-1">
                        {item.request.platforms.map((p) => (
                          <PlatformIcon key={p} platform={p as ExtendedPlatform} size="xs" />
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Clock className="w-3 h-3" />
                      {item.response.duration}ms
                      <span>•</span>
                      {new Date(item.timestamp).toLocaleTimeString()}
                    </div>
                  </div>
                  <div className="text-sm text-muted-foreground truncate">
                    {item.request.caption ? (
                      <span>"{item.request.caption.substring(0, 60)}{item.request.caption.length > 60 ? "..." : ""}"</span>
                    ) : (
                      <span className="italic">No caption</span>
                    )}
                  </div>
                  {!item.response.success && item.response.error && (
                    <div className="text-xs text-destructive mt-1 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" />
                      {item.response.error.substring(0, 80)}{item.response.error.length > 80 ? "..." : ""}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
