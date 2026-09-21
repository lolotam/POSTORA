import { memo } from "react";
import { Play, Maximize2, Sparkles, Link2, Copy, Trash2, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface NodeFloatingToolbarProps {
  isVisible: boolean;
  onRun?: () => void;
  onExpand?: () => void;
  onAI?: () => void;
  onLink?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
  onDownload?: () => void;
  showRun?: boolean;
  showExpand?: boolean;
  showAI?: boolean;
  showDownload?: boolean;
}

function NodeFloatingToolbarComponent({
  isVisible,
  onRun,
  onExpand,
  onAI,
  onLink,
  onDuplicate,
  onDelete,
  onDownload,
  showRun = true,
  showExpand = true,
  showAI = true,
  showDownload = false,
}: NodeFloatingToolbarProps) {
  if (!isVisible) return null;

  return (
    <div className="absolute -top-12 start-1/2 -translate-x-1/2 z-20">
      <div className="flex items-center gap-0.5 px-1.5 py-1 bg-card/95 backdrop-blur-md border border-border/50 rounded-xl shadow-lg">
        {showRun && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-lg hover:bg-primary/20 hover:text-primary"
                onClick={onRun}
              >
                <Play className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Run</TooltipContent>
          </Tooltip>
        )}
        
        {showExpand && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-lg hover:bg-muted"
                onClick={onExpand}
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Expand</TooltipContent>
          </Tooltip>
        )}

        {showAI && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-lg hover:bg-purple-500/20 hover:text-purple-400"
                onClick={onAI}
              >
                <Sparkles className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>AI Enhance</TooltipContent>
          </Tooltip>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-lg hover:bg-muted"
              onClick={onLink}
            >
              <Link2 className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Copy Link</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-lg hover:bg-muted"
              onClick={onDuplicate}
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Duplicate</TooltipContent>
        </Tooltip>

        {showDownload && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-lg hover:bg-muted"
                onClick={onDownload}
              >
                <Download className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Download</TooltipContent>
          </Tooltip>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-lg hover:bg-destructive/20 hover:text-destructive"
              onClick={onDelete}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Delete</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

export const NodeFloatingToolbar = memo(NodeFloatingToolbarComponent);
