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
import { readUploadRefusal } from "@/components/media/uploadErrors";
import { useToast } from "@/hooks/use-toast";
import { useCdnConfig } from "@/hooks/useCdnConfig";
import { isCloudinaryTransformsAvailable, isProviderUnavailable, runBackgroundRemoval } from "@/components/media/image-tools/aiImageTools";
import {
  Loader2,
  Download,
  RefreshCw,
  Scissors,
  SlidersHorizontal,
  Maximize2,
  Upload,
  AlertCircle,
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

interface BackgroundRemovalDialogProps {
  open: boolean;
  onClose: () => void;
  file: {
    id: string;
    publicUrl: string;
    cloudinary_public_id?: string;
    storage_bucket: string;
    folder_path?: string;
    file_path: string;
  } | null;
  cloudName: string;
  onProcessComplete?: () => void;
}

type EdgeMode = "none" | "fine";
type ResizeMode = "original" | "square" | "portrait" | "landscape" | "custom";

const RESIZE_PRESETS = {
  original: { label: "Original", width: null, height: null },
  square: { label: "Square (1:1)", width: 1024, height: 1024 },
  portrait: { label: "Portrait (4:5)", width: 1080, height: 1350 },
  landscape: { label: "Landscape (16:9)", width: 1920, height: 1080 },
  custom: { label: "Custom", width: null, height: null },
};

export function BackgroundRemovalDialog({
  open,
  onClose,
  file,
  cloudName,
  onProcessComplete,
}: BackgroundRemovalDialogProps) {
  const { data: cdnConfig } = useCdnConfig();
  // Without Cloudinary the server-side AI remover is the only way; edge quality and resize are Cloudinary transforms.
  const cloudinaryAvailable = isCloudinaryTransformsAvailable(cdnConfig);
  const [processing, setProcessing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [processedUrl, setProcessedUrl] = useState<string | null>(null);
  const [comparePosition, setComparePosition] = useState(50);
  const [edgeMode, setEdgeMode] = useState<EdgeMode>("none");
  const [resizeMode, setResizeMode] = useState<ResizeMode>("original");
  const [customWidth, setCustomWidth] = useState(1024);
  const [customHeight, setCustomHeight] = useState(1024);
  const [saving, setSaving] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [tempCloudinaryData, setTempCloudinaryData] = useState<{
    publicId: string;
    cloudName: string;
    url: string;
  } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation("assets");
  const { toast } = useToast();
  const resizeLabels: Record<ResizeMode, string> = {
    original: t("imageTools.resize.original", "Original"),
    square: t("imageTools.resize.square", "Square (1:1)"),
    portrait: t("imageTools.resize.portrait", "Portrait (4:5)"),
    landscape: t("imageTools.resize.landscape", "Landscape (16:9)"),
    custom: t("imageTools.resize.custom", "Custom"),
  };

  const isCloudinaryFile = file?.storage_bucket === "cloudinary" && !!file?.cloudinary_public_id;

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (open) {
      setProcessedUrl(null);
      setComparePosition(50);
      setEdgeMode("none");
      setResizeMode("original");
      setTempCloudinaryData(null);
      setUploading(false);
    }
  }, [open]);

  const buildCloudinaryUrl = (publicId: string, targetCloudName: string) => {
    let transformations = [];

    // Add background removal
    if (edgeMode === "fine") {
      transformations.push("e_background_removal:fineedges_y");
    } else {
      transformations.push("e_background_removal");
    }

    // Add resize if needed
    if (resizeMode !== "original") {
      const preset = RESIZE_PRESETS[resizeMode];
      let width = preset.width;
      let height = preset.height;

      if (resizeMode === "custom") {
        width = customWidth;
        height = customHeight;
      }

      if (width && height) {
        transformations.push(`w_${width},h_${height},c_fill`);
      }
    }

    const transformString = transformations.join("/");
    return `https://res.cloudinary.com/${targetCloudName}/image/upload/${transformString}/${publicId}`;
  };

  // Upload non-Cloudinary file to Cloudinary first
  const uploadToCloudinary = async (): Promise<{ publicId: string; cloudName: string; url: string }> => {
    if (!file) throw new Error("No file selected");

    setUploading(true);

    try {
      // Fetch the image
      const response = await fetch(file.publicUrl);
      const blob = await response.blob();

      // Convert to base64
      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      const base64Data = await base64Promise;

      // Get filename from path
      const fileName = file.file_path.split("/").pop() || `image-${Date.now()}`;

      // Upload to Cloudinary
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

      // Extract cloud name from returned URL
      const urlMatch = data.url.match(/res\.cloudinary\.com\/([^\/]+)/);
      const extractedCloudName = urlMatch ? urlMatch[1] : "";

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

    setProcessing(true);

    try {
      if (!cloudinaryAvailable) {
        setProcessedUrl(await runBackgroundRemoval(file.publicUrl));
        toast({
          title: t("toast.backgroundRemoved", "Background removed"),
          description: t("toast.backgroundRemovedDesc", "Use the slider to compare before and after"),
        });
        return;
      }

      let publicId: string;
      let targetCloudName: string;

      // If not a Cloudinary file, upload it first
      if (!isCloudinaryFile) {
        toast({
          title: t("toast.uploadingCloudinary", "Uploading to Cloudinary"),
          description: t("toast.uploadingCloudinaryDesc", "The file needs to be uploaded to Cloudinary for background removal..."),
        });

        const uploadResult = await uploadToCloudinary();
        publicId = uploadResult.publicId;
        targetCloudName = uploadResult.cloudName;
        setTempCloudinaryData(uploadResult);

        toast({
          title: t("toast.uploadComplete", "Upload complete"),
          description: t("toast.nowProcessingBg", "Now processing background removal..."),
        });
      } else {
        publicId = file.cloudinary_public_id!;
        targetCloudName = cloudName;
      }

      if (!targetCloudName) {
        throw new Error("Could not determine Cloudinary cloud name");
      }

      const url = buildCloudinaryUrl(publicId, targetCloudName);
      console.log("Background removal URL:", url);

      // Cloudinary may return 423 while processing, we poll until ready
      let attempts = 0;
      const maxAttempts = 30;

      while (attempts < maxAttempts) {
        const response = await fetch(url, { method: "HEAD" });

        if (response.ok) {
          setProcessedUrl(url);
          toast({
            title: t("toast.backgroundRemoved", "Background removed"),
            description: t("toast.backgroundRemovedDesc", "Use the slider to compare before and after"),
          });
          break;
        } else if (response.status === 423) {
          // Still processing, wait and retry
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
    } catch (error) {
      console.error("Background removal error:", error);
      if (isProviderUnavailable(error)) {
        toast({
          title: t("toast.aiToolUnavailableTitle", "AI tool unavailable"),
          description: t("toast.aiToolUnavailable", "This AI tool is temporarily unavailable. Please try again later."),
          variant: "destructive",
        });
        return;
      }
      toast({
        title: t("toast.processingFailed", "Processing failed"),
        description:
          error instanceof Error ? error.message : t("errors.removeBgFailed", "Failed to remove background"),
        variant: "destructive",
      });
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
      a.download = `bg-removed-${Date.now()}.png`;
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
      // Download the processed image
      const response = await fetch(processedUrl);
      const blob = await response.blob();

      // Convert to base64
      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      const base64Data = await base64Promise;

      // Generate filename based on original
      const originalName = file.file_path.split("/").pop() || "image";
      const baseName = originalName.replace(/\.[^/.]+$/, "");
      const newFileName = `${baseName}_bg-removed`;

      // Upload to Cloudinary via edge function
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

      // Update the folder_path to match the original file's folder
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

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Scissors className="w-5 h-5" />
            {t("bgRemoval.title", "Remove Background")}
          </DialogTitle>
          <DialogDescription>
            {t("bgRemoval.subtitle", "Remove the background from your image using AI. Use the slider to compare before and after.")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Non-Cloudinary file notice */}
          {cloudinaryAvailable && !isCloudinaryFile && !tempCloudinaryData && (
            <Alert>
              <Upload className="h-4 w-4" />
              <AlertDescription>
                {t("bgRemoval.notice", "This file will be automatically uploaded to Cloudinary for background removal processing.")}
              </AlertDescription>
            </Alert>
          )}

          {!cloudinaryAvailable && (
            <Alert>
              <Upload className="h-4 w-4" />
              <AlertDescription>
                {t("bgRemoval.aiOnlyNotice", "The background is removed with AI. Edge quality and resize are not available right now.")}
              </AlertDescription>
            </Alert>
          )}

          {/* Settings: edge quality and resize are Cloudinary transforms */}
          <div className={cn("grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 bg-muted/50 rounded-lg", !cloudinaryAvailable && "hidden")}>
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <SlidersHorizontal className="w-4 h-4" />
                {t("bgRemoval.edgeQuality", "Edge Quality")}
              </Label>
              <Select
                value={edgeMode}
                onValueChange={(v) => setEdgeMode(v as EdgeMode)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("bgRemoval.standard", "Standard")}</SelectItem>
                  <SelectItem value="fine">{t("bgRemoval.fineEdges", "Fine Edges")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Maximize2 className="w-4 h-4" />
                {t("bgRemoval.resizeOutput", "Resize Output")}
              </Label>
              <Select
                value={resizeMode}
                onValueChange={(v) => setResizeMode(v as ResizeMode)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(RESIZE_PRESETS).map(([key]) => (
                    <SelectItem key={key} value={key}>
                      {resizeLabels[key as ResizeMode]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {resizeMode === "custom" && (
              <div className="col-span-2 grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{t("bgRemoval.widthPx", "Width (px)")}</Label>
                  <input
                    type="number"
                    value={customWidth}
                    onChange={(e) => setCustomWidth(Number(e.target.value))}
                    className="w-full px-3 py-2 border rounded-md bg-background"
                    min={100}
                    max={4096}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t("bgRemoval.heightPx", "Height (px)")}</Label>
                  <input
                    type="number"
                    value={customHeight}
                    onChange={(e) => setCustomHeight(Number(e.target.value))}
                    className="w-full px-3 py-2 border rounded-md bg-background"
                    min={100}
                    max={4096}
                  />
                </div>
              </div>
            )}
          </div>

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
                {/* Original Image (full width, clipped) */}
                <div
                  className="absolute inset-0"
                  style={{ clipPath: `inset(0 ${100 - comparePosition}% 0 0)` }}
                >
                  <img
                    src={file.publicUrl}
                    alt={t("bgRemoval.original", "Original")}
                    className="w-full h-full object-contain"
                    draggable={false}
                  />
                  <div className="absolute top-2 start-2 px-2 py-1 bg-background rounded text-xs font-medium">
                    {t("bgRemoval.original", "Original")}
                  </div>
                </div>

                {/* Processed Image (full width, clipped from left) */}
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
                    <div className="absolute top-2 end-2 px-2 py-1 bg-background rounded text-xs font-medium">
                      {t("bgRemoval.removed", "Removed")}
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

                {/* Processing/Uploading Overlay */}
                {(processing || uploading) && (
                  <div className="absolute inset-0 bg-background flex items-center justify-center">
                    <div className="text-center space-y-2">
                      <Loader2 className="w-8 h-8 animate-spin mx-auto text-primary" />
                      <p className="text-sm font-medium">
                        {uploading ? t("bgRemoval.uploadingOverlay", "Uploading to Cloudinary...") : t("bgRemoval.overlay", "Removing background...")}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t("bgRemoval.overlayHint", "This may take a moment")}
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
              <Label>{t("bgRemoval.comparePosition", "Compare Position")}</Label>
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
                disabled={processing || uploading || !file}
              >
                {processing || uploading ? (
                  <>
                    <Loader2 className="w-4 h-4 me-2 animate-spin" />
                    {uploading ? t("dialog.uploading", "Uploading...") : t("common:status.processing", "Processing...")}
                  </>
                ) : (
                  <>
                    <Scissors className="w-4 h-4 me-2" />
                    {t("bgRemoval.title", "Remove Background")}
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
