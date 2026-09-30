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
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2,
  Download,
  RefreshCw,
  Upload,
  Wand2,
  Palette,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { parseApiError } from "@/lib/errorMessages";
import { readUploadRefusal } from "@/components/media/uploadErrors";
import { useLogMediaOperation, OperationType } from "@/hooks/useMediaOperationsHistory";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";

import {
  ImageToolsDialogProps,
  EdgeMode,
  ResizeMode,
  CropMode,
  ArtisticFilter,
  UpscaleMode,
  UpscalePlatform,
  QualityPreset,
  OutputFormat,
  TempCloudinaryData,
} from "./types";
import {
  getCropOverlayInfo,
  buildCloudinaryUrl,
  buildFilterPreviewUrl,
  getFilterCacheKey,
  getTargetDimensions,
  hasFilterModifications,
} from "./utils";
import { FeatureToggles } from "./FeatureToggles";
import {
  BgRemovalOptions,
  ResizeOptions,
  UpscaleOptions,
  FiltersOptions,
  QualityOptions,
} from "./options";

export function ImageToolsDialog({
  open,
  onClose,
  file,
  cloudName,
  onProcessComplete,
}: ImageToolsDialogProps) {
  const { flags } = useFeatureFlags();
  const [processing, setProcessing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [processedUrl, setProcessedUrl] = useState<string | null>(null);
  const [comparePosition, setComparePosition] = useState(50);
  
  // Feature toggles
  const [enableBgRemoval, setEnableBgRemoval] = useState(true);
  const [enableResize, setEnableResize] = useState(false);
  const [enableUpscale, setEnableUpscale] = useState(false);
  const [enableFilters, setEnableFilters] = useState(false);
  const [enableQuality, setEnableQuality] = useState(false);
  
  // Background removal options
  const [edgeMode, setEdgeMode] = useState<EdgeMode>("none");
  
  // Resize options
  const [resizeMode, setResizeMode] = useState<ResizeMode>("square");
  const [cropMode, setCropMode] = useState<CropMode>("fill");
  const [customWidth, setCustomWidth] = useState(1024);
  const [customHeight, setCustomHeight] = useState(1024);
  
  // Filter options
  const [brightness, setBrightness] = useState(0);
  const [contrast, setContrast] = useState(0);
  const [saturation, setSaturation] = useState(0);
  const [blur, setBlur] = useState(0);
  const [sharpening, setSharpening] = useState(0);
  const [noiseReduction, setNoiseReduction] = useState(0);
  const [artisticFilter, setArtisticFilter] = useState<ArtisticFilter>("none");
  
  // Upscale options
  const [upscaleMode, setUpscaleMode] = useState<UpscaleMode>("standard");
  const [upscalePlatform, setUpscalePlatform] = useState<UpscalePlatform>("cloudinary");
  
  // Quality options
  const [qualityPreset, setQualityPreset] = useState<QualityPreset>("auto");
  const [customQuality, setCustomQuality] = useState(80);
  const [outputFormat, setOutputFormat] = useState<OutputFormat>("auto");
  
  const [saving, setSaving] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [tempCloudinaryData, setTempCloudinaryData] = useState<TempCloudinaryData | null>(null);
  const [containerDimensions, setContainerDimensions] = useState({ width: 0, height: 0 });
  const [imageDimensions, setImageDimensions] = useState({ width: 0, height: 0 });
  const [livePreviewUrl, setLivePreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const previewDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewCacheRef = useRef<Map<string, string>>(new Map());
  const preloadImageRef = useRef<HTMLImageElement | null>(null);
  const { t } = useTranslation("assets");
  const { toast } = useToast();
  const { logOperation, completeOperation, failOperation } = useLogMediaOperation();
  const cropLabels: Record<CropMode, string> = {
    fill: t("imageTools.crop.fill", "Fill (crop to fit)"),
    fit: t("imageTools.crop.fit", "Fit (contain)"),
    scale: t("imageTools.crop.scale", "Scale"),
    crop: t("imageTools.crop.crop", "Crop (center)"),
    pad: t("imageTools.crop.pad", "Pad"),
  };
  const resizeLabels: Record<ResizeMode, string> = {
    original: t("imageTools.resize.original", "Original"),
    square: t("imageTools.resize.square", "Square (1:1)"),
    portrait: t("imageTools.resize.portrait", "Portrait (4:5)"),
    landscape: t("imageTools.resize.landscape", "Landscape (16:9)"),
    custom: t("imageTools.resize.custom", "Custom"),
  };
  
  const filterModified = hasFilterModifications(
    brightness, contrast, saturation, blur, sharpening, noiseReduction, artisticFilter
  );
  
  const targetDimensions = getTargetDimensions(enableResize, resizeMode, customWidth, customHeight);
  
  const cropOverlayInfo = targetDimensions && containerDimensions.width > 0 && imageDimensions.width > 0
    ? getCropOverlayInfo(
        containerDimensions.width,
        containerDimensions.height,
        targetDimensions.width,
        targetDimensions.height,
        imageDimensions.width,
        imageDimensions.height,
        cropMode
      )
    : null;

  const isCloudinaryFile = file?.storage_bucket === "cloudinary" && !!file?.cloudinary_public_id;

  // Track container dimensions
  useEffect(() => {
    if (!containerRef.current || !open) return;
    
    const updateDimensions = () => {
      if (containerRef.current) {
        setContainerDimensions({
          width: containerRef.current.offsetWidth,
          height: containerRef.current.offsetHeight,
        });
      }
    };
    
    updateDimensions();
    
    const resizeObserver = new ResizeObserver(updateDimensions);
    resizeObserver.observe(containerRef.current);
    
    return () => resizeObserver.disconnect();
  }, [open]);

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (open) {
      setProcessedUrl(null);
      setComparePosition(50);
      setEdgeMode("none");
      setEnableBgRemoval(true);
      setEnableResize(false);
      setEnableUpscale(false);
      setEnableFilters(false);
      setEnableQuality(false);
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
      setUpscalePlatform("cloudinary");
      setQualityPreset("auto");
      setCustomQuality(80);
      setOutputFormat("auto");
      setTempCloudinaryData(null);
      setUploading(false);
      setImageDimensions({ width: 0, height: 0 });
      setLivePreviewUrl(null);
      setPreviewLoading(false);
      previewCacheRef.current.clear();
    }
  }, [open]);

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setImageDimensions({
      width: img.naturalWidth,
      height: img.naturalHeight,
    });
    if (containerRef.current) {
      setContainerDimensions({
        width: containerRef.current.offsetWidth,
        height: containerRef.current.offsetHeight,
      });
    }
  };
  
  // Update live preview when filter values change
  useEffect(() => {
    if (!enableFilters || !filterModified) {
      setLivePreviewUrl(null);
      setPreviewLoading(false);
      return;
    }
    
    const publicId = isCloudinaryFile ? file?.cloudinary_public_id : tempCloudinaryData?.publicId;
    const targetCloudName = isCloudinaryFile ? cloudName : tempCloudinaryData?.cloudName;
    
    if (!publicId || !targetCloudName) {
      setLivePreviewUrl(null);
      return;
    }
    
    const cacheKey = `${publicId}-${getFilterCacheKey(brightness, contrast, saturation, blur, sharpening, noiseReduction, artisticFilter)}`;
    const cachedUrl = previewCacheRef.current.get(cacheKey);
    
    if (cachedUrl) {
      setLivePreviewUrl(cachedUrl);
      setPreviewLoading(false);
      return;
    }
    
    if (previewDebounceRef.current) {
      clearTimeout(previewDebounceRef.current);
    }
    
    setPreviewLoading(true);
    
    previewDebounceRef.current = setTimeout(() => {
      const previewUrl = buildFilterPreviewUrl(publicId, targetCloudName, {
        brightness, contrast, saturation, blur, sharpening, noiseReduction, artisticFilter
      });
      
      if (previewUrl) {
        if (preloadImageRef.current) {
          preloadImageRef.current.onload = null;
          preloadImageRef.current.onerror = null;
        }
        
        const preloadImg = new Image();
        preloadImageRef.current = preloadImg;
        
        preloadImg.onload = () => {
          previewCacheRef.current.set(cacheKey, previewUrl);
          if (previewCacheRef.current.size > 50) {
            const firstKey = previewCacheRef.current.keys().next().value;
            if (firstKey) previewCacheRef.current.delete(firstKey);
          }
          setLivePreviewUrl(previewUrl);
          setPreviewLoading(false);
        };
        
        preloadImg.onerror = () => {
          setPreviewLoading(false);
        };
        
        preloadImg.src = previewUrl;
      } else {
        setLivePreviewUrl(null);
        setPreviewLoading(false);
      }
    }, 80);
    
    return () => {
      if (previewDebounceRef.current) {
        clearTimeout(previewDebounceRef.current);
      }
    };
  }, [enableFilters, brightness, contrast, saturation, blur, sharpening, noiseReduction, artisticFilter, isCloudinaryFile, file?.cloudinary_public_id, cloudName, tempCloudinaryData, filterModified]);

  const uploadToCloudinary = async (): Promise<TempCloudinaryData> => {
    if (!file) throw new Error("No file selected");

    setUploading(true);

    try {
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

      if (error) throw new Error((await readUploadRefusal(error)) || "Upload failed");
      if (!data?.success) throw new Error(data?.error || "Upload failed");

      // Use cloudName from response directly, fallback to extracting from URL
      let extractedCloudName = data.cloudName;
      if (!extractedCloudName) {
        const urlMatch = data.url.match(/res\.cloudinary\.com\/([^\/]+)/);
        extractedCloudName = urlMatch ? urlMatch[1] : "";
      }

      if (!extractedCloudName) {
        throw new Error("Could not determine Cloudinary cloud name from upload response");
      }

      return {
        publicId: data.publicId,
        cloudName: extractedCloudName,
        url: data.url,
      };
    } finally {
      setUploading(false);
    }
  };

  const handleProcess = async () => {
    if (!file) return;

    const hasValidResize = enableResize && resizeMode !== "original";
    const hasValidFilters = enableFilters && filterModified;
    
    if (!enableBgRemoval && !hasValidResize && !enableUpscale && !hasValidFilters && !enableQuality) {
      toast({
        title: t("toast.noFeatures", "No features selected"),
        description: t("toast.noFeaturesConfigDesc", "Please enable and configure at least one transformation"),
        variant: "destructive",
      });
      return;
    }

    if (enableResize && resizeMode === "original" && !enableBgRemoval && !enableUpscale && !hasValidFilters && !enableQuality) {
      toast({
        title: t("toast.invalidResize", "Invalid resize"),
        description: t("toast.invalidResizeDesc", "Please select a resize preset or custom dimensions"),
        variant: "destructive",
      });
      return;
    }

    setProcessing(true);
    const startTime = Date.now();
    let operationId: string | null = null;

    // Determine primary operation type for logging
    const getOperationType = (): OperationType => {
      if (enableUpscale && upscalePlatform === "atlascloud") return "upscale";
      if (enableBgRemoval) return "background_removal";
      if (enableUpscale) return "upscale";
      if (hasValidResize) return "resize";
      if (hasValidFilters) return "filter";
      return "image_edit";
    };

    // Build operation details for logging
    const buildOperationDetails = () => {
      const details: Record<string, unknown> = {};
      const features: string[] = [];
      
      if (enableBgRemoval) {
        features.push("background_removal");
        details.edgeMode = edgeMode;
      }
      if (hasValidResize) {
        features.push("resize");
        details.resizeMode = resizeMode;
        details.cropMode = cropMode;
        if (resizeMode === "custom") {
          details.width = customWidth;
          details.height = customHeight;
        }
      }
      if (enableUpscale) {
        features.push("upscale");
        details.platform = upscalePlatform;
        details.scale = upscalePlatform === "atlascloud" ? 4 : 2;
        details.upscaleMode = upscaleMode;
      }
      if (hasValidFilters) {
        features.push("filters");
        const appliedFilters: string[] = [];
        if (brightness !== 0) appliedFilters.push("brightness");
        if (contrast !== 0) appliedFilters.push("contrast");
        if (saturation !== 0) appliedFilters.push("saturation");
        if (blur > 0) appliedFilters.push("blur");
        if (sharpening > 0) appliedFilters.push("sharpening");
        if (noiseReduction > 0) appliedFilters.push("noise_reduction");
        if (artisticFilter !== "none") appliedFilters.push(artisticFilter);
        details.filters = appliedFilters;
      }
      if (enableQuality) {
        features.push("quality");
        details.quality = qualityPreset;
        details.format = outputFormat;
      }
      
      details.features = features;
      return details as Record<string, string | number | boolean | string[]>;
    };

    try {
      // Log operation start
      const fileName = file.file_path.split("/").pop() || "unknown";
      operationId = await logOperation({
        mediaFileId: file.id,
        operationType: getOperationType(),
        sourceUrl: file.publicUrl,
        fileName,
        operationDetails: buildOperationDetails() as unknown as import("@/integrations/supabase/types").Json,
      });

      let publicId: string;
      let targetCloudName: string;

      if (!isCloudinaryFile) {
        toast({
          title: t("toast.uploadingCloudinary", "Uploading to Cloudinary"),
          description: t("toast.uploadingForProcess", "The file needs to be uploaded for processing..."),
        });

        const uploadResult = await uploadToCloudinary();
        publicId = uploadResult.publicId;
        targetCloudName = uploadResult.cloudName;
        setTempCloudinaryData(uploadResult);

        toast({
          title: t("toast.uploadComplete", "Upload complete"),
          description: t("toast.nowProcessing", "Now processing your image..."),
        });
      } else {
        publicId = file.cloudinary_public_id!;
        // Extract cloud name from the file URL if not provided
        if (cloudName) {
          targetCloudName = cloudName;
        } else if (file.file_path) {
          const urlMatch = file.file_path.match(/res\.cloudinary\.com\/([^\/]+)/);
          targetCloudName = urlMatch ? urlMatch[1] : "";
        } else {
          targetCloudName = "";
        }
      }

      if (!targetCloudName) {
        throw new Error("Could not determine Cloudinary cloud name");
      }

      let resultUrl: string | null = null;

      // Handle AtlasCloud 4K upscaling separately via edge function
      if (enableUpscale && upscalePlatform === "atlascloud") {
        toast({
          title: t("toast.atlasStarting", "Starting AtlasCloud 4K Upscale"),
          description: t("toast.atlasStartingDesc", "This may take up to 2 minutes for high-quality results..."),
        });

        // Get the source image URL
        const sourceImageUrl = isCloudinaryFile 
          ? file.file_path 
          : (tempCloudinaryData?.url || file.publicUrl);

        console.log("Calling AtlasCloud upscale with URL:", sourceImageUrl);

        const { data, error } = await supabase.functions.invoke("upscale-image", {
          body: {
            image_url: sourceImageUrl,
            platform: "atlascloud",
            scale: 4, // AtlasCloud does 4K upscaling
          },
        });

        if (error) {
          console.error("AtlasCloud upscale error:", error);
          throw new Error(error.message || "AtlasCloud upscale failed");
        }

        if (!data?.success) {
          throw new Error(data?.error || "AtlasCloud upscale failed");
        }

        console.log("AtlasCloud upscale result:", data);
        resultUrl = data.upscaled_url;
        setProcessedUrl(resultUrl);
        toast({
          title: t("toast.atlasComplete", "4K Upscale Complete!"),
          description: t("toast.atlasCompleteDesc", "Your image has been upscaled using AtlasCloud AI"),
        });
      } else {
        // Use Cloudinary URL transformations for other operations
        const url = buildCloudinaryUrl(publicId, targetCloudName, {
          enableBgRemoval,
          enableResize,
          enableUpscale: enableUpscale && upscalePlatform === "cloudinary",
          enableFilters,
          enableQuality,
          edgeMode,
          resizeMode,
          cropMode,
          customWidth,
          customHeight,
          brightness,
          contrast,
          saturation,
          blur,
          sharpening,
          noiseReduction,
          artisticFilter,
          upscaleMode,
          qualityPreset,
          outputFormat,
        });
        console.log("Processing URL:", url);

        if (enableBgRemoval || (enableUpscale && upscalePlatform === "cloudinary")) {
          let attempts = 0;
          const maxAttempts = 30;

          while (attempts < maxAttempts) {
            const response = await fetch(url, { method: "HEAD" });

            if (response.ok) {
              resultUrl = url;
              setProcessedUrl(url);
              toast({
                title: t("toast.processingComplete", "Processing complete"),
                description: t("toast.compareHint", "Use the slider to compare before and after"),
              });
              break;
            } else if (response.status === 423) {
              await new Promise((resolve) => setTimeout(resolve, 2000));
              attempts++;
            } else if (response.status === 404) {
              throw new Error("Image not found in Cloudinary. It may have been deleted or the public ID is incorrect.");
            } else {
              throw new Error(`Cloudinary returned error: ${response.status}`);
            }
          }

          if (attempts >= maxAttempts) {
            throw new Error("Processing timed out. Please try again.");
          }
        } else {
          const response = await fetch(url, { method: "HEAD" });
          if (response.ok) {
            resultUrl = url;
            setProcessedUrl(url);
            toast({
              title: t("toast.processingComplete", "Processing complete"),
              description: t("toast.processedDesc", "Your image has been processed"),
            });
          } else {
            throw new Error(`Processing failed: ${response.status}`);
          }
        }
      }

      // Log successful completion
      if (operationId) {
        const durationMs = Date.now() - startTime;
        await completeOperation(operationId, resultUrl || undefined, durationMs);
      }
    } catch (error) {
      console.error("Processing error:", error);
      
      // Log failure
      if (operationId) {
        const durationMs = Date.now() - startTime;
        await failOperation(
          operationId,
          error instanceof Error ? error.message : "Unknown error",
          durationMs
        );
      }

      // Use enhanced error parsing for user-friendly messages
      const parsedError = parseApiError(error, "Image processing");
      
      toast({
        title: parsedError.title,
        description: parsedError.description,
        variant: "destructive",
      });
      
      // If there's an action suggestion, show it as a second toast
      if (parsedError.action && !parsedError.actionUrl) {
        setTimeout(() => {
          toast({
            title: t("toast.suggestion", "Suggestion"),
            description: parsedError.action,
          });
        }, 500);
      }
    } finally {
      setProcessing(false);
    }
  };

  const handleDownload = async () => {
    if (!processedUrl) return;

    try {
      const response = await fetch(processedUrl);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      
      const features = [];
      if (enableBgRemoval) features.push("bg-removed");
      if (enableResize && resizeMode !== "original") features.push(`${resizeMode}`);
      if (enableUpscale) features.push("upscaled");
      if (enableFilters && filterModified) features.push("filtered");
      if (enableQuality) features.push(qualityPreset);
      
      a.download = `${features.join("-")}-${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      toast({
        title: t("toast.downloadStarted", "Download started"),
        description: t("toast.downloadStartedDesc", "Your processed image is downloading"),
      });
    } catch (error) {
      toast({
        title: t("toast.downloadFailed", "Download failed"),
        description: t("errors.couldNotDownloadImage", "Could not download the image"),
        variant: "destructive",
      });
    }
  };

  const handleSaveAsNew = async () => {
    if (!processedUrl || !file) return;

    setSaving(true);

    try {
      const response = await fetch(processedUrl);
      const blob = await response.blob();

      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      const base64Data = await base64Promise;

      const originalName = file.file_path.split("/").pop() || "image";
      const baseName = originalName.replace(/\.[^/.]+$/, "");
      const features = [];
      if (enableBgRemoval) features.push("bg-removed");
      if (enableResize && resizeMode !== "original") features.push(resizeMode);
      if (enableUpscale) features.push("upscaled");
      if (enableFilters && filterModified) features.push("filtered");
      if (enableQuality) features.push(qualityPreset);
      const newFileName = `${baseName}_${features.join("-")}`;

      const { data, error } = await supabase.functions.invoke(
        "cloudinary-upload",
        {
          body: {
            fileData: base64Data,
            fileName: newFileName,
            fileType: "image",
          },
        }
      );

      if (error) throw new Error((await readUploadRefusal(error)) || "Upload failed");
      if (!data?.success) throw new Error(data?.error || "Upload failed");

      if (file.folder_path && data.mediaFileId) {
        await supabase
          .from("media_files")
          .update({ folder_path: file.folder_path })
          .eq("id", data.mediaFileId);
      }

      toast({
        title: t("toast.savedToLibrary", "Saved to library"),
        description: file.folder_path && file.folder_path !== "/"
          ? t("toast.savedToLibraryFolder", "The processed image has been saved to {{folder}}", { folder: file.folder_path })
          : t("toast.savedToLibraryDesc", "The processed image has been saved"),
      });

      onProcessComplete?.();
      onClose();
    } catch (error) {
      console.error("Save error:", error);
      toast({
        title: t("toast.saveFailed", "Save failed"),
        description: error instanceof Error ? error.message : t("errors.couldNotSaveImage", "Could not save the image to your library"),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDragging || !containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percentage = Math.max(0, Math.min(100, (x / rect.width) * 100));
    setComparePosition(percentage);
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const x = e.touches[0].clientX - rect.left;
    const percentage = Math.max(0, Math.min(100, (x / rect.width) * 100));
    setComparePosition(percentage);
  };

  const getDialogTitle = () => {
    const features = [];
    if (enableBgRemoval) features.push(t("imageTools.feature.bgRemoval", "Background Removal"));
    if (enableResize) features.push(t("imageTools.feature.resize", "Resize"));
    if (enableUpscale) features.push(t("imageTools.feature.upscale", "Upscale"));
    if (enableFilters) features.push(t("imageTools.feature.filters", "Filters"));
    if (enableQuality) features.push(t("imageTools.feature.quality", "Quality"));
    
    if (features.length === 0) return t("imageTools.title", "Image Tools");
    if (features.length === 1) return features[0];
    if (features.length === 2) return t("imageTools.titleTwo", "{{first}} & {{second}}", { first: features[0], second: features[1] });
    return t("imageTools.titleMany", "{{count}} Tools Active", { count: features.length });
  };

  const handleResetFilters = () => {
    setBrightness(0);
    setContrast(0);
    setSaturation(0);
    setBlur(0);
    setSharpening(0);
    setNoiseReduction(0);
    setArtisticFilter("none");
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="w-5 h-5" />
            {getDialogTitle()}
          </DialogTitle>
          <DialogDescription>
            {t("imageTools.subtitle", "Apply transformations to your image. Enable the features you need.")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Non-Cloudinary file notice */}
          {!isCloudinaryFile && !tempCloudinaryData && (
            <Alert>
              <Upload className="h-4 w-4" />
              <AlertDescription>
                {t("imageTools.notice", "This file will be automatically uploaded to Cloudinary for processing.")}
              </AlertDescription>
            </Alert>
          )}

          {/* Feature Toggles */}
          <FeatureToggles
            enableBgRemoval={enableBgRemoval}
            enableResize={enableResize}
            enableUpscale={enableUpscale}
            enableFilters={enableFilters}
            enableQuality={enableQuality}
            onToggleBgRemoval={setEnableBgRemoval}
            onToggleResize={setEnableResize}
            onToggleUpscale={setEnableUpscale}
            onToggleFilters={setEnableFilters}
            onToggleQuality={setEnableQuality}
          />

          {/* Options Panels */}
          {enableBgRemoval && (
            <BgRemovalOptions
              edgeMode={edgeMode}
              onEdgeModeChange={setEdgeMode}
            />
          )}

          {enableResize && (
            <ResizeOptions
              resizeMode={resizeMode}
              cropMode={cropMode}
              customWidth={customWidth}
              customHeight={customHeight}
              onResizeModeChange={setResizeMode}
              onCropModeChange={setCropMode}
              onCustomWidthChange={setCustomWidth}
              onCustomHeightChange={setCustomHeight}
            />
          )}
          
          {enableUpscale && (
            <UpscaleOptions
              upscaleMode={upscaleMode}
              onUpscaleModeChange={setUpscaleMode}
              upscalePlatform={upscalePlatform}
              onUpscalePlatformChange={setUpscalePlatform}
              showAtlasCloud={flags.atlascloudUpscale}
            />
          )}
          
          {enableFilters && (
            <FiltersOptions
              brightness={brightness}
              contrast={contrast}
              saturation={saturation}
              blur={blur}
              sharpening={sharpening}
              noiseReduction={noiseReduction}
              artisticFilter={artisticFilter}
              hasModifications={filterModified}
              onBrightnessChange={setBrightness}
              onContrastChange={setContrast}
              onSaturationChange={setSaturation}
              onBlurChange={setBlur}
              onSharpeningChange={setSharpening}
              onNoiseReductionChange={setNoiseReduction}
              onArtisticFilterChange={setArtisticFilter}
              onReset={handleResetFilters}
            />
          )}
          
          {enableQuality && (
            <QualityOptions
              qualityPreset={qualityPreset}
              outputFormat={outputFormat}
              onQualityPresetChange={setQualityPreset}
              onOutputFormatChange={setOutputFormat}
            />
          )}

          {/* Image Comparison */}
          <div
            ref={containerRef}
            className="relative w-full aspect-video bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAiIGhlaWdodD0iMjAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGRlZnM+PHBhdHRlcm4gaWQ9ImdyaWQiIHdpZHRoPSIyMCIgaGVpZ2h0PSIyMCIgcGF0dGVyblVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+PHJlY3Qgd2lkdGg9IjEwIiBoZWlnaHQ9IjEwIiBmaWxsPSIjZTBlMGUwIi8+PHJlY3QgeD0iMTAiIHk9IjEwIiB3aWR0aD0iMTAiIGhlaWdodD0iMTAiIGZpbGw9IiNlMGUwZTAiLz48L3BhdHRlcm4+PC9kZWZzPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbGw9InVybCgjZ3JpZCkiLz48L3N2Zz4=')] rounded-lg overflow-hidden cursor-ew-resize select-none"
            onMouseMove={handleMouseMove}
            onMouseDown={() => setIsDragging(true)}
            onMouseUp={() => setIsDragging(false)}
            onMouseLeave={() => setIsDragging(false)}
            onTouchMove={handleTouchMove}
          >
            {file && (
              <>
                {/* Original Image */}
                <div
                  className="absolute inset-0"
                  style={{ clipPath: processedUrl ? `inset(0 ${100 - comparePosition}% 0 0)` : undefined }}
                >
                  <img
                    ref={imageRef}
                    src={livePreviewUrl || file.publicUrl}
                    alt={livePreviewUrl ? t("imageTools.preview", "Preview") : t("imageTools.original", "Original")}
                    className={cn(
                      "w-full h-full object-contain transition-opacity duration-300",
                      previewLoading && "opacity-50"
                    )}
                    draggable={false}
                    onLoad={handleImageLoad}
                  />
                  {processedUrl && (
                    <div className="absolute top-2 start-2 px-2 py-1 bg-background/80 backdrop-blur rounded text-xs font-medium">
                      {t("imageTools.original", "Original")}
                    </div>
                  )}
                  {!processedUrl && livePreviewUrl && (
                    <div className="absolute top-2 start-2 px-2 py-1 bg-primary/80 backdrop-blur rounded text-xs font-medium text-primary-foreground flex items-center gap-1">
                      <Palette className="w-3 h-3" />
                      {t("imageTools.livePreview", "Live Preview")}
                    </div>
                  )}
                  {previewLoading && (
                    <div className="absolute top-2 end-2 px-2 py-1 bg-background/80 backdrop-blur rounded text-xs font-medium flex items-center gap-1">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      {t("common:loading", "Loading...")}
                    </div>
                  )}
                </div>

                {/* Processed Image */}
                {processedUrl && (
                  <div
                    className="absolute inset-0"
                    style={{ clipPath: `inset(0 0 0 ${comparePosition}%)` }}
                  >
                    <img
                      src={processedUrl}
                      alt={t("imageTools.processed", "Processed")}
                      className="w-full h-full object-contain"
                      draggable={false}
                    />
                    <div className="absolute top-2 end-2 px-2 py-1 bg-background/80 backdrop-blur rounded text-xs font-medium">
                      {t("imageTools.processed", "Processed")}
                    </div>
                  </div>
                )}

                {/* Slider Handle */}
                {processedUrl && (
                  <div
                    className="absolute top-0 bottom-0 w-1 bg-primary cursor-ew-resize"
                    style={{ left: `${comparePosition}%`, transform: "translateX(-50%)" }}
                  >
                    <div className="absolute top-1/2 start-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 bg-primary rounded-full flex items-center justify-center shadow-lg">
                      <div className="flex gap-0.5">
                        <div className="w-0.5 h-3 bg-primary-foreground rounded" />
                        <div className="w-0.5 h-3 bg-primary-foreground rounded" />
                      </div>
                    </div>
                  </div>
                )}

                {/* Resize Preview Overlay */}
                {!processedUrl && cropOverlayInfo && targetDimensions && !processing && !uploading && enableResize && (
                  <>
                    {cropOverlayInfo.isCropMode && (
                      <div 
                        className="absolute inset-0 pointer-events-none z-20"
                        style={{
                          background: 'rgba(0,0,0,0.5)',
                          clipPath: `polygon(
                            0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%,
                            ${cropOverlayInfo.cropLeft}px ${cropOverlayInfo.cropTop}px,
                            ${cropOverlayInfo.cropLeft}px ${cropOverlayInfo.cropTop + cropOverlayInfo.cropHeight}px,
                            ${cropOverlayInfo.cropLeft + cropOverlayInfo.cropWidth}px ${cropOverlayInfo.cropTop + cropOverlayInfo.cropHeight}px,
                            ${cropOverlayInfo.cropLeft + cropOverlayInfo.cropWidth}px ${cropOverlayInfo.cropTop}px,
                            ${cropOverlayInfo.cropLeft}px ${cropOverlayInfo.cropTop}px
                          )`,
                        }}
                      />
                    )}
                    
                    <div
                      className={cn(
                        "absolute border-2 z-20 pointer-events-none transition-all duration-200",
                        cropOverlayInfo.isCropMode 
                          ? "border-destructive" 
                          : "border-primary border-dashed"
                      )}
                      style={{
                        left: cropOverlayInfo.cropLeft,
                        top: cropOverlayInfo.cropTop,
                        width: cropOverlayInfo.cropWidth,
                        height: cropOverlayInfo.cropHeight,
                      }}
                    >
                      <div className="absolute inset-0 grid grid-cols-3 grid-rows-3 pointer-events-none">
                        {[...Array(9)].map((_, i) => (
                          <div key={i} className={cn(
                            "border",
                            cropOverlayInfo.isCropMode ? "border-destructive/30" : "border-primary/30"
                          )} />
                        ))}
                      </div>
                      
                      <div className={cn(
                        "absolute -top-9 start-1/2 -translate-x-1/2 px-3 py-1.5 rounded-md text-sm font-medium whitespace-nowrap shadow-lg",
                        cropOverlayInfo.isCropMode 
                          ? "bg-destructive text-destructive-foreground" 
                          : "bg-primary text-primary-foreground"
                      )}>
                        {targetDimensions.width} × {targetDimensions.height} px
                      </div>
                      
                      <div className={cn(
                        "absolute -top-1 -start-1 w-4 h-4 border-t-2 border-l-2",
                        cropOverlayInfo.isCropMode ? "border-destructive" : "border-primary"
                      )} />
                      <div className={cn(
                        "absolute -top-1 -end-1 w-4 h-4 border-t-2 border-r-2",
                        cropOverlayInfo.isCropMode ? "border-destructive" : "border-primary"
                      )} />
                      <div className={cn(
                        "absolute -bottom-1 -start-1 w-4 h-4 border-b-2 border-l-2",
                        cropOverlayInfo.isCropMode ? "border-destructive" : "border-primary"
                      )} />
                      <div className={cn(
                        "absolute -bottom-1 -end-1 w-4 h-4 border-b-2 border-r-2",
                        cropOverlayInfo.isCropMode ? "border-destructive" : "border-primary"
                      )} />
                      
                      <div className={cn(
                        "absolute -bottom-9 start-1/2 -translate-x-1/2 px-3 py-1 rounded text-xs font-medium whitespace-nowrap",
                        "bg-background/95 backdrop-blur text-foreground shadow-md"
                      )}>
                        {cropOverlayInfo.isCropMode ? (
                          <span className="text-destructive">✂ {cropLabels[cropMode]}</span>
                        ) : (
                          <span>{cropLabels[cropMode]}</span>
                        )}
                        {" • "}
                        {resizeLabels[resizeMode] || t("imageTools.resize.custom", "Custom")}
                        {resizeMode === "custom" && ` (${(targetDimensions.width / targetDimensions.height).toFixed(2)}:1)`}
                      </div>
                    </div>
                  </>
                )}

                {/* Processing Overlay */}
                {(processing || uploading) && (
                  <div className="absolute inset-0 bg-background/80 backdrop-blur flex items-center justify-center">
                    <div className="text-center space-y-2">
                      <Loader2 className="w-8 h-8 animate-spin mx-auto text-primary" />
                      <p className="text-sm font-medium">
                        {uploading ? t("dialog.uploadingCloudinary", "Uploading to Cloudinary...") : t("imageTools.overlay", "Processing image...")}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t("imageTools.hint", "This may take a moment")}
                      </p>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Slider for fine control */}
          {processedUrl && (
            <div className="space-y-2">
              <Label>{t("imageTools.comparePosition", "Compare Position")}</Label>
              <Slider
                value={[comparePosition]}
                onValueChange={([v]) => setComparePosition(v)}
                min={0}
                max={100}
                step={1}
              />
            </div>
          )}
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          {!processedUrl ? (
            <>
              <Button variant="outline" onClick={onClose}>
                {t("common:cancel", "Cancel")}
              </Button>
              <Button
                onClick={handleProcess}
                disabled={processing || uploading || !file || (!enableBgRemoval && !enableResize && !enableUpscale && !enableFilters && !enableQuality)}
              >
                {processing || uploading ? (
                  <>
                    <Loader2 className="w-4 h-4 me-2 animate-spin" />
                    {uploading ? t("dialog.uploading", "Uploading...") : t("common:status.processing", "Processing...")}
                  </>
                ) : (
                  <>
                    <Wand2 className="w-4 h-4 me-2" />
                    {t("imageTools.processImage", "Process Image")}
                  </>
                )}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setProcessedUrl(null);
                  setComparePosition(50);
                }}
              >
                <RefreshCw className="w-4 h-4 me-2" />
                {t("actions.tryAgain", "Try Again")}
              </Button>
              <Button variant="secondary" onClick={handleDownload}>
                <Download className="w-4 h-4 me-2" />
                {t("common:download", "Download")}
              </Button>
              <Button onClick={handleSaveAsNew} disabled={saving}>
                {saving ? (
                  <>
                    <Loader2 className="w-4 h-4 me-2 animate-spin" />
                    {t("common:saving", "Saving...")}
                  </>
                ) : (
                  t("actions.saveToLibrary", "Save to Library")
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
