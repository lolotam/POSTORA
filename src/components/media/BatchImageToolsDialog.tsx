import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { supabase } from "@/integrations/supabase/client";
import { readUploadRefusal } from "@/components/media/uploadErrors";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2,
  Scissors,
  Maximize2,
  Wand2,
  Palette,
  Sparkles,
  Sun,
  Contrast,
  Droplets,
  CircleDot,
  ZoomIn,
  Focus,
  Eraser,
  Image,
  CheckCircle2,
  XCircle,
  Clock,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useCdnConfig } from "@/hooks/useCdnConfig";
import {
  cloudinaryTransformsState,
  isProviderUnavailable,
  runBackgroundRemoval,
  runUpscale,
} from "@/components/media/image-tools/aiImageTools";

interface BatchFile {
  id: string;
  publicUrl: string;
  cloudinary_public_id?: string;
  storage_bucket: string;
  folder_path?: string;
  file_path: string;
}

interface BatchImageToolsDialogProps {
  open: boolean;
  onClose: () => void;
  files: BatchFile[];
  cloudName: string;
  onProcessComplete?: () => void;
}

type EdgeMode = "none" | "fine";
type ResizeMode = "original" | "square" | "portrait" | "landscape";
type CropMode = "fill" | "fit" | "scale" | "crop" | "pad";
type ArtisticFilter = "none" | "al_dente" | "athena" | "audrey" | "aurora" | "daguerre" | "eucalyptus" | "fes" | "frost" | "hairspray" | "hokusai" | "incognito" | "linen" | "peacock" | "primavera" | "quartz" | "red_rock" | "refresh" | "sizzle" | "sonnet" | "ukulele" | "zorro";

type ProcessStatus = "pending" | "processing" | "success" | "error";

interface FileProcessState {
  id: string;
  fileName: string;
  status: ProcessStatus;
  error?: string;
}

const RESIZE_PRESETS: Record<ResizeMode, { label: string; width: number | null; height: number | null }> = {
  original: { label: "Original", width: null, height: null },
  square: { label: "Square (1:1)", width: 1024, height: 1024 },
  portrait: { label: "Portrait (4:5)", width: 1080, height: 1350 },
  landscape: { label: "Landscape (16:9)", width: 1920, height: 1080 },
};

const ARTISTIC_FILTERS: Record<ArtisticFilter, string> = {
  none: "None",
  al_dente: "Al Dente",
  athena: "Athena",
  audrey: "Audrey",
  aurora: "Aurora",
  daguerre: "Daguerre",
  eucalyptus: "Eucalyptus",
  fes: "Fes",
  frost: "Frost",
  hairspray: "Hairspray",
  hokusai: "Hokusai",
  incognito: "Incognito",
  linen: "Linen",
  peacock: "Peacock",
  primavera: "Primavera",
  quartz: "Quartz",
  red_rock: "Red Rock",
  refresh: "Refresh",
  sizzle: "Sizzle",
  sonnet: "Sonnet",
  ukulele: "Ukulele",
  zorro: "Zorro",
};

const QUALITY_PRESETS = {
  auto: { label: "Auto (recommended)", value: "auto" },
  best: { label: "Best Quality", value: "100" },
  high: { label: "High (80%)", value: "80" },
  medium: { label: "Medium (60%)", value: "60" },
};

