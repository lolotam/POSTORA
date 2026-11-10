/**
 * Hook for managing media editor state (cropper, compressor)
 * Extracts media editing logic from CreatePost.tsx for better maintainability
 */

import { useState, useCallback, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import { UploadedFile } from "@/hooks/usePostForm";
import { AspectRatioSuggestion } from "@/components/post/ImageAspectRatioValidator";
import { useProcessingJobsContext, ProcessingJob } from "@/contexts/ProcessingJobsContext";
import { createJpegFile } from "@/lib/imageUtils";

interface UseMediaEditorsProps {
  files: UploadedFile[];
  setFiles: React.Dispatch<React.SetStateAction<UploadedFile[]>>;
  uploadFileToStorage: (file: UploadedFile) => Promise<void>;
  user: { id: string } | null | undefined;
  flags: { imageCrop: boolean; videoCompress: boolean };
  isFlagsLoading: boolean;
}

interface CropperState {
  open: boolean;
  mediaSrc: string;
  mediaType: "image" | "video" | "gif";
  fileId: string | null;
  targetRatio: string | undefined;
  mediaFileId: string | null; // Database ID for server-side processing
}

interface CompressorState {
  open: boolean;
  file: File | null;
  fileId: string | null;
  src: string;
  mediaFileId: string | null; // Database ID for server-side processing
}

interface UseMediaEditorsReturn {
  // Cropper state and handlers
  cropperState: CropperState;
  openCropper: (file: UploadedFile, targetRatio?: string) => void;
  closeCropper: () => void;
  handleCropComplete: (croppedBlob: Blob, croppedUrl: string, newMediaFileId?: string) => Promise<void>;
  handleImageCropRequest: (suggestion: AspectRatioSuggestion) => void;
  
  // Compressor state and handlers
  compressorState: CompressorState;
  openCompressor: (file: UploadedFile) => void;
  closeCompressor: () => void;
  handleCompressComplete: (compressedBlob: Blob, compressedUrl: string, newMediaFileId?: string) => Promise<void>;
  
  // Processing jobs
  processingJobs: ProcessingJob[];
  onRetryJob: (jobId: string) => void;
  onDismissJob: (jobId: string) => void;
  onClearJobs: () => void;
}

/**
 * Hook for managing media cropping and compression
 */
export function useMediaEditors({
  files,
  setFiles,
  uploadFileToStorage,
  user,
  flags,
  isFlagsLoading,
}: UseMediaEditorsProps): UseMediaEditorsReturn {
  const { toast } = useToast();
  
  // Processing jobs from context
  const { jobs: processingJobs, addJob, updateJob, removeJob, clearCompleted, retryJob, registerRetryHandler } = useProcessingJobsContext();

  // Cropper state
  const [cropperState, setCropperState] = useState<CropperState>({
    open: false,
    mediaSrc: "",
    mediaType: "image",
    fileId: null,
    targetRatio: undefined,
    mediaFileId: null,
  });

  // Compressor state
  const [compressorState, setCompressorState] = useState<CompressorState>({
    open: false,
    file: null,
    fileId: null,
    src: "",
    mediaFileId: null,
  });

  // Register retry handler to re-open the appropriate editor
  useEffect(() => {
    registerRetryHandler((job: ProcessingJob) => {
      if (!job.retryContext) {
        toast({
          title: "Cannot retry",
          description: "Missing context for retry operation.",
          variant: "destructive",
        });
        return;
      }

      if (job.operation === "crop" && job.retryContext.mediaSrc) {
        // Re-open cropper with the saved context
        setCropperState({
          open: true,
          mediaSrc: job.retryContext.mediaSrc,
          mediaType: job.retryContext.mediaType || "image",
          fileId: job.fileId,
          targetRatio: job.retryContext.targetRatio,
          mediaFileId: job.retryContext.mediaFileId || null,
        });
      } else if (job.operation === "compress" && job.retryContext.mediaSrc) {
        // Re-open compressor with the saved context
        setCompressorState({
          open: true,
          file: job.retryContext.file || null,
          fileId: job.fileId,
          src: job.retryContext.mediaSrc,
          mediaFileId: job.retryContext.mediaFileId || null,
        });
      }
    });
  }, [registerRetryHandler, toast]);

  /**
   * Open the cropper dialog for a specific file
   */
  const openCropper = useCallback((file: UploadedFile, targetRatio?: string) => {
    if (isFlagsLoading || !flags.imageCrop) {
      toast({
        title: "Feature disabled",
        description: "Image cropping is currently disabled by the admin.",
        variant: "destructive",
      });
      return;
    }

    setCropperState({
      open: true,
      mediaSrc: file.previewUrl,
      mediaType: file.fileType,
      fileId: file.id,
      targetRatio,
      mediaFileId: file.storagePath || null,
    });
  }, [flags.imageCrop, isFlagsLoading, toast]);

  /**
   * Close the cropper dialog
   */
  const closeCropper = useCallback(() => {
    setCropperState(prev => ({ ...prev, open: false }));
  }, []);

  /**
   * Handle crop completion - supports both image and video cropping
   */
  const handleCropComplete = useCallback(async (croppedBlob: Blob, croppedUrl: string, newMediaFileId?: string) => {
    const { fileId, mediaType } = cropperState;
    if (!fileId || !user) return;

    const originalFile = files.find(f => f.id === fileId);
    if (!originalFile) return;

    // For video cropping via Cloudinary, the newMediaFileId is already set
    if (mediaType === "video" && newMediaFileId) {
      // Video was cropped on server, update with new Cloudinary URL and mediaFileId
      setFiles(prev => prev.map(f =>
        f.id === fileId
          ? { 
              ...f, 
              previewUrl: croppedUrl, 
              cloudinaryUrl: croppedUrl,
              storagePath: newMediaFileId,
              uploaded: true, 
              uploadProgress: 100 
            }
          : f
      ));
      toast({ title: "Video cropped", description: "Your video has been cropped successfully." });
      return;
    }

    // For images, create new file and re-upload
    const croppedFile = createJpegFile(croppedBlob, originalFile.file.name);
    URL.revokeObjectURL(originalFile.previewUrl);

    setFiles(prev => prev.map(f =>
      f.id === fileId
        ? { ...f, file: croppedFile, previewUrl: croppedUrl, uploaded: false, uploadProgress: 0 }
        : f
    ));

    const updatedFile: UploadedFile = {
      ...originalFile,
      file: croppedFile,
      previewUrl: croppedUrl,
      uploaded: false,
      uploadProgress: 0,
    };

    await uploadFileToStorage(updatedFile);
    toast({ title: "Image cropped", description: "Your image has been cropped and re-uploaded." });
  }, [cropperState, files, setFiles, uploadFileToStorage, user, toast]);

  /**
   * Handle crop request from ImageAspectRatioValidator
   */
  const handleImageCropRequest = useCallback((suggestion: AspectRatioSuggestion) => {
    if (isFlagsLoading || !flags.imageCrop) return;

    const imageFile = files.find(f => f.fileType === "image");
    if (imageFile) {
      openCropper(imageFile, suggestion.recommendedRatio);
    }
  }, [files, flags.imageCrop, isFlagsLoading, openCropper]);

  /**
   * Open the compressor dialog for a specific file
   */
  const openCompressor = useCallback((file: UploadedFile) => {
    if (isFlagsLoading || !flags.videoCompress) {
      toast({
        title: "Feature disabled",
        description: "Video compression is currently disabled by the admin.",
        variant: "destructive",
      });
      return;
    }

    setCompressorState({
      open: true,
      file: file.file,
      fileId: file.id,
      src: file.previewUrl,
      mediaFileId: file.storagePath || null,
    });
  }, [flags.videoCompress, isFlagsLoading, toast]);

  /**
   * Close the compressor dialog
   */
  const closeCompressor = useCallback(() => {
    setCompressorState(prev => ({ ...prev, open: false }));
  }, []);

  /**
   * Handle compression completion - supports server-side Cloudinary compression
   */
  const handleCompressComplete = useCallback(async (compressedBlob: Blob, compressedUrl: string, newMediaFileId?: string) => {
    const { fileId } = compressorState;
    if (!fileId || !user) return;

    const originalFile = files.find(f => f.id === fileId);
    if (!originalFile) return;

    // For server-side Cloudinary compression, the newMediaFileId is already set
    if (newMediaFileId) {
      setFiles(prev => prev.map(f =>
        f.id === fileId
          ? { 
              ...f, 
              previewUrl: compressedUrl, 
              cloudinaryUrl: compressedUrl,
              storagePath: newMediaFileId,
              uploaded: true, 
              uploadProgress: 100 
            }
          : f
      ));
      toast({ title: "Video compressed", description: "Your video has been compressed successfully." });
      return;
    }

    // Fallback: re-upload compressed file
    const compressedFile = new File([compressedBlob], originalFile.file.name, { type: originalFile.file.type });
    URL.revokeObjectURL(originalFile.previewUrl);

    setFiles(prev => prev.map(f =>
      f.id === fileId
        ? { ...f, file: compressedFile, previewUrl: compressedUrl, uploaded: false, uploadProgress: 0 }
        : f
    ));

    const updatedFile: UploadedFile = {
      ...originalFile,
      file: compressedFile,
      previewUrl: compressedUrl,
      uploaded: false,
      uploadProgress: 0,
    };

    await uploadFileToStorage(updatedFile);
    toast({ title: "Video processed", description: "Your video has been processed and re-uploaded." });
  }, [compressorState, files, setFiles, uploadFileToStorage, user, toast]);

  return {
    cropperState,
    openCropper,
    closeCropper,
    handleCropComplete,
    handleImageCropRequest,
    compressorState,
    openCompressor,
    closeCompressor,
    handleCompressComplete,
    // Processing jobs
    processingJobs,
    onRetryJob: retryJob,
    onDismissJob: removeJob,
    onClearJobs: clearCompleted,
  };
}
