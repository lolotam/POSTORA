import { memo, useState, useCallback, useEffect } from "react";
import { Handle, Position, type NodeProps, NodeResizer, useReactFlow } from "@xyflow/react";
import { Type, Sparkles, Hash, Loader2, Copy, Trash2, Maximize2, ArrowRight, AlertCircle, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface TextCaptionNodeData extends Record<string, unknown> {
  caption?: string;
  hashtags?: string[];
}

const PLATFORM_LIMITS: Record<string, number> = {
  twitter: 280,
  instagram: 2200,
  facebook: 63206,
  linkedin: 3000,
  tiktok: 2200,
  youtube: 5000,
  threads: 500,
};

function TextCaptionNodeComponent({ id, data, selected }: NodeProps) {
  const nodeData = data as TextCaptionNodeData;
  const { toast } = useToast();
  const { setNodes, getNodes } = useReactFlow();
  const [caption, setCaption] = useState(nodeData.caption || "");
  const [hashtags, setHashtags] = useState<string[]>(nodeData.hashtags || []);
  const [isGeneratingCaption, setIsGeneratingCaption] = useState(false);
  const [isGeneratingHashtags, setIsGeneratingHashtags] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showExpanded, setShowExpanded] = useState(false);

  // Sync caption to node data via setNodes
  const updateNodeData = useCallback((updates: Partial<TextCaptionNodeData>) => {
    setNodes(nds => nds.map(n => 
      n.id === id ? { ...n, data: { ...n.data, ...updates } } : n
    ));
  }, [id, setNodes]);

  useEffect(() => {
    updateNodeData({ caption, hashtags });
  }, [caption, hashtags]);

  const handleGenerateCaption = useCallback(async () => {
    setIsGeneratingCaption(true);
    try {
      const { data, error } = await supabase.functions.invoke("generate-caption", {
        body: {
          context: caption || "social media post",
          tone: "engaging",
          platform: "instagram",
        },
      });
      if (error) throw error;
      if (data?.caption) {
        setCaption(data.caption);
        toast({ title: "Caption generated!" });
      }
    } catch (error: any) {
      toast({ title: "Generation failed", description: error.message, variant: "destructive" });
    } finally {
      setIsGeneratingCaption(false);
    }
  }, [caption, toast]);

  const handleGenerateHashtags = useCallback(async () => {
    if (!caption.trim()) {
      toast({ title: "Write a caption first", variant: "destructive" });
      return;
    }
    setIsGeneratingHashtags(true);
    try {
      const { data, error } = await supabase.functions.invoke("generate-hashtags", {
        body: { caption, platform: "instagram" },
      });
      if (error) throw error;
      if (data?.hashtags) {
        setHashtags(data.hashtags);
        toast({ title: "Hashtags generated!" });
      }
    } catch (error: any) {
      toast({ title: "Generation failed", description: error.message, variant: "destructive" });
    } finally {
      setIsGeneratingHashtags(false);
    }
  }, [caption, toast]);

  const handleDuplicate = useCallback(() => {
    const currentNode = getNodes().find(n => n.id === id);
    if (!currentNode) return;
    const newNode = {
      ...currentNode,
      id: `text_caption-${Date.now()}`,
      position: { x: currentNode.position.x + 50, y: currentNode.position.y + 50 },
      selected: false,
      data: { ...currentNode.data },
    };
    setNodes(nds => [...nds, newNode]);
    toast({ title: "Node duplicated" });
  }, [id, getNodes, setNodes, toast]);

  const fullText = caption + (hashtags.length > 0 ? "\n\n" + hashtags.join(" ") : "");
  const charCount = fullText.length;
  const isValid = caption.trim().length > 0;

  return (
    <div className="relative">
      <Handle
        type="source"
        position={Position.Right}
        id="caption"
        className="!w-8 !h-8 !border-2 !bg-card !rounded-full !border-blue-500 hover:!bg-blue-500/20 flex items-center justify-center transition-all duration-200 hover:scale-110 !absolute !-right-4 !top-6"
      >
        <ArrowRight className="h-3.5 w-3.5 text-blue-500" style={{ pointerEvents: 'none' }} />
      </Handle>

      {/* Floating Label with status */}
      <div className="absolute -top-8 start-6 flex items-center gap-1.5 px-2.5 py-1 bg-card rounded-lg text-xs font-medium text-muted-foreground border border-border/50 z-10">
        <Type className="h-3.5 w-3.5" />
        <span>Caption</span>
        {isValid ? (
          <Check className="h-3 w-3 text-green-500" />
        ) : (
          <AlertCircle className="h-3 w-3 text-amber-500" />
        )}
      </div>

      {/* Floating Toolbar */}
      {selected && (
        <div className="absolute -top-14 start-1/2 -translate-x-1/2 z-20">
          <div className="flex items-center gap-0.5 px-1.5 py-1 bg-card border border-border/50 rounded-xl shadow-lg">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost" size="icon"
                  className="h-7 w-7 rounded-lg hover:bg-purple-500/20 hover:text-purple-400"
                  onClick={handleGenerateCaption}
                  disabled={isGeneratingCaption}
                >
                  {isGeneratingCaption ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>AI Generate Caption</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost" size="icon"
                  className="h-7 w-7 rounded-lg hover:bg-blue-500/20 hover:text-blue-400"
                  onClick={handleGenerateHashtags}
                  disabled={isGeneratingHashtags}
                >
                  {isGeneratingHashtags ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Hash className="h-3.5 w-3.5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Generate Hashtags</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7 rounded-lg hover:bg-muted" onClick={() => setShowExpanded(true)}>
                  <Maximize2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Expand</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7 rounded-lg hover:bg-muted" onClick={handleDuplicate}>
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Duplicate</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost" size="icon"
                  className="h-7 w-7 rounded-lg hover:bg-destructive/20 hover:text-destructive"
                  onClick={() => setShowDeleteConfirm(true)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Delete</TooltipContent>
            </Tooltip>
          </div>
        </div>
      )}

      {/* Main Node */}
      <div
        className={cn(
          "min-w-[360px] rounded-2xl overflow-hidden transition-all duration-300",
          "bg-card",
          selected
            ? "node-glow-caption"
            : "border-2 border-blue-500/30 hover:border-blue-500/50"
        )}
        style={{ minHeight: 220 }}
      >
        {/* Category accent strip */}
        <div className="h-1 bg-blue-500/80" />
        <NodeResizer
          color="hsl(220 90% 56%)"
          isVisible={selected}
          minWidth={360}
          minHeight={220}
          handleStyle={{ width: 8, height: 8, borderRadius: '50%', border: '2px solid hsl(220 90% 56%)', background: 'hsl(var(--card))' }}
          lineStyle={{ borderColor: 'hsl(220 90% 56%)', borderWidth: 1 }}
        />

        <div className="p-4 space-y-3">
          {/* Caption Textarea */}
          <Textarea
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="Write your post caption here..."
            className="min-h-[100px] resize-none text-sm bg-muted/30 border-border/50 focus:border-blue-500/50"
          />

          {/* Hashtags */}
          {hashtags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {hashtags.map((tag, i) => (
                <Badge key={i} variant="secondary" className="text-[10px] cursor-pointer hover:bg-primary/20 group/tag flex items-center gap-0.5">
                  <span onClick={() => {
                    const hashtagText = tag.startsWith('#') ? tag : `#${tag}`;
                    setCaption(prev => prev ? `${prev} ${hashtagText}` : hashtagText);
                    setHashtags(h => h.filter((_, idx) => idx !== i));
                  }}>{tag}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); setHashtags(h => h.filter((_, idx) => idx !== i)); }}
                    className="ms-0.5 opacity-60 hover:opacity-100 hover:text-destructive"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </Badge>
              ))}
            </div>
          )}

          {/* Footer with char count & AI buttons */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="h-7 text-[10px] gap-1" onClick={handleGenerateCaption} disabled={isGeneratingCaption}>
                {isGeneratingCaption ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                AI Caption
              </Button>
              <Button variant="outline" size="sm" className="h-7 text-[10px] gap-1" onClick={handleGenerateHashtags} disabled={isGeneratingHashtags || !caption.trim()}>
                {isGeneratingHashtags ? <Loader2 className="h-3 w-3 animate-spin" /> : <Hash className="h-3 w-3" />}
                Hashtags
              </Button>
            </div>
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
              <span className={cn(charCount > 2200 ? "text-amber-500" : charCount > 280 ? "text-blue-500" : "")}>
                {charCount}
              </span>
              {Object.entries(PLATFORM_LIMITS).map(([platform, limit]) => (
                charCount > limit ? (
                  <span key={platform} className="text-amber-500" title={`Over ${platform} limit`}>
                    !{platform.charAt(0).toUpperCase()}
                  </span>
                ) : null
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Expanded Dialog */}
      <Dialog open={showExpanded} onOpenChange={setShowExpanded}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Caption</DialogTitle>
          </DialogHeader>
          <Textarea
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            className="min-h-[300px] text-base"
            placeholder="Write your post caption..."
          />
          <div className="flex justify-between items-center">
            <span className="text-sm text-muted-foreground">{charCount} characters</span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleGenerateCaption} disabled={isGeneratingCaption}>
                <Sparkles className="h-4 w-4 me-1" /> AI Caption
              </Button>
              <Button variant="outline" size="sm" onClick={handleGenerateHashtags} disabled={isGeneratingHashtags}>
                <Hash className="h-4 w-4 me-1" /> Hashtags
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete node?</AlertDialogTitle>
            <AlertDialogDescription>This will permanently delete this Caption node.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => setNodes(nodes => nodes.filter(n => n.id !== id))}
            >Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export const TextCaptionNode = memo(TextCaptionNodeComponent);
