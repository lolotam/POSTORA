import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Upload, Link2, MessageSquare, FolderOpen, Image as ImageIcon, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { ImageGenerator } from "./ImageGenerator";
import { MediaLibraryPicker } from "./MediaLibraryPicker";
import { StockMediaPicker, SelectedMedia } from "./StockMediaPicker";
import { UploadedFile } from "@/hooks/usePostForm";
import { MEDIA_REQUIRED_PLATFORMS } from "@/lib/platformConstants";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { GradientRingCard, Icon3D, Reveal, GradientDivider } from "@/components/fx";
import type { GradientKey } from "@/components/fx";
import type { LucideIcon } from "lucide-react";

type UploadMethod = "local" | "url" | "text";

interface UploadMethodSelectorProps {
  uploadMethod: UploadMethod;
  setUploadMethod: (method: UploadMethod) => void;
  setSelectedAccountIds: React.Dispatch<React.SetStateAction<string[]>>;
  connectedAccounts: Array<{ id: string; platform: string }>;
  user: { id: string } | null;
  setFiles: React.Dispatch<React.SetStateAction<UploadedFile[]>>;
  uploadFileToStorage: (file: UploadedFile) => Promise<void>;
  currentFileCount?: number;
  isDragActive?: boolean;
}

export function UploadMethodSelector({
  uploadMethod,
  setUploadMethod,
  setSelectedAccountIds,
  connectedAccounts,
  user,
  setFiles,
  uploadFileToStorage,
  currentFileCount = 0,
  isDragActive = false,
}: UploadMethodSelectorProps) {
  const { t } = useTranslation("postmedia");
  const { flags } = useFeatureFlags();
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [isStockPickerOpen, setIsStockPickerOpen] = useState(false);

  // Keyboard shortcuts for switching upload methods
  const handleKeyboardShortcut = useCallback((e: KeyboardEvent) => {
    // Only trigger with Ctrl/Cmd key
    if (!e.ctrlKey && !e.metaKey) return;
    
    // Don't trigger if user is typing in an input
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    switch (e.key) {
      case "1":
        e.preventDefault();
        setUploadMethod("local");
        break;
      case "2":
        e.preventDefault();
        setUploadMethod("url");
        break;
      case "3":
        e.preventDefault();
        setUploadMethod("text");
        setSelectedAccountIds(prev =>
          prev.filter(id => {
            const acc = connectedAccounts.find(a => a.id === id);
            return acc && !MEDIA_REQUIRED_PLATFORMS.includes(acc.platform as any);
          })
        );
        break;
      case "4":
        e.preventDefault();
        setIsLibraryOpen(true);
        break;
      case "5":
        if (flags.stockUpload) {
          e.preventDefault();
          setIsStockPickerOpen(true);
        }
        break;
    }
  }, [setUploadMethod, setSelectedAccountIds, connectedAccounts, flags.stockUpload]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyboardShortcut);
    return () => window.removeEventListener("keydown", handleKeyboardShortcut);
  }, [handleKeyboardShortcut]);

  const handleMediaLibrarySelect = (selectedFiles: UploadedFile[]) => {
    setFiles((prev) => [...prev, ...selectedFiles].slice(0, 10));
    // Switch to local method to show the files
    if (uploadMethod !== "local") {
      setUploadMethod("local");
    }
  };

  const handleStockMediaSelect = async (media: SelectedMedia) => {
    if (!user) return;

    try {
      const fileType: "image" | "video" | "gif" = media.type;

      // Important: for videos we MUST use the actual mp4 URL as previewUrl,
      // otherwise the VideoPreview component receives an image/gif thumbnail and shows a black screen.
      const previewUrl =
        fileType === "video"
          ? media.url
          : fileType === "gif"
            ? media.url
            : (media.thumbnailUrl || media.url);

      // Create a temporary file entry with uploading state
      const tempId = `stock-${media.source}-${Date.now()}`;
      const newFile: UploadedFile = {
        id: tempId,
        file: null as unknown as File, // External URL-based media
        previewUrl,
        fileType,
        uploadProgress: 0,
        uploaded: false,
        cloudinaryUrl: media.url, // Temporary - will be replaced after upload
        mediaSource: media.source,
        // Pass Unsplash attribution if available
        photographerName: media.photographerName,
        photographerUrl: media.photographerUrl,
        unsplashUrl: media.unsplashUrl,
      };

      setFiles((prev) => [...prev, newFile].slice(0, 10));

      // Switch to local method to show the files
      if (uploadMethod !== "local") {
        setUploadMethod("local");
      }

      // Upload stock media to Cloudinary via edge function
      // This creates a database record and returns the mediaFileId
      await uploadStockMediaToStorage(newFile, media.url, media.source);
    } catch (error) {
      console.error("Failed to add stock media:", error);
    }
  };

  // Upload stock media from external URL to Cloudinary
  const uploadStockMediaToStorage = async (
    uploadFile: UploadedFile,
    externalUrl: string,
    source: string
  ) => {
    try {
      // Update progress
      setFiles((prev) =>
        prev.map((f) =>
          f.id === uploadFile.id ? { ...f, uploadProgress: 30 } : f
        )
      );

      // Generate filename from source and type
      const extension = uploadFile.fileType === "video" ? "mp4" : 
                       uploadFile.fileType === "gif" ? "gif" : "jpg";
      const fileName = `stock-${source}-${Date.now()}.${extension}`;

      const { supabase } = await import("@/integrations/supabase/client");
      const { data, error } = await supabase.functions.invoke("cloudinary-upload", {
        body: {
          externalUrl,
          fileName,
          fileType: uploadFile.fileType,
        },
      });

      if (error) {
        let errorMessage = "Upload failed";
        try {
          if (error.context) {
            const errorBody = await error.context.json();
            errorMessage = errorBody?.error || errorBody?.message || errorMessage;
          } else if (error.message) {
            errorMessage = error.message;
          }
        } catch {
          errorMessage = error.message || errorMessage;
        }
        throw new Error(errorMessage);
      }

      if (!data?.success) {
        throw new Error(data?.error || "Upload failed");
      }

      // Update file with Cloudinary data and storagePath (database ID)
      setFiles((prev) =>
        prev.map((f) =>
          f.id === uploadFile.id
            ? {
                ...f,
                uploadProgress: 100,
                uploaded: true,
                storagePath: data.mediaFileId, // Database UUID for media_file_ids
                cloudinaryUrl: data.url,
                cloudinaryPublicId: data.publicId,
              }
            : f
        )
      );

      console.log(`[StockMedia] Uploaded ${source} media, mediaFileId: ${data.mediaFileId}`);
    } catch (error) {
      console.error("Stock media upload error:", error);
      // Remove the failed file
      setFiles((prev) => prev.filter((f) => f.id !== uploadFile.id));
    }
  };

  type ModeTile = {
    value: UploadMethod;
    icon: LucideIcon;
    label: string;
    description: string;
    shortcut: string;
    variant: GradientKey;
  };

  const modeTiles: ModeTile[] = [
    { value: "local", icon: Upload,          label: t("uploadMethod.uploadLabel", "Upload"), description: t("uploadMethod.uploadDesc", "Upload images or videos from your device"), shortcut: "1", variant: "violet" },
    { value: "url",   icon: Link2,           label: t("uploadMethod.urlLabel", "URL"),    description: t("uploadMethod.urlDesc", "Import media from a direct URL link"),       shortcut: "2", variant: "sky"    },
    { value: "text",  icon: MessageSquare,   label: t("uploadMethod.textLabel", "Text"),   description: t("uploadMethod.textDesc", "Create a text-only post without media"),     shortcut: "3", variant: "amber"  },
  ];

  type ActionTile = {
    key: string;
    icon: LucideIcon;
    label: string;
    description: string;
    shortcut?: string;
    variant: GradientKey;
    onClick: () => void;
    show: boolean;
  };

  const actionTiles: ActionTile[] = [
    {
      key: "library",
      icon: FolderOpen,
      label: t("uploadMethod.libraryLabel", "Library"),
      description: t("uploadMethod.libraryDesc", "Select from your previously uploaded media"),
      shortcut: "4",
      variant: "emerald",
      onClick: () => setIsLibraryOpen(true),
      show: true,
    },
    {
      key: "stock",
      icon: ImageIcon,
      label: t("uploadMethod.stockLabel", "Stock"),
      description: t("uploadMethod.stockDesc", "Browse free stock photos and videos"),
      shortcut: "5",
      variant: "rose",
      onClick: () => setIsStockPickerOpen(true),
      show: !!flags.stockUpload,
    },
  ];

  const visibleActions = actionTiles.filter((t) => t.show);

  const handleModeChange = (v: string) => {
    setUploadMethod(v as UploadMethod);
    if (v === "text") {
      setSelectedAccountIds((prev) =>
        prev.filter((id) => {
          const acc = connectedAccounts.find((a) => a.id === id);
          return acc && !MEDIA_REQUIRED_PLATFORMS.includes(acc.platform as any);
        })
      );
    }
  };

  return (
    <div className="space-y-5 relative">
      {/* Drag and drop overlay indicator */}
      {isDragActive && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-primary/10 border-2 border-dashed border-primary rounded-2xl pointer-events-none">
          <div className="flex flex-col items-center gap-2 text-primary">
            <Upload className="w-10 h-10 animate-bounce" />
            <p className="text-sm font-medium">{t("uploadMethod.dropFiles", "Drop files here to upload")}</p>
          </div>
        </div>
      )}

      <TooltipProvider delayDuration={300}>
        {/* Upload Method group */}
        <div className="space-y-3">
          <div className="flex items-baseline justify-between gap-2">
            <h4 className="text-sm font-semibold tracking-tight">{t("uploadMethod.title", "Upload Method")}</h4>
            <span className="text-[11px] text-muted-foreground">{t("uploadMethod.subtitle", "Choose how to add media")}</span>
          </div>

          <RadioGroup
            value={uploadMethod}
            onValueChange={handleModeChange}
            className="grid grid-cols-3 gap-3"
          >
            {modeTiles.map((tItem, i) => {
              const isSelected = uploadMethod === tItem.value;
              return (
                <Reveal key={tItem.value} delay={i * 60}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <label
                        className={cn(
                          "block cursor-pointer select-none h-full",
                          "focus-within:outline-none"
                        )}
                      >
                        <RadioGroupItem value={tItem.value} className="sr-only" />
                        <GradientRingCard
                          variant={tItem.variant}
                          active={isSelected}
                          padded={false}
                          hoverLift={false}
                          ringIntensity={isSelected ? "strong" : "subtle"}
                          innerClassName={cn(
                            "px-3 py-4 sm:py-5 flex flex-col items-center justify-center gap-2 text-center",
                            "rounded-3xl",
                            isSelected && "ring-2 ring-primary/40"
                          )}
                        >
                          <Icon3D icon={tItem.icon} variant={tItem.variant} size="sm" />
                          <span className="text-sm font-semibold leading-tight">{tItem.label}</span>
                          <span className="text-[10px] text-muted-foreground">⌘{tItem.shortcut}</span>
                        </GradientRingCard>
                      </label>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-[220px]">
                      <p>{tItem.description}</p>
                      <p className="text-xs text-muted-foreground mt-1">⌘/Ctrl + {tItem.shortcut}</p>
                    </TooltipContent>
                  </Tooltip>
                </Reveal>
              );
            })}
          </RadioGroup>
        </div>

        <GradientDivider />

        {/* Action / picker tiles */}
        <div className="space-y-3">
          <div className="flex items-baseline justify-between gap-2">
            <h4 className="text-sm font-semibold tracking-tight">{t("uploadMethod.pickFromTitle", "Or pick from")}</h4>
            <span className="text-[11px] text-muted-foreground">{t("uploadMethod.pickFromSubtitle", "Library, stock & AI")}</span>
          </div>

          <div className={cn(
            "grid gap-3",
            (visibleActions.length + (flags.aiImage ? 1 : 0)) >= 3
              ? "grid-cols-3"
              : "grid-cols-2"
          )}>
            {visibleActions.map((tItem, i) => (
              <Reveal key={tItem.key} delay={i * 60}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={tItem.onClick}
                      className="block w-full text-left h-full"
                    >
                      <GradientRingCard
                        variant={tItem.variant}
                        padded={false}
                        hoverLift={false}
                        ringIntensity="normal"
                        innerClassName="px-3 py-4 sm:py-5 flex flex-col items-center justify-center gap-2 text-center rounded-3xl"
                      >
                        <Icon3D icon={tItem.icon} variant={tItem.variant} size="sm" />
                        <span className="text-sm font-semibold leading-tight">{tItem.label}</span>
                        {tItem.shortcut && (
                          <span className="text-[10px] text-muted-foreground">⌘{tItem.shortcut}</span>
                        )}
                      </GradientRingCard>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-[220px]">
                    <p>{tItem.description}</p>
                    {tItem.shortcut && (
                      <p className="text-xs text-muted-foreground mt-1">⌘/Ctrl + {tItem.shortcut}</p>
                    )}
                  </TooltipContent>
                </Tooltip>
              </Reveal>
            ))}

            {flags.aiImage && (
              <Reveal delay={visibleActions.length * 60}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="block w-full h-full">
                      <GradientRingCard
                        variant="indigo"
                        padded={false}
                        hoverLift={false}
                        ringIntensity="normal"
                        innerClassName="px-3 py-4 sm:py-5 flex flex-col items-center justify-center gap-2 text-center rounded-3xl"
                      >
                        <Icon3D icon={Sparkles} variant="indigo" size="sm" />
                        <ImageGenerator
                          onImageGenerated={async (imageUrl, imageBlob) => {
                            if (!user) return;
                            const file = new File([imageBlob], `ai-generated-${Date.now()}.png`, { type: "image/png" });
                            const newFile: UploadedFile = {
                              id: `${Date.now()}`,
                              file,
                              previewUrl: imageUrl,
                              fileType: "image",
                              uploadProgress: 0,
                              uploaded: false,
                            };
                            setFiles((prev) => [...prev, newFile].slice(0, 10));
                            await uploadFileToStorage(newFile);
                          }}
                          buttonClassName="h-7 px-2 text-xs"
                        />
                      </GradientRingCard>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-[220px]">
                    <p>{t("uploadMethod.aiDesc", "Generate unique images using AI")}</p>
                  </TooltipContent>
                </Tooltip>
              </Reveal>
            )}
          </div>
        </div>
      </TooltipProvider>

      {/* Media Library Picker Modal */}
      <MediaLibraryPicker
        open={isLibraryOpen}
        onOpenChange={setIsLibraryOpen}
        onSelect={handleMediaLibrarySelect}
        maxFiles={10}
        currentFileCount={currentFileCount}
      />

      {/* Stock Media Picker Dialog */}
      <StockMediaPicker
        open={isStockPickerOpen}
        onOpenChange={setIsStockPickerOpen}
        onSelect={handleStockMediaSelect}
      />
    </div>
  );
}
