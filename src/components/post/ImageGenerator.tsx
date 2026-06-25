import { useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { ImagePlus, Loader2, Upload, Sparkles, Download, FolderOpen, X, Image, ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { handleAIError } from "@/lib/aiErrorHandler";
import { MediaLibraryPicker } from "./MediaLibraryPicker";
import { StockMediaPicker, SelectedMedia } from "./StockMediaPicker";
import { UploadedFile } from "@/hooks/usePostForm";
import { useAIRateLimit } from "@/hooks/useAIRateLimit";
import { RateLimitIndicator } from "./RateLimitIndicator";
import { DraggableReferenceImage, ReferenceImage, ReferenceType } from "./DraggableReferenceImage";
import { ReferencePresets } from "./ReferencePresets";
import { Icon3D, GradientHeading, Reveal, GradientDivider, GradientRingCard } from "@/components/fx";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";

interface ImageGeneratorProps {
  onImageGenerated: (imageUrl: string, imageBlob: Blob) => void;
  buttonClassName?: string;
}

const imageModels = [
  {
    value: "google/gemini-2.5-flash-image",
    label: "Nano Banana",
    description: "Fast & affordable image generation",
    badge: null,
    supportsReference: true,
  },
  {
    value: "google/gemini-3-pro-image-preview",
    label: "Nano Banana Pro",
    description: "State-of-the-art quality",
    badge: "Pro",
    supportsReference: true,
  },
  {
    value: "imagen-4.0-generate-001",
    label: "Imagen 4",
    description: "Better text rendering & quality",
    badge: null,
    supportsReference: false,
  },
  {
    value: "imagen-4.0-ultra-generate-001",
    label: "Imagen 4 Ultra",
    description: "Highest quality image generation",
    badge: "Ultra",
    supportsReference: false,
  },
];

// All aspect ratios available
const allAspectRatios = [
  { value: "1:1", label: "Square (1:1)", width: 1024, height: 1024 },
  { value: "16:9", label: "Landscape (16:9)", width: 1920, height: 1080 },
  { value: "9:16", label: "Portrait (9:16)", width: 1080, height: 1920 },
  { value: "4:5", label: "Portrait (4:5)", width: 1080, height: 1350 },
  { value: "4:3", label: "Standard (4:3)", width: 1440, height: 1080 },
  { value: "2:3", label: "Vertical (2:3)", width: 1080, height: 1620 },
];

// Platform-specific supported aspect ratios
const platformAspectRatios: Record<string, string[]> = {
  all: ["1:1", "16:9", "9:16", "4:5", "4:3", "2:3"],
  youtube: ["16:9"],
  tiktok: ["9:16"],
  instagram: ["1:1", "4:5", "9:16", "16:9"],
  facebook: ["1:1", "4:5", "16:9", "9:16"],
  twitter: ["16:9", "1:1"],
  linkedin: ["1:1", "16:9", "9:16"],
  pinterest: ["2:3", "1:1"],
};

const platformOptions = [
  { value: "all", label: "All Platforms" },
  { value: "youtube", label: "YouTube" },
  { value: "tiktok", label: "TikTok" },
  { value: "instagram", label: "Instagram" },
  { value: "facebook", label: "Facebook" },
  { value: "twitter", label: "Twitter/X" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "pinterest", label: "Pinterest" },
];

const qualityOptions = [
  { value: "1k", label: "1K (1024px)", multiplier: 1 },
  { value: "2k", label: "2K (2048px)", multiplier: 2 },
  { value: "3k", label: "3K (3072px)", multiplier: 3 },
];

const MAX_REFERENCE_IMAGES = 5;

export function ImageGenerator({ onImageGenerated, buttonClassName }: ImageGeneratorProps) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("google/gemini-2.5-flash-image");
  const [selectedPlatform, setSelectedPlatform] = useState("all");
  const [aspectRatio, setAspectRatio] = useState("1:1");
  const [quality, setQuality] = useState("1k");
  const [referenceImages, setReferenceImages] = useState<ReferenceImage[]>([]);
  const [generatedImage, setGeneratedImage] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [isStockPickerOpen, setIsStockPickerOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const { profile } = useAuth();
  const { imageLimit, refreshLimits } = useAIRateLimit();

  const isRateLimited = imageLimit.remainingHour === 0 && imageLimit.limitPerHour > 0;

  // DnD sensors for drag-and-drop
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Check if current model supports reference images
  const currentModelConfig = imageModels.find(m => m.value === model);
  const supportsReference = currentModelConfig?.supportsReference ?? false;

  // Get filtered aspect ratios based on selected platform
  const filteredAspectRatios = allAspectRatios.filter((ratio) =>
    platformAspectRatios[selectedPlatform]?.includes(ratio.value)
  );

  // Reset aspect ratio when platform changes if current ratio is not supported
  const handlePlatformChange = (platform: string) => {
    setSelectedPlatform(platform);
    const supportedRatios = platformAspectRatios[platform] || [];
    if (!supportedRatios.includes(aspectRatio)) {
      setAspectRatio(supportedRatios[0] || "1:1");
    }
  };

  // Generate unique ID for reference images
  const generateRefId = () => `ref-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  const handleReferenceUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    const remainingSlots = MAX_REFERENCE_IMAGES - referenceImages.length;
    const filesToProcess = Array.from(files).slice(0, remainingSlots);

    filesToProcess.forEach(file => {
      const reader = new FileReader();
      reader.onload = (event) => {
        setReferenceImages(prev => {
          if (prev.length >= MAX_REFERENCE_IMAGES) return prev;
          return [...prev, {
            id: generateRefId(),
            url: event.target?.result as string,
            type: "style" as ReferenceType,
          }];
        });
      };
      reader.readAsDataURL(file);
    });

    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleLibrarySelect = (files: UploadedFile[]) => {
    const remainingSlots = MAX_REFERENCE_IMAGES - referenceImages.length;
    const filesToAdd = files.slice(0, remainingSlots);
    
    setReferenceImages(prev => [
      ...prev,
      ...filesToAdd.map(f => ({
        id: generateRefId(),
        url: f.previewUrl || f.cloudinaryUrl || "",
        type: "style" as ReferenceType,
      }))
    ].slice(0, MAX_REFERENCE_IMAGES));
    
    setIsLibraryOpen(false);
  };

  const removeReferenceImage = useCallback((id: string) => {
    setReferenceImages(prev => prev.filter(img => img.id !== id));
  }, []);

  const handleReferenceTypeChange = useCallback((id: string, type: ReferenceType) => {
    setReferenceImages(prev => prev.map(img => 
      img.id === id ? { ...img, type } : img
    ));
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setReferenceImages(prev => {
        const oldIndex = prev.findIndex(img => img.id === active.id);
        const newIndex = prev.findIndex(img => img.id === over.id);
        return arrayMove(prev, oldIndex, newIndex);
      });
    }
  }, []);

  const handleStockMediaSelect = (media: SelectedMedia) => {
    const remainingSlots = MAX_REFERENCE_IMAGES - referenceImages.length;
    if (remainingSlots <= 0) return;
    
    // Use thumbnailUrl for reference images (smaller size for AI reference)
    const imageUrl = media.thumbnailUrl || media.url;
    setReferenceImages(prev => [...prev, {
      id: generateRefId(),
      url: imageUrl,
      type: "style" as ReferenceType,
    }].slice(0, MAX_REFERENCE_IMAGES));
    setIsStockPickerOpen(false);
  };

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      toast({
        title: "Enter a prompt",
        description: "Describe the image you want to generate.",
        variant: "destructive",
      });
      return;
    }

    setIsGenerating(true);
    setGeneratedImage(null);

    try {
      const selectedRatio = allAspectRatios.find((r) => r.value === aspectRatio);
      const qualityOption = qualityOptions.find((q) => q.value === quality);

      // Prepare reference images for the API
      const referenceImagesData = referenceImages.map((ref, idx) => ({
        url: ref.url,
        type: ref.type,
        priority: idx + 1,
      }));

      const { data, error } = await supabase.functions.invoke("generate-image", {
        body: {
          prompt,
          model,
          aspectRatio,
          quality,
          referenceImage: supportsReference && referenceImages.length > 0 ? referenceImages[0].url : undefined,
          referenceImages: supportsReference && referenceImages.length > 0 ? referenceImagesData : undefined,
          width: selectedRatio ? selectedRatio.width * (qualityOption?.multiplier || 1) : 1024,
          height: selectedRatio ? selectedRatio.height * (qualityOption?.multiplier || 1) : 1024,
        },
      });

      if (error) {
        console.error('Image generation error:', error);
        const status = (error as any)?.status;
        const errorMessage = (error as any)?.message || error?.toString() || 'Unknown error';

        // Try to parse the actual error from the edge function response
        let actualError = errorMessage;
        try {
          // Supabase wraps errors, try to extract the real message
          if (typeof (error as any)?.context?.body === 'string') {
            const parsed = JSON.parse((error as any).context.body);
            actualError = parsed.error || actualError;
          }
        } catch (e) {
          // Keep the original error message
        }

        if (status === 401 || actualError.toLowerCase().includes("invalid jwt") || actualError.toLowerCase().includes("unauthorized")) {
          handleAIError({ status: 401, message: "Session expired. Please refresh and try again." }, "Image generation");
          return;
        }
        if (status === 402 || actualError.toLowerCase().includes("credits")) {
          handleAIError({ status: 402, message: actualError }, "Image generation");
          return;
        }
        if (status === 429 || actualError.toLowerCase().includes("rate limit")) {
          handleAIError({ status: 429, message: "Too many requests. Please wait a moment and try again." }, "Image generation");
          return;
        }

        // Show specific error for API key issues
        if (actualError.includes("API_KEY") || actualError.includes("not configured")) {
          toast({
            title: "Configuration Error",
            description: "The AI image service is not properly configured. Please contact support.",
            variant: "destructive",
          });
          return;
        }

        toast({
          title: "Image generation Failed",
          description: actualError.includes("non-2xx") ?
            "The AI service is temporarily unavailable. Please try again later or use a different model." :
            actualError,
          variant: "destructive",
        });
        return;
      }

      // New structured failure shape from edge function (returns 200 with success:false)
      if (data && data.success === false) {
        const code = data.error_code as string | undefined;
        const message = data.message as string | undefined;
        if (code === 'ai_credits_exhausted') {
          handleAIError({ status: 402, message: message || 'Credits exhausted' }, 'Image generation');
        } else if (code === 'ai_rate_limited') {
          handleAIError({ status: 429, message: message || 'Rate limited' }, 'Image generation');
        } else {
          toast({
            title: 'Image generation Failed',
            description: message || 'The AI service is temporarily unavailable. Please try again later or use a different model.',
            variant: 'destructive',
          });
        }
        return;
      }

      if (data?.error) {
        const errorMsg = data.error.toLowerCase();
        if (errorMsg.includes("401") || errorMsg.includes("unauthorized")) {
          handleAIError({ status: 401, message: data.error }, "Image generation");
        } else if (errorMsg.includes("402") || errorMsg.includes("credits")) {
          handleAIError({ status: 402, message: data.error }, "Image generation");
        } else if (errorMsg.includes("429") || errorMsg.includes("rate limit")) {
          handleAIError({ status: 429, message: data.error }, "Image generation");
        } else {
          throw new Error(data.error);
        }
        return;
      }

      if (data?.imageUrl) {
        setGeneratedImage(data.imageUrl);
        toast({
          title: "Image generated!",
          description: "Your AI image is ready. Click 'Use Image' to add it to your post.",
        });
        // Refresh rate limits after successful generation
        refreshLimits();
      }
    } catch (error) {
      handleAIError(error, "Image generation");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleUseImage = async () => {
    if (!generatedImage) return;

    try {
      // Convert base64 to blob
      const response = await fetch(generatedImage);
      const blob = await response.blob();

      onImageGenerated(generatedImage, blob);
      setOpen(false);
      resetForm();

      toast({
        title: "Image added!",
        description: "The generated image has been added to your post.",
      });
    } catch (error) {
      toast({
        title: "Failed to add image",
        description: "Could not process the generated image.",
        variant: "destructive",
      });
    }
  };

  const handleDownload = () => {
    if (!generatedImage) return;

    const link = document.createElement("a");
    link.href = generatedImage;
    link.download = `generated-image-${Date.now()}.png`;
    link.click();
  };

  const resetForm = () => {
    setPrompt("");
    setModel("google/gemini-2.5-flash-image");
    setSelectedPlatform("all");
    setAspectRatio("1:1");
    setQuality("1k");
    setReferenceImages([]);
    setGeneratedImage(null);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button 
            variant="outline" 
            size="sm" 
            className={cn(
              "gap-1.5 whitespace-nowrap h-7 px-2 text-xs group transition-all duration-300",
              "hover:!bg-primary hover:!text-primary-foreground hover:!border-primary hover:shadow-md hover:scale-105",
              buttonClassName
            )}
          >
            <Sparkles className="w-3 h-3 transition-transform duration-300 group-hover:rotate-12 group-hover:scale-110" />
            Generate with AI
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto bg-card/80 backdrop-blur-xl border-border/50 shadow-2xl shadow-violet-500/10">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3 group">
              <Icon3D icon={Sparkles} variant="violet" size="sm" />
              <GradientHeading as="h2" size="lg" preset="sky-violet-pink" className="!text-2xl md:!text-3xl">
                AI Image Generator
              </GradientHeading>
              {imageLimit.limitPerHour > 0 && (
                <RateLimitIndicator
                  limitPerHour={imageLimit.limitPerHour}
                  limitPerDay={imageLimit.limitPerDay}
                  remainingHour={imageLimit.remainingHour}
                  remainingDay={imageLimit.remainingDay}
                  resetTimeHour={imageLimit.resetTimeHour}
                  resetTimeDay={imageLimit.resetTimeDay}
                  label="Image Generation"
                  compact
                  className="ml-auto"
                />
              )}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-6 pt-4">
            {/* Rate Limit Warning */}
            {isRateLimited && (
              <Reveal>
                <GradientRingCard variant="rose" hoverLift={false} ringIntensity="subtle" innerClassName="p-3">
                  <p className="text-sm font-medium text-rose-700 dark:text-rose-300">
                    You've reached your hourly image generation limit.
                  </p>
                  <p className="text-xs text-rose-600/80 dark:text-rose-300/80 mt-1">
                    Please wait for it to reset before generating more images.
                  </p>
                </GradientRingCard>
              </Reveal>
            )}

            {/* Prompt */}
            <div className="space-y-2">
              <Label>Describe your image</Label>
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="A professional product photo of a modern smartphone on a marble surface with soft lighting..."
                className="min-h-[100px]"
                disabled={isRateLimited}
              />
            </div>

            {/* Model Selection */}
            <div className="space-y-2">
              <Label>AI Model</Label>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-background border border-border z-50">
                  {imageModels.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{m.label}</span>
                        {m.badge && (
                          <Badge variant="secondary" className="text-xs">
                            {m.badge}
                          </Badge>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground block">{m.description}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Reference Images - Only show for Nano Banana models */}
            {supportsReference && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Reference Images (optional, up to {MAX_REFERENCE_IMAGES})</Label>
                  <ReferencePresets
                    currentImages={referenceImages}
                    onLoadPreset={setReferenceImages}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={handleReferenceUpload}
                    className="hidden"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                    className="gap-2"
                    disabled={referenceImages.length >= MAX_REFERENCE_IMAGES}
                  >
                    <Upload className="w-4 h-4" />
                    Upload
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setIsLibraryOpen(true)}
                    className="gap-2"
                    disabled={referenceImages.length >= MAX_REFERENCE_IMAGES}
                  >
                    <FolderOpen className="w-4 h-4" />
                    Library
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setIsStockPickerOpen(true)}
                    className="gap-2"
                    disabled={referenceImages.length >= MAX_REFERENCE_IMAGES}
                  >
                    <ImageIcon className="w-4 h-4" />
                    Stock
                  </Button>
                  
                  {/* Reference image previews with drag-and-drop */}
                  {referenceImages.length > 0 && (
                    <DndContext
                      sensors={sensors}
                      collisionDetection={closestCenter}
                      onDragEnd={handleDragEnd}
                    >
                      <SortableContext
                        items={referenceImages.map(img => img.id)}
                        strategy={horizontalListSortingStrategy}
                      >
                        <div className="flex flex-wrap gap-2">
                          {referenceImages.map((img, index) => (
                            <DraggableReferenceImage
                              key={img.id}
                              image={img}
                              index={index}
                              onRemove={removeReferenceImage}
                              onTypeChange={handleReferenceTypeChange}
                            />
                          ))}
                        </div>
                      </SortableContext>
                    </DndContext>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Drag to reorder (first = most influence). Select type for each reference ({referenceImages.length}/{MAX_REFERENCE_IMAGES})
                </p>
              </div>
            )}

            {/* Platform Selection */}
            <div className="space-y-2">
              <Label>Target Platform</Label>
              <Select value={selectedPlatform} onValueChange={handlePlatformChange}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-background border border-border z-50">
                  {platformOptions.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Select a platform to show only supported aspect ratios
              </p>
            </div>

            {/* Options Row */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Aspect Ratio</Label>
                <Select value={aspectRatio} onValueChange={setAspectRatio}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-background border border-border z-50">
                    {filteredAspectRatios.map((ratio) => (
                      <SelectItem key={ratio.value} value={ratio.value}>
                        {ratio.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedPlatform !== "all" && (
                  <p className="text-xs text-muted-foreground">
                    Showing {filteredAspectRatios.length} ratio{filteredAspectRatios.length !== 1 ? "s" : ""} for {platformOptions.find(p => p.value === selectedPlatform)?.label}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label>Quality</Label>
                <Select value={quality} onValueChange={setQuality}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-background border border-border z-50">
                    {qualityOptions.map((q) => (
                      <SelectItem key={q.value} value={q.value}>
                        {q.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <GradientDivider />

            {/* Generate Button */}
            <Button
              onClick={handleGenerate}
              disabled={isGenerating || !prompt.trim() || isRateLimited}
              className="w-full bg-gradient-to-r from-violet-500 via-fuchsia-500 to-sky-500 text-white shadow-lg shadow-violet-500/30 hover:shadow-violet-500/50 hover:opacity-95 transition-all border-0"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Generating...
                </>
              ) : isRateLimited ? (
                "Rate limit reached"
              ) : (
                <>
                  <Sparkles className="w-4 h-4 mr-2" />
                  Generate Image
                </>
              )}
            </Button>

            {/* Generated Image Preview */}
            {generatedImage && (
              <Reveal>
                <GradientRingCard variant="emerald" hoverLift={false} ringIntensity="subtle" innerClassName="p-3 space-y-4">
                  <div className="rounded-xl overflow-hidden border border-emerald-400/30 shadow-lg shadow-emerald-500/20">
                    <img
                      src={generatedImage}
                      alt="Generated"
                      className="w-full h-auto"
                    />
                  </div>
                  <div className="flex gap-3">
                    <Button onClick={handleUseImage} className="flex-1 bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500 text-white shadow-md shadow-emerald-500/30 hover:shadow-emerald-500/50 border-0">
                      <ImagePlus className="w-4 h-4 mr-2" />
                      Use Image
                    </Button>
                    <Button variant="outline" onClick={handleDownload} className="bg-card/50 backdrop-blur-sm border-border/50 hover:border-emerald-400/60">
                      <Download className="w-4 h-4 mr-2" />
                      Download
                    </Button>
                  </div>
                </GradientRingCard>
              </Reveal>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Media Library Picker for reference images */}
      <MediaLibraryPicker
        open={isLibraryOpen}
        onOpenChange={setIsLibraryOpen}
        onSelect={handleLibrarySelect}
        maxFiles={MAX_REFERENCE_IMAGES}
        currentFileCount={referenceImages.length}
        imagesOnly={true}
        showExtendedFilters={true}
      />

      {/* Stock Media Picker for reference images - Photos only from Pexels/Pixabay */}
      <StockMediaPicker
        open={isStockPickerOpen}
        onOpenChange={setIsStockPickerOpen}
        onSelect={handleStockMediaSelect}
        photosOnly={true}
      />
    </>
  );
}