export function BatchImageToolsDialog({
  open,
  onClose,
  files,
  cloudName,
  onProcessComplete,
}: BatchImageToolsDialogProps) {
  const cdn = useCdnConfig();
  // `loading` until the CDN config is known; `unavailable` means only the server-side AI steps
  // (background removal, upscale) work.
  const cdnState = cloudinaryTransformsState(cdn);
  const transformsUnavailable = cdnState === "unavailable";
  const [processing, setProcessing] = useState(false);
  const [fileStates, setFileStates] = useState<FileProcessState[]>([]);
  
  // Feature toggles
  const [enableBgRemoval, setEnableBgRemoval] = useState(false);
  const [enableResize, setEnableResize] = useState(false);
  const [enableUpscale, setEnableUpscale] = useState(false);
  const [enableFilters, setEnableFilters] = useState(false);
  const [enableQuality, setEnableQuality] = useState(false);
  
  // Background removal options
  const [edgeMode, setEdgeMode] = useState<EdgeMode>("none");
  
  // Resize options
  const [resizeMode, setResizeMode] = useState<ResizeMode>("square");
  const [cropMode, setCropMode] = useState<CropMode>("fill");
  
  // Filter options
  const [brightness, setBrightness] = useState(0);
  const [contrast, setContrast] = useState(0);
  const [saturation, setSaturation] = useState(0);
  const [blur, setBlur] = useState(0);
  const [sharpening, setSharpening] = useState(0);
  const [noiseReduction, setNoiseReduction] = useState(0);
  const [artisticFilter, setArtisticFilter] = useState<ArtisticFilter>("none");
  
  // Upscale options
  const [upscaleMode, setUpscaleMode] = useState<"standard" | "enhance" | "restore">("standard");
  
  // Quality options
  const [qualityPreset, setQualityPreset] = useState<keyof typeof QUALITY_PRESETS>("auto");
  const [outputFormat, setOutputFormat] = useState<"auto" | "jpg" | "png" | "webp">("auto");
  
  const { t } = useTranslation("assets");
  const { toast } = useToast();
  const resizeLabels: Record<ResizeMode, string> = {
    original: t("imageTools.resize.original", "Original"),
    square: t("imageTools.resize.square", "Square (1:1)"),
    portrait: t("imageTools.resize.portrait", "Portrait (4:5)"),
    landscape: t("imageTools.resize.landscape", "Landscape (16:9)"),
  };
  const qualityLabels = {
    auto: t("imageTools.qualityPreset.auto", "Auto (recommended)"),
    best: t("imageTools.qualityPreset.best", "Best Quality"),
    high: t("imageTools.qualityPreset.high", "High (80%)"),
    medium: t("imageTools.qualityPreset.medium", "Medium (60%)"),
  };
  const artisticLabels: Record<ArtisticFilter, string> = {
    none: t("imageTools.artistic.none", "None"),
    al_dente: t("imageTools.artistic.al_dente", "Al Dente"),
    athena: t("imageTools.artistic.athena", "Athena"),
    audrey: t("imageTools.artistic.audrey", "Audrey"),
    aurora: t("imageTools.artistic.aurora", "Aurora"),
    daguerre: t("imageTools.artistic.daguerre", "Daguerre"),
    eucalyptus: t("imageTools.artistic.eucalyptus", "Eucalyptus"),
    fes: t("imageTools.artistic.fes", "Fes"),
    frost: t("imageTools.artistic.frost", "Frost"),
    hairspray: t("imageTools.artistic.hairspray", "Hairspray"),
    hokusai: t("imageTools.artistic.hokusai", "Hokusai"),
    incognito: t("imageTools.artistic.incognito", "Incognito"),
    linen: t("imageTools.artistic.linen", "Linen"),
    peacock: t("imageTools.artistic.peacock", "Peacock"),
    primavera: t("imageTools.artistic.primavera", "Primavera"),
    quartz: t("imageTools.artistic.quartz", "Quartz"),
    red_rock: t("imageTools.artistic.red_rock", "Red Rock"),
    refresh: t("imageTools.artistic.refresh", "Refresh"),
    sizzle: t("imageTools.artistic.sizzle", "Sizzle"),
    sonnet: t("imageTools.artistic.sonnet", "Sonnet"),
    ukulele: t("imageTools.artistic.ukulele", "Ukulele"),
    zorro: t("imageTools.artistic.zorro", "Zorro"),
  };

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (open) {
      setFileStates(files.map(f => ({
        id: f.id,
        fileName: f.file_path.split("/").pop() || "file",
        status: "pending" as ProcessStatus,
      })));
      setEnableBgRemoval(false);
      setEnableResize(false);
      setEnableUpscale(false);
      setEnableFilters(false);
      setEnableQuality(false);
      setEdgeMode("none");
      setResizeMode("square");
      setCropMode("fill");
      setBrightness(0);
      setContrast(0);
      setSaturation(0);
      setBlur(0);
      setSharpening(0);
      setNoiseReduction(0);
      setArtisticFilter("none");
      setUpscaleMode("standard");
      setQualityPreset("auto");
      setOutputFormat("auto");
    }
  }, [open, files]);

  // Resize, filters, quality and the fine-edges / enhance / restore variants are Cloudinary
  // transforms. Once they are known to be unavailable their controls are disabled, so anything
  // already chosen would stay chosen with no way to change it.
  useEffect(() => {
    if (!transformsUnavailable) return;
    setEnableResize(false);
    setEnableFilters(false);
    setEnableQuality(false);
    setEdgeMode("none");
    setUpscaleMode("standard");
  }, [transformsUnavailable]);

  const hasFilterModifications = brightness !== 0 || contrast !== 0 || saturation !== 0 || blur > 0 || sharpening > 0 || noiseReduction > 0 || artisticFilter !== "none";

  const buildCloudinaryUrl = (publicId: string, targetCloudName: string) => {
    const transformations: string[] = [];

    // Add resize FIRST
    if (enableResize && resizeMode !== "original") {
      const preset = RESIZE_PRESETS[resizeMode];
      if (preset.width && preset.height) {
        transformations.push(`w_${preset.width},h_${preset.height},c_${cropMode}`);
      }
    }

    // Add background removal
    if (enableBgRemoval) {
      if (edgeMode === "fine") {
        transformations.push("e_background_removal:fineedges_y");
      } else {
        transformations.push("e_background_removal");
      }
    }
    
    // Add upscale
    if (enableUpscale) {
      if (upscaleMode === "enhance") {
        transformations.push("e_upscale");
        transformations.push("e_enhance");
      } else if (upscaleMode === "restore") {
        transformations.push("e_upscale");
        transformations.push("e_gen_restore");
      } else {
        transformations.push("e_upscale");
      }
    }
    
    // Add filters and effects
    if (enableFilters && hasFilterModifications) {
      const filterParts: string[] = [];
      
      if (brightness !== 0) filterParts.push(`e_brightness:${brightness}`);
      if (contrast !== 0) filterParts.push(`e_contrast:${contrast}`);
      if (saturation !== 0) filterParts.push(`e_saturation:${saturation}`);
      if (blur > 0) filterParts.push(`e_blur:${blur * 10}`);
      if (sharpening > 0) filterParts.push(`e_sharpen:${Math.round(sharpening * 10)}`);
      if (noiseReduction > 0) filterParts.push(`e_improve:indoor:${Math.round(noiseReduction)}`);
      if (artisticFilter !== "none") filterParts.push(`e_art:${artisticFilter}`);
      
      if (filterParts.length > 0) {
        transformations.push(filterParts.join(","));
      }
    }
    
    // Add quality settings
    if (enableQuality) {
      const qualityParts: string[] = [];
      if (qualityPreset === "auto") {
        qualityParts.push("q_auto");
      } else {
        qualityParts.push(`q_${QUALITY_PRESETS[qualityPreset].value}`);
      }
      if (outputFormat !== "auto") {
        qualityParts.push(`f_${outputFormat}`);
      } else {
        qualityParts.push("f_auto");
      }
      if (qualityParts.length > 0) {
        transformations.push(qualityParts.join(","));
      }
    }

    const transformString = transformations.join("/");
    return `https://res.cloudinary.com/${targetCloudName}/image/upload/${transformString}/${publicId}`;
  };

  const uploadToCloudinary = async (file: BatchFile): Promise<{ publicId: string; cloudName: string; url: string }> => {
    const response = await fetch(file.publicUrl);
    const blob = await response.blob();

    const reader = new FileReader();
    const base64Promise = new Promise<string>((resolve, reject) => {
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    const base64Data = await base64Promise;

    const fileName = file.file_path.split("/").pop() || `image-${Date.now()}`;

    const { data, error } = await supabase.functions.invoke("cloudinary-upload", {
      body: {
        fileData: base64Data,
        fileName: fileName,
        fileType: "image",
        // Staging copy for the transform only: not a Library file, not an upload.
        skipMediaFiles: true,
      },
    });

    if (error) throw error;
    if (!data?.success) throw new Error(data?.error || "Upload failed");

    const urlMatch = data.url.match(/res\.cloudinary\.com\/([^\/]+)/);
    const extractedCloudName = urlMatch ? urlMatch[1] : "";

    return {
      publicId: data.publicId,
      cloudName: extractedCloudName,
      url: data.url,
    };
  };

  // Cloudinary is not serving transforms: the AI steps run on the server, one after the other on
  // the file's public URL (background removal first, then upscale). The server picks the
  // provider. A cut-out has transparency, so the upscale after it asks for PNG.
  const fetchServerProcessedBlob = async (file: BatchFile): Promise<Blob> => {
    let currentUrl = file.publicUrl;
    if (enableBgRemoval) currentUrl = await runBackgroundRemoval(currentUrl);
    if (enableUpscale) currentUrl = await runUpscale(currentUrl, enableBgRemoval ? { outputFormat: "png" } : {});
    const response = await fetch(currentUrl);
    if (!response.ok) throw new Error(`Failed to fetch processed image: ${response.status}`);
    return response.blob();
  };

  const fetchCloudinaryProcessedBlob = async (file: BatchFile): Promise<Blob> => {
    const isCloudinaryFile = file.storage_bucket === "cloudinary" && !!file.cloudinary_public_id;
    
    let publicId: string;
    let targetCloudName: string;

    if (isCloudinaryFile) {
      publicId = file.cloudinary_public_id!;
      targetCloudName = cloudName;
    } else {
      const uploadResult = await uploadToCloudinary(file);
      publicId = uploadResult.publicId;
      targetCloudName = uploadResult.cloudName;
    }

    const processedUrl = buildCloudinaryUrl(publicId, targetCloudName);

    // Fetch processed image with retry
    let imageBlob: Blob | null = null;
    let attempts = 0;
    const maxAttempts = 10;

    while (!imageBlob && attempts < maxAttempts) {
      const response = await fetch(processedUrl);
      if (response.ok) {
        imageBlob = await response.blob();
        break;
      }
      if (response.status === 423) {
        attempts++;
        await new Promise(resolve => setTimeout(resolve, 3000));
      } else {
        throw new Error(`Failed to fetch processed image: ${response.status}`);
      }
    }

    if (!imageBlob) {
      throw new Error("Processing timed out");
    }
    return imageBlob;
  };

  const processFile = async (file: BatchFile): Promise<void> => {
    const imageBlob = transformsUnavailable
      ? await fetchServerProcessedBlob(file)
      : await fetchCloudinaryProcessedBlob(file);

    // Convert to base64 and upload
    const reader = new FileReader();
    const base64Promise = new Promise<string>((resolve, reject) => {
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(imageBlob);
    });
    const base64Data = await base64Promise;

    const originalName = file.file_path.split("/").pop()?.replace(/\.[^.]+$/, "") || "processed";
    const suffix = [
      enableBgRemoval && "bg-removed",
      enableResize && resizeMode !== "original" && resizeMode,
      enableUpscale && "upscaled",
      enableFilters && hasFilterModifications && "filtered",
    ].filter(Boolean).join("-");
    
    // No extension: the upload takes the type from the bytes. Openinary delivery can serve WebP
    // for a .png path, and a forced .png would then be refused as a content/extension mismatch.
    const newFileName = `${originalName}_${suffix || "processed"}_${Date.now()}`;

    const { data: uploadData, error: uploadError } = await supabase.functions.invoke("cloudinary-upload", {
      body: {
        fileData: base64Data,
        fileName: newFileName,
        fileType: "image",
      },
    });

    if (uploadError) throw new Error((await readUploadRefusal(uploadError)) || "Upload failed");
    if (!uploadData?.success) throw new Error(uploadData?.error || "Upload failed");

    // cloudinary-upload already created the library row (and its provider rows).
    // Inserting another one here doubled every batch result and its quota count;
    // the result only needs to land in the source file's folder.
    if (file.folder_path && uploadData.mediaFileId) {
      const { error: folderError } = await supabase
        .from("media_files")
        .update({ folder_path: file.folder_path })
        .eq("id", uploadData.mediaFileId);
      if (folderError) throw new Error(folderError.message);
    }
  };

  const handleProcess = async () => {
    if (cdnState === "loading") return;
    const hasValidResize = enableResize && resizeMode !== "original";
    const hasValidFilters = enableFilters && hasFilterModifications;
    
    if (!enableBgRemoval && !hasValidResize && !enableUpscale && !hasValidFilters && !enableQuality) {
      toast({
        title: t("toast.noFeatures", "No features selected"),
        description: t("toast.noFeaturesDesc", "Please enable at least one transformation"),
        variant: "destructive",
      });
      return;
    }

    setProcessing(true);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      
      setFileStates(prev => prev.map(fs => 
        fs.id === file.id ? { ...fs, status: "processing" } : fs
      ));

      try {
        await processFile(file);
        setFileStates(prev => prev.map(fs => 
          fs.id === file.id ? { ...fs, status: "success" } : fs
        ));
      } catch (error) {
        console.error(`Error processing ${file.file_path}:`, error);
        setFileStates(prev => prev.map(fs => 
          fs.id === file.id ? { 
            ...fs, 
            status: "error", 
            error: isProviderUnavailable(error)
              ? t("toast.aiToolUnavailable", "This AI tool is temporarily unavailable. Please try again later.")
              : error instanceof Error ? error.message : "Unknown error",
          } : fs
        ));
      }
    }

    setProcessing(false);
    
    const successCount = fileStates.filter(fs => fs.status === "success").length + 1;
    toast({
      title: t("toast.batchComplete", "Batch processing complete"),
      description: t("toast.batchCompleteDesc", "Successfully processed {{success}} of {{total}} images", { success: successCount, total: files.length }),
    });
    
    onProcessComplete?.();
  };

  const completedCount = fileStates.filter(fs => fs.status === "success").length;
  const errorCount = fileStates.filter(fs => fs.status === "error").length;
  const processingIndex = fileStates.findIndex(fs => fs.status === "processing");

  const getStatusIcon = (status: ProcessStatus) => {
    switch (status) {
      case "pending": return <Clock className="w-4 h-4 text-muted-foreground" />;
      case "processing": return <Loader2 className="w-4 h-4 text-primary animate-spin" />;
      case "success": return <CheckCircle2 className="w-4 h-4 text-green-500" />;
      case "error": return <XCircle className="w-4 h-4 text-destructive" />;
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && !processing && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="w-5 h-5" />
            {t("batch.title", "Batch Image Processing ({{count}} images)", { count: files.length })}
          </DialogTitle>
          <DialogDescription>
            {t("batch.subtitle", "Apply the same transformations to all selected images.")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 pe-2">
          {transformsUnavailable && (
            <Alert>
              <AlertDescription>
                {t("imageTools.aiOnlyNotice", "Only background removal and upscale are available right now. Resize, filters and quality are turned off.")}
              </AlertDescription>
            </Alert>
          )}

          {/* Feature Toggles */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 p-3 bg-muted/50 rounded-lg">
            <div className="flex items-center justify-between p-2 border rounded-md bg-background">
              <div className="flex items-center gap-1.5">
                <Scissors className="w-3.5 h-3.5 text-primary" />
                <Label className="text-[11px] font-medium">{t("imageTools.bgRemove", "BG Remove")}</Label>
              </div>
              <Switch
                checked={enableBgRemoval}
                onCheckedChange={setEnableBgRemoval}
                disabled={processing}
                className="scale-75"
              />
            </div>

            <div className="flex items-center justify-between p-2 border rounded-md bg-background">
              <div className="flex items-center gap-1.5">
                <Maximize2 className="w-3.5 h-3.5 text-primary" />
                <Label className="text-[11px] font-medium">{t("imageTools.resize.label", "Resize")}</Label>
              </div>
              <Switch
                checked={enableResize}
                onCheckedChange={setEnableResize}
                disabled={processing || transformsUnavailable}
                className="scale-75"
              />
            </div>
            
            <div className="flex items-center justify-between p-2 border rounded-md bg-background">
              <div className="flex items-center gap-1.5">
                <ZoomIn className="w-3.5 h-3.5 text-primary" />
                <Label className="text-[11px] font-medium">{t("imageTools.upscale", "Upscale")}</Label>
              </div>
              <Switch
                checked={enableUpscale}
                onCheckedChange={setEnableUpscale}
                disabled={processing}
                className="scale-75"
              />
            </div>
            
            <div className="flex items-center justify-between p-2 border rounded-md bg-background">
              <div className="flex items-center gap-1.5">
                <Palette className="w-3.5 h-3.5 text-primary" />
                <Label className="text-[11px] font-medium">{t("imageTools.filters", "Filters")}</Label>
              </div>
              <Switch
                checked={enableFilters}
                onCheckedChange={setEnableFilters}
                disabled={processing || transformsUnavailable}
                className="scale-75"
              />
            </div>
            
            <div className="flex items-center justify-between p-2 border rounded-md bg-background">
              <div className="flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-primary" />
                <Label className="text-[11px] font-medium">{t("imageTools.quality", "Quality")}</Label>
              </div>
              <Switch
                checked={enableQuality}
                onCheckedChange={setEnableQuality}
                disabled={processing || transformsUnavailable}
                className="scale-75"
              />
            </div>
          </div>

          {/* Options Panels */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Left column - BG Removal, Resize, Upscale */}
            <div className="space-y-4">
              {enableBgRemoval && (
                <div className="p-3 border rounded-lg space-y-2">
                  <Label className="text-xs font-medium">{t("batch.edgeQuality", "Edge Quality")}</Label>
                  <Select value={edgeMode} onValueChange={(v) => setEdgeMode(v as EdgeMode)} disabled={processing || transformsUnavailable}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{t("batch.standard", "Standard")}</SelectItem>
                      <SelectItem value="fine">{t("batch.fineEdges", "Fine Edges")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              {enableResize && (
                <div className="p-3 border rounded-lg space-y-2">
                  <Label className="text-xs font-medium">{t("batch.resizePreset", "Resize Preset")}</Label>
                  <Select value={resizeMode} onValueChange={(v) => setResizeMode(v as ResizeMode)} disabled={processing}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(RESIZE_PRESETS).map(([key]) => (
                        <SelectItem key={key} value={key}>{resizeLabels[key as ResizeMode]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={cropMode} onValueChange={(v) => setCropMode(v as CropMode)} disabled={processing}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="fill">{t("batch.crop.fill", "Fill")}</SelectItem>
                      <SelectItem value="fit">{t("batch.crop.fit", "Fit")}</SelectItem>
                      <SelectItem value="scale">{t("batch.crop.scale", "Scale")}</SelectItem>
                      <SelectItem value="crop">{t("batch.crop.crop", "Crop")}</SelectItem>
                      <SelectItem value="pad">{t("batch.crop.pad", "Pad")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              {enableUpscale && (
                <div className="p-3 border rounded-lg space-y-2">
                  <Label className="text-xs font-medium">{t("batch.upscaleMode", "Upscale Mode")}</Label>
                  <Select value={upscaleMode} onValueChange={(v) => setUpscaleMode(v as "standard" | "enhance" | "restore")} disabled={processing || transformsUnavailable}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="standard">{t("batch.standard", "Standard")}</SelectItem>
                      <SelectItem value="enhance">{t("batch.upscaleEnhance", "Upscale + Enhance")}</SelectItem>
                      <SelectItem value="restore">{t("batch.upscaleRestore", "Upscale + Restore")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              {enableQuality && (
                <div className="p-3 border rounded-lg space-y-2">
                  <Label className="text-xs font-medium">{t("batch.qualityFormat", "Quality & Format")}</Label>
                  <Select value={qualityPreset} onValueChange={(v) => setQualityPreset(v as any)} disabled={processing}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(QUALITY_PRESETS).map(([key]) => (
                        <SelectItem key={key} value={key}>{qualityLabels[key as keyof typeof qualityLabels]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={outputFormat} onValueChange={(v) => setOutputFormat(v as any)} disabled={processing}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">{t("batch.format.auto", "Auto")}</SelectItem>
                      <SelectItem value="jpg">{t("batch.format.jpg", "JPG")}</SelectItem>
                      <SelectItem value="png">{t("batch.format.png", "PNG")}</SelectItem>
                      <SelectItem value="webp">{t("batch.format.webp", "WebP")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            {/* Right column - Filters */}
            <div className="space-y-4">
              {enableFilters && (
                <div className="p-3 border rounded-lg space-y-3">
                  <Label className="text-xs font-medium">{t("imageTools.filtersEffects", "Filters & Effects")}</Label>
                  
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs flex items-center gap-1"><Sun className="w-3 h-3" /> {t("filters.brightness", "Brightness")}</span>
                      <span className="text-xs text-muted-foreground">{brightness}</span>
                    </div>
                    <Slider value={[brightness]} onValueChange={([v]) => setBrightness(v)} min={-100} max={100} disabled={processing} />
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs flex items-center gap-1"><Contrast className="w-3 h-3" /> {t("filters.contrast", "Contrast")}</span>
                      <span className="text-xs text-muted-foreground">{contrast}</span>
                    </div>
                    <Slider value={[contrast]} onValueChange={([v]) => setContrast(v)} min={-100} max={100} disabled={processing} />
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs flex items-center gap-1"><Droplets className="w-3 h-3" /> {t("filters.saturation", "Saturation")}</span>
                      <span className="text-xs text-muted-foreground">{saturation}</span>
                    </div>
                    <Slider value={[saturation]} onValueChange={([v]) => setSaturation(v)} min={-100} max={100} disabled={processing} />
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs flex items-center gap-1"><Focus className="w-3 h-3" /> {t("filters.sharpening", "Sharpening")}</span>
                      <span className="text-xs text-muted-foreground">{sharpening}</span>
                    </div>
                    <Slider value={[sharpening]} onValueChange={([v]) => setSharpening(v)} min={0} max={100} disabled={processing} />
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs flex items-center gap-1"><Eraser className="w-3 h-3" /> {t("filters.noiseReduction", "Noise Reduction")}</span>
                      <span className="text-xs text-muted-foreground">{noiseReduction}</span>
                    </div>
                    <Slider value={[noiseReduction]} onValueChange={([v]) => setNoiseReduction(v)} min={0} max={100} disabled={processing} />
                  </div>

                  <div className="space-y-2">
                    <span className="text-xs">{t("batch.artisticFilter", "Artistic Filter")}</span>
                    <Select value={artisticFilter} onValueChange={(v) => setArtisticFilter(v as ArtisticFilter)} disabled={processing}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(ARTISTIC_FILTERS).map(([key]) => (
                          <SelectItem key={key} value={key}>{artisticLabels[key as ArtisticFilter]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Processing Status */}
          {processing && (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span>{t("batch.processingOf", "Processing {{current}} of {{total}}...", { current: processingIndex + 1, total: files.length })}</span>
                <span className="text-muted-foreground">{t("batch.progressSummary", "{{completed}} completed, {{failed}} failed", { completed: completedCount, failed: errorCount })}</span>
              </div>
              <Progress value={(completedCount / files.length) * 100} className="h-2" />
            </div>
          )}

          {/* File List */}
          <div className="border rounded-lg">
            <div className="p-2 border-b bg-muted/50">
              <span className="text-xs font-medium">{t("batch.filesToProcess", "Files to process")}</span>
            </div>
            <ScrollArea className="h-40">
              <div className="p-2 space-y-1">
                {fileStates.map((fs) => (
                  <div 
                    key={fs.id} 
                    className={cn(
                      "flex items-center gap-2 p-2 rounded text-sm",
                      fs.status === "processing" && "bg-primary/10",
                      fs.status === "success" && "bg-green-500/10",
                      fs.status === "error" && "bg-destructive/10"
                    )}
                  >
                    {getStatusIcon(fs.status)}
                    <span className="flex-1 truncate">{fs.fileName}</span>
                    {fs.error && <span className="text-xs text-destructive truncate max-w-[200px]">{fs.error}</span>}
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        </div>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose} disabled={processing}>
            {processing ? t("common:status.processing", "Processing...") : t("common:cancel", "Cancel")}
          </Button>
          <Button onClick={handleProcess} disabled={processing || cdnState === "loading"}>
            {processing ? (
              <>
                <Loader2 className="w-4 h-4 me-2 animate-spin" />
                {t("batch.processingCount", "Processing {{current}}/{{total}}", { current: processingIndex + 1, total: files.length })}
              </>
            ) : (
              <>
                <Wand2 className="w-4 h-4 me-2" />
                {t("batch.processCount", "Process {{count}} Images", { count: files.length })}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
