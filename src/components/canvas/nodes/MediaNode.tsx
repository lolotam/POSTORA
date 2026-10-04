import { memo, useState, useCallback, useEffect } from "react";
import { Handle, Position, type NodeProps, NodeResizer, useReactFlow } from "@xyflow/react";
import { Image, Upload, Sparkles, FolderOpen, Plus, X, Loader2, Video, FileImage, RefreshCw, Play, Maximize2, Copy, Trash2, Download, Check, AlertCircle } from "lucide-react";
import { useDropzone } from "react-dropzone";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { MediaLibraryPicker } from "@/components/post/MediaLibraryPicker";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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

export interface MediaFile {
  id: string;
  url: string;
  type: 'image' | 'video';
  name: string;
  size?: number;
  width?: number;
  height?: number;
}

export interface MediaNodeData extends Record<string, unknown> {
  mediaFiles?: MediaFile[];
  activeTab?: 'upload' | 'library' | 'generate';
}

function MediaNodeComponent({ id, data, selected }: NodeProps) {
  const nodeData = data as MediaNodeData;
  const { user } = useAuth();
  const { toast } = useToast();
  const { setNodes, getNodes } = useReactFlow();
  const [activeTab, setActiveTab] = useState<string>(nodeData.activeTab || 'upload');
  const [mediaFiles, setMediaFiles] = useState<MediaFile[]>(nodeData.mediaFiles || []);
  const [generatePrompt, setGeneratePrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [showLibraryPicker, setShowLibraryPicker] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showUploadPanel, setShowUploadPanel] = useState(mediaFiles.length === 0);
  const [showExpanded, setShowExpanded] = useState(false);

  // Sync media files to node data
  const updateNodeData = useCallback((updates: Partial<MediaNodeData>) => {
    setNodes(nds => nds.map(n => 
      n.id === id ? { ...n, data: { ...n.data, ...updates } } : n
    ));
  }, [id, setNodes]);

  useEffect(() => {
    updateNodeData({ mediaFiles });
  }, [mediaFiles]);

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = (error) => reject(error);
    });
  };

  const handleUpload = useCallback(async (files: File[]) => {
    if (!user) {
      toast({ title: "Login required", variant: "destructive" });
      return;
    }
    setIsUploading(true);
    try {
      for (const file of files) {
        const base64Data = await fileToBase64(file);
        const { data, error } = await supabase.functions.invoke('cloudinary-upload', {
          body: { fileData: base64Data, fileName: file.name, fileType: file.type.startsWith('video/') ? 'video' : 'image', platforms: [], socialAccountIds: [] },
        });
        if (error) throw error;
        if (data?.url) {
          const newFile: MediaFile = {
            id: data.mediaFileId || `file-${Date.now()}`,
            url: data.url,
            type: file.type.startsWith('video/') ? 'video' : 'image',
            name: file.name,
            size: file.size,
          };
          setMediaFiles(prev => [...prev, newFile]);
          setShowUploadPanel(false);
        }
      }
      toast({ title: "Upload complete", description: `${files.length} file(s) uploaded.` });
    } catch (error: any) {
      toast({ title: "Upload failed", description: error.message, variant: "destructive" });
    } finally {
      setIsUploading(false);
    }
  }, [user, toast]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: handleUpload,
    accept: { 'image/*': ['.jpeg', '.jpg', '.png', '.gif', '.webp'], 'video/*': ['.mp4', '.mov', '.avi', '.webm'] },
    maxSize: 100 * 1024 * 1024,
    disabled: isUploading,
  });

  const handleLibrarySelect = useCallback((files: any[]) => {
    const newFiles: MediaFile[] = files.map(f => ({
      id: f.id,
      url: f.previewUrl || f.storageUrl || f.url || '',
      type: (f.fileType || f.type) === 'video' ? 'video' : 'image',
      name: f.name || f.file?.name || 'Media file',
    }));
    setMediaFiles(prev => [...prev, ...newFiles]);
    setShowLibraryPicker(false);
    setShowUploadPanel(false);
    toast({ title: "Media added", description: `${files.length} file(s) added.` });
  }, [toast]);

  const handleGenerateImage = useCallback(async () => {
    if (!generatePrompt.trim()) {
      toast({ title: "Enter a prompt", variant: "destructive" });
      return;
    }
    setIsGenerating(true);
    try {
      const { data, error } = await supabase.functions.invoke('generate-image', {
        body: { prompt: generatePrompt, style: 'realistic', size: '1024x1024' },
      });
      if (error) throw error;
      if (data?.imageUrl) {
        // Upload base64 to Cloudinary for a stable URL
        let finalUrl = data.imageUrl;
        if (data.imageUrl.startsWith('data:')) {
          try {
            const { data: uploadData, error: uploadError } = await supabase.functions.invoke('cloudinary-upload', {
              body: { fileData: data.imageUrl, fileName: `ai-generated-${Date.now()}.png`, fileType: 'image', platforms: [], socialAccountIds: [] },
            });
            if (!uploadError && uploadData?.url) {
              finalUrl = uploadData.url;
            }
          } catch (uploadErr) {
            console.warn("Cloudinary upload failed, using base64 URL:", uploadErr);
          }
        }
        const newFile: MediaFile = { id: `ai-${Date.now()}`, url: finalUrl, type: 'image', name: 'AI Generated Image', width: 1024, height: 1024 };
        setMediaFiles(prev => [...prev, newFile]);
        setGeneratePrompt("");
        setShowUploadPanel(false);
        toast({ title: "Image generated!" });
      }
    } catch (error: any) {
      toast({ title: "Generation failed", description: error.message, variant: "destructive" });
    } finally {
      setIsGenerating(false);
    }
  }, [generatePrompt, toast]);

  const removeFile = (fileId: string) => {
    setMediaFiles(prev => {
      const newFiles = prev.filter(f => f.id !== fileId);
      if (newFiles.length === 0) setShowUploadPanel(true);
      return newFiles;
    });
  };

  const handleDuplicate = useCallback(() => {
    const currentNode = getNodes().find(n => n.id === id);
    if (!currentNode) return;
    setNodes(nds => [...nds, {
      ...currentNode,
      id: `media-${Date.now()}`,
      position: { x: currentNode.position.x + 50, y: currentNode.position.y + 50 },
      selected: false,
      data: { ...currentNode.data },
    }]);
    toast({ title: "Node duplicated" });
  }, [id, getNodes, setNodes, toast]);

  const handleDownload = useCallback(() => {
    const primary = mediaFiles[0];
    if (!primary) return;
    const a = document.createElement('a');
    a.href = primary.url;
    a.download = primary.name;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [mediaFiles]);

  const primaryImage = mediaFiles[0];
  const hasMedia = mediaFiles.length > 0;
  const isValid = hasMedia;

  return (
    <div className="relative">
      {/* Floating Label with status */}
      <div className="absolute -top-8 start-6 flex items-center gap-1.5 px-2.5 py-1 bg-card rounded-lg text-xs font-medium text-muted-foreground border border-border/50 z-10">
        <Image className="h-3.5 w-3.5" />
        <span>Media</span>
        {isValid ? <Check className="h-3 w-3 text-green-500" /> : <AlertCircle className="h-3 w-3 text-amber-500" />}
      </div>

      {/* Floating Toolbar */}
      {selected && (
        <div className="absolute -top-14 start-1/2 -translate-x-1/2 z-20">
          <div className="flex items-center gap-0.5 px-1.5 py-1 bg-card border border-border/50 rounded-xl shadow-lg">
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
                <Button variant="ghost" size="icon" className="h-7 w-7 rounded-lg hover:bg-muted" onClick={handleDownload} disabled={!hasMedia}>
                  <Download className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Download</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7 rounded-lg hover:bg-destructive/20 hover:text-destructive" onClick={() => setShowDeleteConfirm(true)}>
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
          "min-w-[320px] rounded-2xl overflow-hidden transition-all duration-300",
          "bg-card",
          selected ? "node-glow-media" : "border-2 border-purple-500/30 hover:border-purple-500/50"
        )}
        style={{ minHeight: hasMedia && !showUploadPanel ? 'auto' : 280 }}
      >
        {/* Category accent strip */}
        <div className="h-1 bg-purple-500/80" />
        <NodeResizer
          color="hsl(270 90% 56%)"
          isVisible={selected}
          minWidth={320}
          minHeight={200}
          handleStyle={{ width: 8, height: 8, borderRadius: '50%', border: '2px solid hsl(270 90% 56%)', background: 'hsl(var(--card))' }}
          lineStyle={{ borderColor: 'hsl(270 90% 56%)', borderWidth: 1 }}
        />

        {/* Image Preview */}
        {hasMedia && !showUploadPanel && primaryImage && (
          <div className="relative">
            <div className="relative aspect-[3/4] max-h-[400px] overflow-hidden">
              {primaryImage.type === 'video' ? (
                <div className="w-full h-full flex items-center justify-center bg-muted">
                  <Video className="h-12 w-12 text-muted-foreground" />
                </div>
              ) : (
                <img src={primaryImage.url} alt={primaryImage.name} className="w-full h-full object-cover" />
              )}
              {primaryImage.width && primaryImage.height && (
                <div className="absolute top-3 end-3 px-2 py-1 bg-black/60 rounded text-[11px] text-white font-medium">
                  {primaryImage.width} × {primaryImage.height}
                </div>
              )}
              <button onClick={() => setShowUploadPanel(true)} className="absolute bottom-3 start-3 flex items-center gap-1.5 px-3 py-1.5 bg-card rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground border border-border/50 transition-colors">
                <RefreshCw className="h-3 w-3" /> Replace
              </button>
              {mediaFiles.length > 1 && (
                <div className="absolute bottom-3 end-3 px-2 py-1 bg-black/60 rounded text-[11px] text-white font-medium">
                  +{mediaFiles.length - 1} more
                </div>
              )}
            </div>
          </div>
        )}

        {/* Upload Panel */}
        {(!hasMedia || showUploadPanel) && (
          <div className="p-4 space-y-3">
            <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
              <TabsList className="grid w-full grid-cols-3 h-8 bg-muted/50">
                <TabsTrigger value="upload" className="text-xs gap-1"><Upload className="h-3 w-3" />Upload</TabsTrigger>
                <TabsTrigger value="library" className="text-xs gap-1"><FolderOpen className="h-3 w-3" />Library</TabsTrigger>
                <TabsTrigger value="generate" className="text-xs gap-1"><Sparkles className="h-3 w-3" />AI</TabsTrigger>
              </TabsList>

              <TabsContent value="upload" className="mt-3">
                <div
                  {...getRootProps()}
                  className={cn(
                    "border-2 border-dashed rounded-xl p-6 text-center transition-colors cursor-pointer min-h-[160px] flex flex-col items-center justify-center",
                    isDragActive ? "border-primary bg-primary/10" : "border-muted-foreground/20 hover:border-primary/50",
                    isUploading && "pointer-events-none opacity-50"
                  )}
                >
                  <input {...getInputProps()} />
                  {isUploading ? (
                    <><Loader2 className="h-10 w-10 text-primary mb-3 animate-spin" /><p className="text-sm text-muted-foreground">Uploading...</p></>
                  ) : isDragActive ? (
                    <><Upload className="h-10 w-10 text-primary mb-3" /><p className="text-sm text-primary font-medium">Drop files here</p></>
                  ) : (
                    <>
                      <div className="w-14 h-14 rounded-2xl bg-muted flex items-center justify-center mb-3"><Upload className="h-7 w-7 text-muted-foreground" /></div>
                      <p className="text-sm text-muted-foreground">Drop files or click to upload</p>
                      <p className="text-xs text-muted-foreground/70 mt-1">Images & Videos up to 100MB</p>
                    </>
                  )}
                </div>
              </TabsContent>

              <TabsContent value="library" className="mt-3">
                <div className="border-2 border-dashed border-muted-foreground/20 rounded-xl p-6 text-center min-h-[160px] flex flex-col items-center justify-center">
                  <div className="w-14 h-14 rounded-2xl bg-muted flex items-center justify-center mb-3"><FolderOpen className="h-7 w-7 text-muted-foreground" /></div>
                  <p className="text-sm text-muted-foreground mb-3">Browse your media library</p>
                  <Button variant="outline" size="sm" className="h-8" onClick={() => setShowLibraryPicker(true)}>Open Library</Button>
                </div>
              </TabsContent>

              <TabsContent value="generate" className="mt-3 space-y-3">
                <div className="space-y-2">
                  <Input value={generatePrompt} onChange={(e) => setGeneratePrompt(e.target.value)} placeholder="Describe the image..." className="text-sm h-10 bg-muted/50 border-border/50" disabled={isGenerating} />
                  <Button className="w-full h-9 gap-2 bg-primary hover:bg-primary/90" onClick={handleGenerateImage} disabled={isGenerating || !generatePrompt.trim()}>
                    {isGenerating ? <><Loader2 className="h-4 w-4 animate-spin" />Generating...</> : <><Sparkles className="h-4 w-4" />Generate Image</>}
                  </Button>
                </div>
              </TabsContent>
            </Tabs>

            {hasMedia && (
              <Button variant="ghost" size="sm" className="w-full text-xs" onClick={() => setShowUploadPanel(false)}>← Back to preview</Button>
            )}
          </div>
        )}
      </div>

      {/* Output Handle */}
      <Handle type="source" position={Position.Right} id="media"
        className="!w-8 !h-8 !border-2 !bg-card !rounded-full !border-purple-500 hover:!bg-purple-500/20 flex items-center justify-center transition-colors !absolute !-right-4 !-top-4"
      >
        <Image className="h-3.5 w-3.5 text-purple-500" style={{ pointerEvents: 'none' }} />
      </Handle>

      {/* Expanded Dialog */}
      <Dialog open={showExpanded} onOpenChange={setShowExpanded}>
        <DialogContent className="max-w-3xl max-h-[80vh]">
          <DialogHeader><DialogTitle>Media Files ({mediaFiles.length})</DialogTitle></DialogHeader>
          <div className="grid grid-cols-3 gap-3 overflow-y-auto max-h-[60vh]">
            {mediaFiles.map(file => (
              <div key={file.id} className="relative group rounded-lg overflow-hidden border border-border">
                {file.type === 'video' ? (
                  <div className="aspect-square flex items-center justify-center bg-muted"><Video className="h-8 w-8 text-muted-foreground" /></div>
                ) : (
                  <img src={file.url} alt={file.name} className="aspect-square object-cover" />
                )}
                <button onClick={() => removeFile(file.id)} className="absolute top-1 end-1 h-6 w-6 rounded-full bg-destructive/80 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                  <X className="h-3 w-3 text-white" />
                </button>
                <p className="absolute bottom-0 start-0 end-0 text-[10px] text-white bg-black/60 px-2 py-1 truncate">{file.name}</p>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete node?</AlertDialogTitle>
            <AlertDialogDescription>This will permanently delete this Media node.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => setNodes(nodes => nodes.filter(n => n.id !== id))}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <MediaLibraryPicker open={showLibraryPicker} onOpenChange={setShowLibraryPicker} onSelect={handleLibrarySelect} maxFiles={10} currentFileCount={mediaFiles.length} />
    </div>
  );
}

export const MediaNode = memo(MediaNodeComponent);
