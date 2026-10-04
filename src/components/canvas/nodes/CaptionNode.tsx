import { memo, useState, useCallback, useEffect } from "react";
import { Handle, Position, type NodeProps, NodeResizer, useReactFlow } from "@xyflow/react";
import { Image as ImageIcon, Loader2, Wand2, Play, Maximize2, Copy, Trash2, Minus, Plus, ArrowRight, Upload, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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

export interface CaptionNodeData extends Record<string, unknown> {
  caption?: string;
  hashtags?: string[];
  generatedImage?: string;
  onCaptionChange?: (caption: string) => void;
}

const MODEL_OPTIONS = [
  { value: "google/gemini-2.5-flash", label: "Google Nano Banana" },
  { value: "openai/gpt-4o", label: "GPT-4o" },
  { value: "anthropic/claude-3", label: "Claude 3" },
];

const ASPECT_RATIOS = [
  { value: "1:1", label: "1:1" },
  { value: "9:16", label: "9:16" },
  { value: "16:9", label: "16:9" },
  { value: "4:5", label: "4:5" },
];

function CaptionNodeComponent({ id, data, selected }: NodeProps) {
  const nodeData = data as CaptionNodeData;
  const { toast } = useToast();
  const { setNodes } = useReactFlow();
  const [prompt, setPrompt] = useState(nodeData.caption || "");
  const [isGenerating, setIsGenerating] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [model, setModel] = useState("google/gemini-2.5-flash");
  const [aspectRatio, setAspectRatio] = useState("9:16");
  const [imageCount, setImageCount] = useState(1);
  const [generatedImage, setGeneratedImage] = useState<string | null>(nodeData.generatedImage as string || null);
  const [referenceImage, setReferenceImage] = useState<string | null>(null);
  const [isDraggingRef, setIsDraggingRef] = useState(false);

  // Sync to node data
  const updateNodeData = useCallback((updates: Partial<CaptionNodeData>) => {
    setNodes(nds => nds.map(n => 
      n.id === id ? { ...n, data: { ...n.data, ...updates } } : n
    ));
  }, [id, setNodes]);

  useEffect(() => {
    updateNodeData({ caption: prompt, generatedImage: generatedImage || undefined });
  }, [prompt, generatedImage]);

  const handleReferenceUpload = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      setReferenceImage(e.target?.result as string);
    };
    reader.readAsDataURL(file);
  }, []);

  const handleRefDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingRef(false);
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      handleReferenceUpload(file);
    }
  }, [handleReferenceUpload]);

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim()) {
      toast({ title: "Enter a prompt", description: "Describe the image you want to generate.", variant: "destructive" });
      return;
    }

    setIsGenerating(true);
    try {
      const body: Record<string, unknown> = {
        prompt,
        model,
        aspectRatio,
        count: imageCount,
      };
      if (referenceImage) {
        body.referenceImage = referenceImage;
      }

      const { data, error } = await supabase.functions.invoke("generate-image", { body });

      if (error) throw error;

      if (data?.imageUrl) {
        setGeneratedImage(data.imageUrl);
        toast({ title: "Image generated!", description: "Your AI-generated image is ready." });
      }
    } catch (error: any) {
      console.error("Generation error:", error);
      toast({ 
        title: "Generation failed", 
        description: error.message || "Failed to generate image.",
        variant: "destructive" 
      });
    } finally {
      setIsGenerating(false);
    }
  }, [prompt, model, aspectRatio, imageCount, referenceImage, toast]);

  return (
    <div className="relative">
      {/* Output Handle - RIGHT side for connecting to Platform node */}
      <Handle
        type="source"
        position={Position.Right}
        id="image-out"
        className="!w-8 !h-8 !border-2 !bg-card !rounded-full !border-amber-500 hover:!bg-amber-500/20 flex items-center justify-center transition-all duration-200 hover:scale-110 !absolute !-right-4 !top-6"
      >
        <ArrowRight className="h-3.5 w-3.5 text-amber-500" style={{ pointerEvents: 'none' }} />
      </Handle>

      {/* Floating Label */}
      <div className="absolute -top-8 start-6 flex items-center gap-1.5 px-2.5 py-1 bg-card rounded-lg text-xs font-medium text-muted-foreground border border-border/50 z-10">
        <ImageIcon className="h-3.5 w-3.5" />
        <span>Image Generator</span>
      </div>

      {/* Floating Toolbar - only when selected */}
      {selected && (
        <div className="absolute -top-14 start-1/2 -translate-x-1/2 z-20">
          <div className="flex items-center gap-0.5 px-1.5 py-1 bg-card border border-border/50 rounded-xl shadow-lg">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button 
                  variant="ghost" size="icon" 
                  className="h-7 w-7 rounded-lg hover:bg-primary/20 hover:text-primary"
                  onClick={handleGenerate}
                  disabled={isGenerating}
                >
                  <Play className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Generate</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7 rounded-lg hover:bg-muted">
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

      {/* Main Node Container */}
      <div
        className={cn(
          "min-w-[380px] rounded-2xl overflow-hidden transition-all duration-300",
          "bg-card",
          selected 
            ? "node-glow-image-gen" 
            : "border-2 border-amber-500/30 hover:border-amber-500/50"
        )}
        style={{ minHeight: 320 }}
      >
        {/* Category accent strip */}
        <div className="h-1 bg-amber-500/80" />
        <NodeResizer
          color="hsl(38 92% 50%)"
          isVisible={selected}
          minWidth={380}
          minHeight={320}
          handleStyle={{ width: 8, height: 8, borderRadius: '50%', border: '2px solid hsl(38 92% 50%)', background: 'hsl(var(--card))' }}
          lineStyle={{ borderColor: 'hsl(38 92% 50%)', borderWidth: 1 }}
        />

        {/* Preview Area */}
        <div className="relative aspect-[4/3] bg-muted/30 flex items-center justify-center overflow-hidden">
          {generatedImage ? (
            <img src={generatedImage} alt="Generated" className="w-full h-full object-cover" />
          ) : (
            <div className="text-center p-6">
              <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mx-auto mb-3">
                <ImageIcon className="h-8 w-8 text-muted-foreground/50" />
              </div>
              <p className="text-sm text-muted-foreground">Image preview will appear here</p>
            </div>
          )}
        </div>

        {/* Prompt Input Area */}
        <div className="p-4 space-y-3">
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe the image you want to generate..."
            className="min-h-[80px] resize-none text-sm bg-muted/30 border-border/50 focus:border-primary/50"
          />

          {/* Reference Image Upload */}
          <div className="space-y-1.5">
            <Label className="text-[10px] text-muted-foreground flex items-center gap-1">
              <Upload className="h-3 w-3" /> Reference Image (optional)
            </Label>
            {referenceImage ? (
              <div className="relative rounded-lg overflow-hidden border border-border/50 h-20">
                <img src={referenceImage} alt="Reference" className="w-full h-full object-cover" />
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute top-1 end-1 h-5 w-5 bg-background/80 hover:bg-destructive/20 rounded-full"
                  onClick={() => setReferenceImage(null)}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            ) : (
              <div
                className={cn(
                  "border border-dashed rounded-lg p-3 text-center cursor-pointer transition-colors",
                  isDraggingRef ? "border-primary bg-primary/5" : "border-border/50 hover:border-border hover:bg-muted/20"
                )}
                onDragOver={(e) => { e.preventDefault(); setIsDraggingRef(true); }}
                onDragLeave={() => setIsDraggingRef(false)}
                onDrop={handleRefDrop}
                onClick={() => {
                  const input = document.createElement('input');
                  input.type = 'file';
                  input.accept = 'image/*';
                  input.onchange = (e) => {
                    const file = (e.target as HTMLInputElement).files?.[0];
                    if (file) handleReferenceUpload(file);
                  };
                  input.click();
                }}
              >
                <Upload className="h-4 w-4 mx-auto mb-1 text-muted-foreground/50" />
                <p className="text-[10px] text-muted-foreground">Drop or click to upload</p>
              </div>
            )}
          </div>

          {/* Controls Row */}
          <div className="flex items-center gap-2">
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger className="h-8 text-xs bg-muted/50 border-border/50 w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODEL_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value} className="text-xs">{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={aspectRatio} onValueChange={setAspectRatio}>
              <SelectTrigger className="h-8 text-xs bg-muted/50 border-border/50 w-[70px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASPECT_RATIOS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value} className="text-xs">{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="flex items-center gap-1 ms-auto">
              <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg" onClick={() => setImageCount(Math.max(1, imageCount - 1))} disabled={imageCount <= 1}>
                <Minus className="h-3 w-3" />
              </Button>
              <span className="text-sm font-medium w-4 text-center">{imageCount}</span>
              <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg" onClick={() => setImageCount(Math.min(4, imageCount + 1))} disabled={imageCount >= 4}>
                <Plus className="h-3 w-3" />
              </Button>
            </div>

            <Button
              size="icon"
              className="h-8 w-8 rounded-full bg-foreground text-background hover:bg-foreground/90"
              onClick={handleGenerate}
              disabled={isGenerating || !prompt.trim()}
            >
              {isGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4 fill-current" />}
            </Button>
          </div>
        </div>
      </div>

      {/* Delete Confirmation */}
      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete node?</AlertDialogTitle>
            <AlertDialogDescription>This will permanently delete this Image Generator node and its connections.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => setNodes((nodes) => nodes.filter((n) => n.id !== id))}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export const CaptionNode = memo(CaptionNodeComponent);
