import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, X, ZoomIn, ZoomOut, RotateCcw } from "lucide-react";
import { UploadedFile } from "@/hooks/usePostForm";
import { VideoPreview } from "./VideoPreview";
import { Platform } from "@/lib/types";
import { cn } from "@/lib/utils";

interface MediaLightboxProps {
  files: UploadedFile[];
  currentIndex: number;
  isOpen: boolean;
  onClose: () => void;
  onNavigate: (index: number) => void;
  selectedPlatforms: Platform[];
}

const ZOOM_LEVELS = [1, 1.25, 1.5, 2, 2.5, 3];

export function MediaLightbox({
  files,
  currentIndex,
  isOpen,
  onClose,
  onNavigate,
  selectedPlatforms,
}: MediaLightboxProps) {
  const { t } = useTranslation("postmedia");
  const [zoomIndex, setZoomIndex] = useState(0);
  const [isHovering, setIsHovering] = useState(false);
  
  const currentFile = files[currentIndex];
  const currentZoom = ZOOM_LEVELS[zoomIndex];
  
  if (!currentFile) return null;

  const handlePrevious = () => {
    setZoomIndex(0); // Reset zoom when navigating
    onNavigate(currentIndex > 0 ? currentIndex - 1 : files.length - 1);
  };

  const handleNext = () => {
    setZoomIndex(0); // Reset zoom when navigating
    onNavigate(currentIndex < files.length - 1 ? currentIndex + 1 : 0);
  };

  const handleZoomIn = () => {
    if (zoomIndex < ZOOM_LEVELS.length - 1) {
      setZoomIndex(zoomIndex + 1);
    }
  };

  const handleZoomOut = () => {
    if (zoomIndex > 0) {
      setZoomIndex(zoomIndex - 1);
    }
  };

  const handleResetZoom = () => {
    setZoomIndex(0);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") handlePrevious();
    if (e.key === "ArrowRight") handleNext();
    if (e.key === "Escape") onClose();
    if (e.key === "+" || e.key === "=") handleZoomIn();
    if (e.key === "-") handleZoomOut();
    if (e.key === "0") handleResetZoom();
  };

  const handleClose = () => {
    setZoomIndex(0);
    onClose();
  };

  const isImage = currentFile.fileType !== "video";

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent 
        className="max-w-[95vw] max-h-[95vh] w-auto p-0 bg-black/95 border-none"
        onKeyDown={handleKeyDown}
        hideCloseButton
      >
        <div className="relative flex items-center justify-center min-h-[50vh]">
          {/* Close button */}
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-2 end-2 z-50 text-white hover:bg-white/20"
            onClick={handleClose}
          >
            <X className="w-5 h-5" />
          </Button>

          {/* Zoom controls - only for images */}
          {isImage && (
            <div className="absolute top-2 start-1/2 -translate-x-1/2 z-50 flex items-center gap-1 bg-black/60 rounded-full px-2 py-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-white hover:bg-white/20 disabled:opacity-30"
                onClick={handleZoomOut}
                disabled={zoomIndex === 0}
              >
                <ZoomOut className="w-4 h-4" />
              </Button>
              <span className="text-white text-xs min-w-[50px] text-center">
                {Math.round(currentZoom * 100)}%
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-white hover:bg-white/20 disabled:opacity-30"
                onClick={handleZoomIn}
                disabled={zoomIndex === ZOOM_LEVELS.length - 1}
              >
                <ZoomIn className="w-4 h-4" />
              </Button>
              {zoomIndex > 0 && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-white hover:bg-white/20"
                  onClick={handleResetZoom}
                >
                  <RotateCcw className="w-4 h-4" />
                </Button>
              )}
            </div>
          )}

          {/* Navigation - Previous */}
          {files.length > 1 && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute start-2 z-50 text-white hover:bg-white/20"
              onClick={handlePrevious}
            >
              <ChevronLeft className="w-8 h-8" />
            </Button>
          )}

          {/* Media content */}
          <div 
            className={cn(
              "flex items-center justify-center p-4 overflow-auto",
              currentZoom > 1 && "cursor-grab active:cursor-grabbing"
            )}
            style={{ maxHeight: "85vh", maxWidth: "90vw" }}
          >
            {currentFile.fileType === "video" ? (
              <VideoPreview
                src={currentFile.previewUrl}
                selectedPlatforms={selectedPlatforms}
                className="max-h-[85vh] max-w-[90vw] object-contain"
              />
            ) : (
              <div 
                className="relative overflow-hidden"
                onMouseEnter={() => setIsHovering(true)}
                onMouseLeave={() => setIsHovering(false)}
              >
                <img
                  src={currentFile.previewUrl}
                  alt={t("lightbox.mediaAlt", "Media {{index}}", { index: currentIndex + 1 })}
                  className={cn(
                    "max-h-[85vh] max-w-[90vw] object-contain transition-transform duration-300 ease-out",
                    isHovering && zoomIndex === 0 && "scale-[1.02]"
                  )}
                  style={{ 
                    transform: zoomIndex > 0 ? `scale(${currentZoom})` : undefined,
                    transformOrigin: "center center"
                  }}
                />
              </div>
            )}
          </div>

          {/* Navigation - Next */}
          {files.length > 1 && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute end-2 z-50 text-white hover:bg-white/20"
              onClick={handleNext}
            >
              <ChevronRight className="w-8 h-8" />
            </Button>
          )}

          {/* Counter and keyboard hints */}
          <div className="absolute bottom-4 start-1/2 -translate-x-1/2 flex flex-col items-center gap-2">
            {files.length > 1 && (
              <div className="bg-black/60 text-white text-sm px-3 py-1 rounded-full">
                {currentIndex + 1} / {files.length}
              </div>
            )}
            <div className="bg-black/40 text-white/70 text-xs px-3 py-1 rounded-full">
              {t("lightbox.keyboardHints", "← → Navigate • +/- Zoom • Esc Close")}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
