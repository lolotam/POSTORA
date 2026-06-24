import { useState, useMemo, useRef, useCallback } from "react";
import { getAspectRatioLabel } from "@/lib/aspectRatioUtils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useUserRole } from "@/hooks/useUserRole";
import { format, parseISO, startOfDay, isEqual } from "date-fns";
import {
  Search,
  Image,
  Video,
  Loader2,
  Filter,
  Grid3X3,
  LayoutList,
  CheckCircle2,
  FolderOpen,
  X,
  Eye,
  CalendarDays,
  User,
  HardDrive,
  Upload,
  MoreVertical,
  Link,
  Columns,
  Pencil,
  Share2,
  RefreshCw,
  Wand2,
  Download,
  Trash2,
  Move,
  Check,
  ChevronsUpDown,
  RectangleHorizontal,
  RectangleVertical,
  Square,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { useToast } from "@/hooks/use-toast";
import { useLogMediaOperation } from "@/hooks/useMediaOperationsHistory";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Calendar as CalendarComponent } from "@/components/ui/calendar";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { PlatformIcon } from "@/components/PlatformIcon";
import {
  MediaUploadDialog,
  CreateFolderDialog,
  MoveFileDialog,
  BackgroundRemovalDialog,
  ImageToolsDialog,
  BatchImageToolsDialog,
  RenameFileDialog,
  RenameFolderDialog,
  ShareEmbedDialog,
  ReplaceFileDialog,
  BatchRenameDialog,
  getFileDisplayName,
} from "@/components/media";
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";

// Import refactored components
import {
  MediaFile,
  MediaFolder,
  SocialAccount,
  ViewMode,
  FilterType,
  DownloadProgress,
  Breadcrumb,
  formatFileSize,
  isProcessedFile,
  extractCloudName,
  DraggableMediaCard,
  DroppableFolder,
  MediaHeader,
  MediaBreadcrumbs,
  MediaSelectionBar,
  DownloadProgressBar,
  MediaPreviewDialog,
  DeleteFileDialog,
  BulkDeleteDialog,
  DeleteFolderDialog,
} from "./media-library";

export default function MediaLibrary() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [filterType, setFilterType] = useState<FilterType>("all");
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [fileToDelete, setFileToDelete] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [previewFile, setPreviewFile] = useState<MediaFile | null>(null);
  const [columnsPerRow, setColumnsPerRow] = useState(() => {
    const saved = localStorage.getItem("mediaLibraryColumnsPerRow");
    return saved ? parseInt(saved, 10) : 5;
  });

  // Filters
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined);
  const [selectedPlatform, setSelectedPlatform] = useState<string | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [aspectRatioFilter, setAspectRatioFilter] = useState<"all" | "square" | "portrait" | "landscape">("all");
  const [itemsPerPage, setItemsPerPage] = useState<number>(() => {
    const saved = localStorage.getItem("mediaLibraryItemsPerPage");
    return saved ? parseInt(saved, 10) : 50;
  });

  // Folder navigation
  const [currentFolder, setCurrentFolder] = useState("/");

  // Dialogs
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [createFolderDialogOpen, setCreateFolderDialogOpen] = useState(false);
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [bgRemovalFile, setBgRemovalFile] = useState<MediaFile | null>(null);
  const [imageToolsFile, setImageToolsFile] = useState<MediaFile | null>(null);
  const [renameFile, setRenameFile] = useState<MediaFile | null>(null);
  const [renameFolder, setRenameFolder] = useState<MediaFolder | null>(null);
  const [shareFile, setShareFile] = useState<MediaFile | null>(null);
  const [replaceFile, setReplaceFile] = useState<MediaFile | null>(null);
  const [folderToDelete, setFolderToDelete] = useState<MediaFolder | null>(null);
  const [singleFileMoveId, setSingleFileMoveId] = useState<string | null>(null);
  const [batchRenameDialogOpen, setBatchRenameDialogOpen] = useState(false);
  const [batchImageToolsOpen, setBatchImageToolsOpen] = useState(false);

  // Drag and drop state
  const [activeId, setActiveId] = useState<string | null>(null);

  const { user } = useAuth();
  const { toast } = useToast();
  const { isAdmin } = useUserRole();
  const { logOperation, completeOperation, failOperation } = useLogMediaOperation();
  const queryClient = useQueryClient();
  const healedIdsRef = useRef<Set<string>>(new Set());

  const healMetadata = useCallback((fileId: string, width: number, height: number) => {
    if (healedIdsRef.current.has(fileId)) return;
    healedIdsRef.current.add(fileId);
    supabase.from("media_files").update({ metadata: { width, height } } as any).eq("id", fileId).then(() => {
      queryClient.invalidateQueries({ queryKey: ["media-files"] });
    });
  }, [queryClient]);

  // Admin: view as another user
  const [viewAsUserId, setViewAsUserId] = useState<string | null>(null);
  const [userSearchOpen, setUserSearchOpen] = useState(false);
  const effectiveUserId = (isAdmin && viewAsUserId) ? viewAsUserId : user?.id;

  // Fetch all users for admin selector
  const { data: allUsers = [] } = useQuery({
    queryKey: ["admin-all-users"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, email, full_name, avatar_url")
        .order("email", { ascending: true });
      if (error) throw error;
      return data;
    },
    enabled: isAdmin,
    staleTime: 5 * 60 * 1000,
  });

  // Fetch media counts per user for admin badge
  const { data: userMediaCounts = {} } = useQuery({
    queryKey: ["admin-user-media-counts"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("media_files")
        .select("user_id");
      if (error) throw error;
      const counts: Record<string, number> = {};
      data.forEach((row) => {
        counts[row.user_id] = (counts[row.user_id] || 0) + 1;
      });
      return counts;
    },
    enabled: isAdmin,
    staleTime: 5 * 60 * 1000,
  });

  const viewAsUser = allUsers.find((u) => u.id === viewAsUserId);

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  // Fetch social accounts
  const { data: socialAccounts = [] } = useQuery({
    queryKey: ["social-accounts-for-filter", effectiveUserId],
    queryFn: async () => {
      if (!effectiveUserId) return [];
      const { data, error } = await supabase
        .from("social_accounts")
        .select("id, platform, platform_username, avatar_url")
        .eq("user_id", effectiveUserId)
        .eq("is_active", true);
      if (error) throw error;
      return data as SocialAccount[];
    },
    enabled: !!effectiveUserId,
  });

  // Fetch folders
  const { data: folders = [], refetch: refetchFolders } = useQuery({
    queryKey: ["media-folders", effectiveUserId],
    queryFn: async () => {
      if (!effectiveUserId) return [];
      const { data, error } = await supabase
        .from("media_folders")
        .select("*")
        .eq("user_id", effectiveUserId)
        .order("name", { ascending: true });
      if (error) throw error;
      return data as MediaFolder[];
    },
    enabled: !!effectiveUserId,
  });

  // Fetch media file to account mapping from posts
  const { data: mediaToAccountsMap = {} } = useQuery({
    queryKey: ["media-to-accounts-map", effectiveUserId],
    queryFn: async () => {
      if (!effectiveUserId) return {};
      const { data: posts, error } = await supabase
        .from("posts")
        .select(`id, media_file_ids, platform_posts (social_account_id)`)
        .eq("user_id", effectiveUserId);
      if (error) throw error;

      const map: Record<string, Set<string>> = {};
      for (const post of posts || []) {
        if (!post.media_file_ids) continue;
        const accountIds = (post.platform_posts || [])
          .map((pp: any) => pp.social_account_id)
          .filter(Boolean);
        for (const mediaId of post.media_file_ids) {
          if (!map[mediaId]) map[mediaId] = new Set();
          accountIds.forEach((id: string) => map[mediaId].add(id));
        }
      }

      const result: Record<string, string[]> = {};
      for (const [key, value] of Object.entries(map)) {
        result[key] = Array.from(value);
      }
      return result;
    },
    enabled: !!effectiveUserId,
  });

  // Fetch media files
  const { data: mediaFiles = [], isLoading, refetch } = useQuery({
    queryKey: ["media-files", effectiveUserId, mediaToAccountsMap],
    queryFn: async () => {
      if (!effectiveUserId) return [];
      const { data, error } = await supabase
        .from("media_files")
        .select("*")
        .eq("user_id", effectiveUserId)
        .order("created_at", { ascending: false });
      if (error) throw error;

      const filesWithUrls = data.map((file) => {
        let publicUrl: string;
        if (file.storage_bucket === "cloudinary") {
          if (file.file_path.startsWith("http")) {
            publicUrl = file.file_path;
          } else if (file.metadata && typeof file.metadata === "object" && "cloudinary_url" in file.metadata) {
            publicUrl = (file.metadata as { cloudinary_url?: string }).cloudinary_url || "";
          } else {
            // Fallback to file_path if it's the only option, even if it doesn't look like a URL
            publicUrl = file.file_path;
          }
        } else {
          const { data: urlData } = supabase.storage.from("media").getPublicUrl(file.file_path);
          publicUrl = urlData.publicUrl;
        }

        // Debug log for troubleshooting broken images
        if (import.meta.env.DEV) {
          console.log(`[MediaLibrary] File: ${file.file_path}`, {
            id: file.id,
            bucket: file.storage_bucket,
            publicId: file.cloudinary_public_id,
            generatedUrl: publicUrl
          });
        }

        const linkedAccountIds = mediaToAccountsMap[file.id] || file.social_account_ids || [];
        return {
          ...file,
          publicUrl,
          folder_path: file.folder_path || "/",
          linked_account_ids: linkedAccountIds,
        } as MediaFile;
      });
      return filesWithUrls;
    },
    enabled: !!effectiveUserId,
  });

  // Computed values
  const currentFolders = useMemo(() => folders.filter((f) => f.parent_path === currentFolder), [folders, currentFolder]);

  const breadcrumbs: Breadcrumb[] = useMemo(() => {
    if (currentFolder === "/") return [{ name: "Root", path: "/" }];
    const parts = currentFolder.split("/").filter(Boolean);
    const crumbs: Breadcrumb[] = [{ name: "Root", path: "/" }];
    let accPath = "";
    for (const part of parts) {
      accPath += `/${part}`;
      crumbs.push({ name: part, path: accPath });
    }
    return crumbs;
  }, [currentFolder]);

  const availableDates = useMemo(() => {
    const dates = new Set<string>();
    mediaFiles.forEach((file) => {
      dates.add(file.upload_date || format(new Date(file.created_at), "yyyy-MM-dd"));
    });
    return dates;
  }, [mediaFiles]);

  const availablePlatforms = useMemo(() => {
    const platforms = new Set<string>();
    let hasLocalUploads = false;
    let hasCloudinaryFiles = false;
    let hasProcessedFiles = false;

    mediaFiles.forEach((file) => {
      if (file.storage_bucket === "media" || file.storage_bucket === "supabase") hasLocalUploads = true;
      if (file.storage_bucket === "cloudinary") hasCloudinaryFiles = true;
      if (isProcessedFile(file.file_path)) hasProcessedFiles = true;
      file.platforms?.forEach((p) => platforms.add(p));
      file.linked_account_ids?.forEach((accountId) => {
        const account = socialAccounts.find((a) => a.id === accountId);
        if (account) platforms.add(account.platform);
      });
    });

    const result = Array.from(platforms);
    if (hasProcessedFiles) result.unshift("_processed");
    if (hasCloudinaryFiles) result.unshift("_cloudinary");
    if (hasLocalUploads) result.unshift("_local");
    return result;
  }, [mediaFiles, socialAccounts]);

  const accountsWithMedia = useMemo(() => {
    const accountIds = new Set<string>();
    mediaFiles.forEach((file) => {
      file.linked_account_ids?.forEach((id) => accountIds.add(id));
    });
    return socialAccounts.filter((a) => accountIds.has(a.id));
  }, [mediaFiles, socialAccounts]);

  const filteredFiles = useMemo(() => {
    return mediaFiles.filter((file) => {
      const matchesFolder = file.folder_path === currentFolder;
      const matchesSearch = file.file_path.toLowerCase().includes(search.toLowerCase());
      const matchesType = filterType === "all" || file.file_type === filterType;

      let matchesDate = true;
      if (selectedDate) {
        const fileDate = file.upload_date ? parseISO(file.upload_date) : startOfDay(new Date(file.created_at));
        matchesDate = isEqual(startOfDay(selectedDate), startOfDay(fileDate));
      }

      let matchesPlatform = true;
      if (selectedPlatform) {
        if (selectedPlatform === "_local") {
          matchesPlatform = file.storage_bucket === "media" || file.storage_bucket === "supabase";
        } else if (selectedPlatform === "_cloudinary") {
          matchesPlatform = file.storage_bucket === "cloudinary";
        } else if (selectedPlatform === "_processed") {
          matchesPlatform = isProcessedFile(file.file_path);
        } else {
          const directMatch = file.platforms?.includes(selectedPlatform) || false;
          const accountMatch = file.linked_account_ids?.some((accountId) => {
            const account = socialAccounts.find((a) => a.id === accountId);
            return account?.platform === selectedPlatform;
          }) || false;
          matchesPlatform = directMatch || accountMatch;
        }
      }

      let matchesAccount = true;
      if (selectedAccountId) {
        matchesAccount = file.linked_account_ids?.includes(selectedAccountId) || false;
      }

      // Aspect ratio filter
      let matchesAspectRatio = true;
      if (aspectRatioFilter !== "all") {
        const meta = file.metadata as Record<string, unknown> | null;
        const w = meta?.width as number | undefined;
        const h = meta?.height as number | undefined;
        if (w && h) {
          const ratio = w / h;
          if (aspectRatioFilter === "square") matchesAspectRatio = ratio >= 0.9 && ratio <= 1.1;
          else if (aspectRatioFilter === "portrait") matchesAspectRatio = ratio < 0.9;
          else if (aspectRatioFilter === "landscape") matchesAspectRatio = ratio > 1.1;
        }
      }

      return matchesFolder && matchesSearch && matchesType && matchesDate && matchesPlatform && matchesAccount && matchesAspectRatio;
    });
  }, [mediaFiles, currentFolder, search, filterType, selectedDate, selectedPlatform, selectedAccountId, aspectRatioFilter, socialAccounts]);

  const displayedFiles = useMemo(() => filteredFiles.slice(0, itemsPerPage), [filteredFiles, itemsPerPage]);

  const hasActiveFilters = selectedDate || selectedPlatform || selectedAccountId || filterType !== "all" || aspectRatioFilter !== "all" || search || itemsPerPage !== 50;

  const getAccountInfo = (accountId: string) => socialAccounts.find((a) => a.id === accountId);

  // Handlers
  const handleSendToPost = () => {
    if (selectedFiles.size === 0) {
      toast({ title: "No files selected", description: "Please select at least one file to send to post", variant: "destructive" });
      return;
    }
    const filesToSend = mediaFiles.filter((f) => selectedFiles.has(f.id));
    const mediaData = filesToSend.map((f) => ({
      id: f.id,
      url: f.publicUrl,
      fileType: f.file_type,
      fileName: f.file_path.split("/").pop() || "file",
      size: f.file_size,
      storageBucket: f.storage_bucket,
      cloudinaryPublicId: f.cloudinary_public_id,
    }));
    sessionStorage.setItem("mediaLibrarySelection", JSON.stringify(mediaData));
    toast({ title: "Media selected", description: `${filesToSend.length} file(s) ready for your new post` });
    navigate("/post?from=media-library");
  };

  const clearFilters = () => {
    setSelectedDate(undefined);
    setSelectedPlatform(null);
    setSelectedAccountId(null);
    setAspectRatioFilter("all");
    setFilterType("all");
    setSearch("");
    setItemsPerPage(50);
    localStorage.setItem("mediaLibraryItemsPerPage", "50");
  };

  const handleDelete = async (fileId: string) => {
    const file = mediaFiles.find((f) => f.id === fileId);
    if (!file) return;

    const startTime = Date.now();
    let operationId: string | null = null;

    try {
      // Log the operation
      operationId = await logOperation({
        operationType: "delete_file",
        mediaFileId: file.id,
        fileName: file.file_path.split("/").pop() || file.file_path,
        sourceUrl: file.publicUrl,
        operationDetails: {
          fileType: file.file_type,
          fileSize: file.file_size,
        },
      });

      if (file.storage_bucket === "cloudinary" && file.cloudinary_public_id) {
        await supabase.functions.invoke("cloudinary-delete", {
          body: { publicIds: [file.cloudinary_public_id], resourceType: file.file_type },
        });
      } else {
        await supabase.storage.from("media").remove([file.file_path]);
      }
      await supabase.from("media_files").delete().eq("id", fileId);
      toast({ title: "File deleted", description: "The file has been removed from your library." });

      if (operationId) {
        await completeOperation(operationId, undefined, Date.now() - startTime);
      }

      refetch();
    } catch (error) {
      console.error("Delete error:", error);
      toast({ title: "Delete failed", description: "Failed to delete file. Please try again.", variant: "destructive" });

      if (operationId) {
        await failOperation(
          operationId,
          error instanceof Error ? error.message : "Delete failed",
          Date.now() - startTime
        );
      }
    }
  };

  const handleBulkDelete = async () => {
    const filesToDelete = mediaFiles.filter((f) => selectedFiles.has(f.id));
    const cloudinaryFiles = filesToDelete.filter((f) => f.storage_bucket === "cloudinary" && f.cloudinary_public_id);
    const supabaseFiles = filesToDelete.filter((f) => f.storage_bucket !== "cloudinary");

    const startTime = Date.now();
    let operationId: string | null = null;

    try {
      // Log the operation
      operationId = await logOperation({
        operationType: "delete_bulk",
        operationDetails: {
          filesCount: selectedFiles.size,
          fileTypes: {
            images: filesToDelete.filter(f => f.file_type === "image").length,
            videos: filesToDelete.filter(f => f.file_type === "video").length,
          },
        },
      });

      if (cloudinaryFiles.length > 0) {
        const imageIds = cloudinaryFiles.filter((f) => f.file_type === "image").map((f) => f.cloudinary_public_id!);
        const videoIds = cloudinaryFiles.filter((f) => f.file_type === "video").map((f) => f.cloudinary_public_id!);
        if (imageIds.length > 0) {
          await supabase.functions.invoke("cloudinary-delete", { body: { publicIds: imageIds, resourceType: "image" } });
        }
        if (videoIds.length > 0) {
          await supabase.functions.invoke("cloudinary-delete", { body: { publicIds: videoIds, resourceType: "video" } });
        }
      }
      if (supabaseFiles.length > 0) {
        await supabase.storage.from("media").remove(supabaseFiles.map((f) => f.file_path));
      }
      await supabase.from("media_files").delete().in("id", Array.from(selectedFiles));
      toast({ title: "Files deleted", description: `${selectedFiles.size} files have been removed.` });

      if (operationId) {
        await completeOperation(operationId, undefined, Date.now() - startTime);
      }

      setSelectedFiles(new Set());
      refetch();
    } catch (error) {
      console.error("Bulk delete error:", error);
      toast({ title: "Delete failed", description: "Failed to delete files. Please try again.", variant: "destructive" });

      if (operationId) {
        await failOperation(
          operationId,
          error instanceof Error ? error.message : "Bulk delete failed",
          Date.now() - startTime
        );
      }
    }
  };

  const handleDeleteFolder = async () => {
    if (!folderToDelete) return;

    const startTime = Date.now();
    let operationId: string | null = null;

    try {
      // Log the operation
      operationId = await logOperation({
        operationType: "delete_folder",
        fileName: folderToDelete.name,
        operationDetails: {
          folderName: folderToDelete.name,
          folderPath: folderToDelete.full_path,
        },
      });

      await supabase.from("media_files").update({ folder_path: "/" }).eq("folder_path", folderToDelete.full_path);
      await supabase.from("media_folders").delete().eq("id", folderToDelete.id);
      toast({ title: "Folder deleted", description: `Deleted folder "${folderToDelete.name}"` });

      if (operationId) {
        await completeOperation(operationId, undefined, Date.now() - startTime);
      }

      refetchFolders();
      refetch();
      setFolderToDelete(null);
    } catch (error) {
      console.error("Delete folder error:", error);
      toast({ title: "Delete failed", description: "Could not delete folder", variant: "destructive" });

      if (operationId) {
        await failOperation(
          operationId,
          error instanceof Error ? error.message : "Delete folder failed",
          Date.now() - startTime
        );
      }
    }
  };

  const toggleFileSelection = (fileId: string) => {
    const newSelection = new Set(selectedFiles);
    if (newSelection.has(fileId)) newSelection.delete(fileId);
    else newSelection.add(fileId);
    setSelectedFiles(newSelection);
  };

  const handleDownload = async (file: MediaFile) => {
    try {
      const response = await fetch(file.publicUrl);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.file_path.split("/").pop() || "download";
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error("Download error:", error);
      toast({ title: "Download failed", description: "Could not download the file", variant: "destructive" });
    }
  };

  const handleBulkDownload = async () => {
    const filesToDownload = mediaFiles.filter((f) => selectedFiles.has(f.id));
    setDownloadProgress({ current: 0, total: filesToDownload.length });
    for (let i = 0; i < filesToDownload.length; i++) {
      setDownloadProgress({ current: i + 1, total: filesToDownload.length });
      await handleDownload(filesToDownload[i]);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    setDownloadProgress(null);
    toast({ title: "Download complete", description: `Downloaded ${filesToDownload.length} files successfully.` });
  };

  const copyFileLink = async (file: MediaFile) => {
    try {
      await navigator.clipboard.writeText(file.publicUrl);
      toast({ title: "Link copied", description: "Image link copied to clipboard" });
    } catch (error) {
      toast({ title: "Copy failed", description: "Could not copy link to clipboard", variant: "destructive" });
    }
  };

  const selectAll = () => setSelectedFiles(new Set(filteredFiles.map((f) => f.id)));
  const deselectAll = () => setSelectedFiles(new Set());
  const navigateToFolder = (path: string) => {
    setCurrentFolder(path);
    setSelectedFiles(new Set());
  };

  // Drag and drop handlers
  const handleDragStart = (event: DragStartEvent) => setActiveId(event.active.id as string);

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    if (!over) return;

    const overId = over.id as string;
    if (overId.startsWith("folder-")) {
      const targetFolder = folders.find((f) => `folder-${f.id}` === overId);
      if (!targetFolder) return;

      const draggedFileId = active.id as string;
      const draggedFile = mediaFiles.find((f) => f.id === draggedFileId);
      if (!draggedFile) return;

      const filesToMove = selectedFiles.has(draggedFileId)
        ? mediaFiles.filter((f) => selectedFiles.has(f.id) && f.folder_path !== targetFolder.full_path)
        : [draggedFile].filter((f) => f.folder_path !== targetFolder.full_path);

      if (filesToMove.length === 0) return;

      try {
        const fileIds = filesToMove.map((f) => f.id);
        await supabase.from("media_files").update({ folder_path: targetFolder.full_path }).in("id", fileIds);
        toast({
          title: filesToMove.length > 1 ? "Files moved" : "File moved",
          description: `Moved ${filesToMove.length} ${filesToMove.length > 1 ? "files" : "file"} to "${targetFolder.name}"`,
        });
        if (selectedFiles.has(draggedFileId)) setSelectedFiles(new Set());
        refetch();
      } catch (error) {
        console.error("Move error:", error);
        toast({ title: "Move failed", description: "Could not move the file(s)", variant: "destructive" });
      }
    }
  };

  const activeFile = activeId ? mediaFiles.find((f) => f.id === activeId) : null;

  return (
    <DashboardLayout>
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className="space-y-6">
          {/* Admin User Selector */}
          {isAdmin && (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <label className="text-sm font-medium text-muted-foreground whitespace-nowrap">View as user:</label>
                <Popover open={userSearchOpen} onOpenChange={setUserSearchOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={userSearchOpen}
                      className="w-full max-w-sm justify-between"
                    >
                      {viewAsUser
                        ? (viewAsUser.full_name ? `${viewAsUser.full_name} (${viewAsUser.email})` : viewAsUser.email)
                        : "My Library"}
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[400px] p-0" align="start">
                    <Command>
                      <CommandInput placeholder="Search users by name or email..." />
                      <CommandList>
                        <CommandEmpty>No user found.</CommandEmpty>
                        <CommandGroup>
                          <CommandItem
                            onSelect={() => {
                              setViewAsUserId(null);
                              setSelectedFiles(new Set());
                              setCurrentFolder("/");
                              setUserSearchOpen(false);
                            }}
                          >
                            <Check className={cn("mr-2 h-4 w-4", !viewAsUserId ? "opacity-100" : "opacity-0")} />
                            My Library
                          </CommandItem>
                          {allUsers.map((u) => (
                            <CommandItem
                              key={u.id}
                              value={`${u.email} ${u.full_name || ""}`}
                              onSelect={() => {
                                setViewAsUserId(u.id);
                                setSelectedFiles(new Set());
                                setCurrentFolder("/");
                                setUserSearchOpen(false);
                              }}
                            >
                            <Check className={cn("mr-2 h-4 w-4", viewAsUserId === u.id ? "opacity-100" : "opacity-0")} />
                              <span className="flex-1">
                                {u.full_name ? `${u.full_name} (${u.email})` : u.email}
                              </span>
                              {(userMediaCounts[u.id] || 0) > 0 && (
                                <Badge variant="secondary" className="ml-2 text-xs">
                                  {userMediaCounts[u.id]}
                                </Badge>
                              )}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>
              {viewAsUser && (
                <Alert className="border-primary/30 bg-primary/5">
                  <AlertDescription className="flex items-center justify-between">
                    <span className="text-sm">
                      Viewing media library of <strong>{viewAsUser.full_name || viewAsUser.email}</strong>
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => { setViewAsUserId(null); setSelectedFiles(new Set()); setCurrentFolder("/"); }}>
                      Return to my library
                    </Button>
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}

          <MediaHeader onUpload={() => setUploadDialogOpen(true)} onCreateFolder={() => setCreateFolderDialogOpen(true)} />

          <MediaBreadcrumbs breadcrumbs={breadcrumbs} onNavigate={navigateToFolder} />

          <MediaSelectionBar
            selectedCount={selectedFiles.size}
            totalCount={filteredFiles.length}
            displayedCount={displayedFiles.length}
            allSelectedAreImages={mediaFiles.filter((f) => selectedFiles.has(f.id)).every((f) => f.file_type === "image")}
            onSelectAll={selectAll}
            onDeselectAll={deselectAll}
            onSendToPost={handleSendToPost}
            onBatchRename={() => setBatchRenameDialogOpen(true)}
            onBatchImageTools={() => setBatchImageToolsOpen(true)}
            onMove={() => setMoveDialogOpen(true)}
            onDownload={handleBulkDownload}
            onDelete={() => setDeleteDialogOpen(true)}
          />

          {downloadProgress && <DownloadProgressBar progress={downloadProgress} onCancel={() => setDownloadProgress(null)} />}

          {/* Filters */}
          <div className="flex flex-col gap-4">
            <div className="flex flex-col sm:flex-row gap-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input placeholder="Search files..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-10" />
              </div>
              <div className="flex gap-2 flex-wrap">
                {/* Date Filter */}
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className={cn("gap-2", selectedDate && "border-primary")}>
                      <CalendarDays className="w-4 h-4" />
                      {selectedDate ? format(selectedDate, "MMM d, yyyy") : "Date"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <CalendarComponent
                      mode="single"
                      selected={selectedDate}
                      onSelect={setSelectedDate}
                      modifiers={{ hasMedia: (date) => availableDates.has(format(date, "yyyy-MM-dd")) }}
                      modifiersStyles={{ hasMedia: { fontWeight: "bold" } }}
                      initialFocus
                    />
                    {selectedDate && (
                      <div className="p-3 border-t">
                        <Button variant="ghost" size="sm" className="w-full" onClick={() => setSelectedDate(undefined)}>
                          Clear date
                        </Button>
                      </div>
                    )}
                  </PopoverContent>
                </Popover>

                {/* Platform Filter */}
                {availablePlatforms.length > 0 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" className={cn("gap-2", selectedPlatform && "border-primary")}>
                        {selectedPlatform === "_local" ? <HardDrive className="w-4 h-4" /> : selectedPlatform === "_cloudinary" ? <Upload className="w-4 h-4" /> : selectedPlatform === "_processed" ? <Wand2 className="w-4 h-4" /> : selectedPlatform ? <PlatformIcon platform={selectedPlatform as any} size="sm" /> : <Filter className="w-4 h-4" />}
                        {!selectedPlatform ? "Source" : selectedPlatform === "_local" ? "Local" : selectedPlatform === "_cloudinary" ? "Cloud" : selectedPlatform === "_processed" ? "Processed" : null}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setSelectedPlatform(null)}>All Sources</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      {availablePlatforms.map((platform) => (
                        <DropdownMenuItem key={platform} onClick={() => setSelectedPlatform(platform)}>
                          {platform === "_local" ? <><HardDrive className="w-4 h-4 mr-2" />Local Uploads</> : platform === "_cloudinary" ? <><Upload className="w-4 h-4 mr-2" />Cloudinary Files</> : platform === "_processed" ? <><Wand2 className="w-4 h-4 mr-2" />Processed Files</> : <><PlatformIcon platform={platform as any} size="sm" className="mr-2" />{platform.charAt(0).toUpperCase() + platform.slice(1)}</>}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}

                {/* Account Filter */}
                {accountsWithMedia.length > 0 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" className={cn("gap-2", selectedAccountId && "border-primary")}>
                        {selectedAccountId ? (
                          <>
                            <Avatar className="h-4 w-4">
                              <AvatarImage src={getAccountInfo(selectedAccountId)?.avatar_url || undefined} />
                              <AvatarFallback className="text-[8px]">{(getAccountInfo(selectedAccountId)?.platform_username || "?")[0]?.toUpperCase()}</AvatarFallback>
                            </Avatar>
                            <span className="max-w-[80px] truncate">{getAccountInfo(selectedAccountId)?.platform_username || "Account"}</span>
                          </>
                        ) : (
                          <><User className="w-4 h-4" />Account</>
                        )}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                      <DropdownMenuItem onClick={() => setSelectedAccountId(null)}>All Accounts</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      {accountsWithMedia.map((account) => (
                        <DropdownMenuItem key={account.id} onClick={() => setSelectedAccountId(account.id)}>
                          <div className="flex items-center gap-2">
                            <Avatar className="h-5 w-5">
                              <AvatarImage src={account.avatar_url || undefined} />
                              <AvatarFallback className="text-[10px]">{(account.platform_username || "?")[0]?.toUpperCase()}</AvatarFallback>
                            </Avatar>
                            <PlatformIcon platform={account.platform as any} size="sm" />
                            <span className="truncate">{account.platform_username}</span>
                          </div>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}

                {/* Type Filter */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" className={cn("gap-2", filterType !== "all" && "border-primary")}>
                      <Filter className="w-4 h-4" />
                      {filterType === "all" ? "All" : filterType === "image" ? "Images" : "Videos"}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setFilterType("all")}>All Files</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setFilterType("image")}><Image className="w-4 h-4 mr-2" />Images Only</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setFilterType("video")}><Video className="w-4 h-4 mr-2" />Videos Only</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                {/* Aspect Ratio Filter */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" className={cn("gap-2", aspectRatioFilter !== "all" && "border-primary")}>
                      {aspectRatioFilter === "square" ? <Square className="w-4 h-4" /> :
                       aspectRatioFilter === "portrait" ? <RectangleVertical className="w-4 h-4" /> :
                       aspectRatioFilter === "landscape" ? <RectangleHorizontal className="w-4 h-4" /> :
                       <RectangleHorizontal className="w-4 h-4" />}
                      {aspectRatioFilter === "all" ? "Ratio" : aspectRatioFilter === "square" ? "Square" : aspectRatioFilter === "portrait" ? "Portrait" : "Landscape"}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setAspectRatioFilter("all")}>All Ratios</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setAspectRatioFilter("square")}><Square className="w-4 h-4 mr-2" />Square (1:1)</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setAspectRatioFilter("portrait")}><RectangleVertical className="w-4 h-4 mr-2" />Portrait</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setAspectRatioFilter("landscape")}><RectangleHorizontal className="w-4 h-4 mr-2" />Landscape</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                {/* Items per page */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" className={cn("gap-2", itemsPerPage !== 50 && "border-primary")}>
                      <Filter className="w-4 h-4" />{itemsPerPage} items
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="bg-background">
                    {[5, 8, 10, 20, 50].map((count) => (
                      <DropdownMenuItem key={count} onClick={() => { setItemsPerPage(count); localStorage.setItem("mediaLibraryItemsPerPage", count.toString()); }} className={cn(itemsPerPage === count && "bg-secondary")}>{count} items</DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>

                {/* Columns per row */}
                {viewMode === "grid" && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" className="gap-2"><Columns className="w-4 h-4" />{columnsPerRow}</Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="bg-background">
                      {[4, 5, 6, 7, 8, 10].map((cols) => (
                        <DropdownMenuItem key={cols} onClick={() => { setColumnsPerRow(cols); localStorage.setItem("mediaLibraryColumnsPerRow", cols.toString()); }} className={cn(columnsPerRow === cols && "bg-secondary")}>{cols} per row</DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}

                {/* View mode toggle */}
                <div className="flex border border-border rounded-lg overflow-hidden">
                  <Button variant="ghost" size="icon" className={cn("rounded-none", viewMode === "grid" && "bg-secondary")} onClick={() => setViewMode("grid")}><Grid3X3 className="w-4 h-4" /></Button>
                  <Button variant="ghost" size="icon" className={cn("rounded-none", viewMode === "list" && "bg-secondary")} onClick={() => setViewMode("list")}><LayoutList className="w-4 h-4" /></Button>
                </div>
              </div>
            </div>

            {/* Active filters display */}
            {hasActiveFilters && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm text-muted-foreground">Active filters:</span>
                {selectedDate && (
                  <Badge variant="secondary" className="gap-1">
                    <CalendarDays className="w-3 h-3" />{format(selectedDate, "MMM d, yyyy")}
                    <button onClick={() => setSelectedDate(undefined)} className="ml-1 hover:text-destructive"><X className="w-3 h-3" /></button>
                  </Badge>
                )}
                {selectedPlatform && (
                  <Badge variant="secondary" className="gap-1">
                    {selectedPlatform === "_local" ? <HardDrive className="w-3 h-3" /> : selectedPlatform === "_cloudinary" ? <Upload className="w-3 h-3" /> : selectedPlatform === "_processed" ? <Wand2 className="w-3 h-3" /> : <PlatformIcon platform={selectedPlatform as any} size="sm" />}
                    {selectedPlatform === "_local" ? "Local Uploads" : selectedPlatform === "_cloudinary" ? "Cloudinary" : selectedPlatform === "_processed" ? "Processed" : selectedPlatform}
                    <button onClick={() => setSelectedPlatform(null)} className="ml-1 hover:text-destructive"><X className="w-3 h-3" /></button>
                  </Badge>
                )}
                {selectedAccountId && getAccountInfo(selectedAccountId) && (
                  <Badge variant="secondary" className="gap-1">
                    <User className="w-3 h-3" />{getAccountInfo(selectedAccountId)?.platform_username}
                    <button onClick={() => setSelectedAccountId(null)} className="ml-1 hover:text-destructive"><X className="w-3 h-3" /></button>
                  </Badge>
                )}
                {filterType !== "all" && (
                  <Badge variant="secondary" className="gap-1">
                    {filterType === "image" ? <Image className="w-3 h-3" /> : <Video className="w-3 h-3" />}{filterType}s
                    <button onClick={() => setFilterType("all")} className="ml-1 hover:text-destructive"><X className="w-3 h-3" /></button>
                  </Badge>
                )}
                {aspectRatioFilter !== "all" && (
                  <Badge variant="secondary" className="gap-1">
                    {aspectRatioFilter === "square" ? <Square className="w-3 h-3" /> :
                     aspectRatioFilter === "portrait" ? <RectangleVertical className="w-3 h-3" /> :
                     <RectangleHorizontal className="w-3 h-3" />}
                    {aspectRatioFilter}
                    <button onClick={() => setAspectRatioFilter("all")} className="ml-1 hover:text-destructive"><X className="w-3 h-3" /></button>
                  </Badge>
                )}
                <Button variant="ghost" size="sm" onClick={clearFilters}>Clear all</Button>
              </div>
            )}
          </div>

          {/* Loading / Empty / Content */}
          {isLoading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
          ) : displayedFiles.length === 0 && currentFolders.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-center">
              <FolderOpen className="w-16 h-16 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold">No media files</h3>
              <p className="text-muted-foreground mt-1">
                {hasActiveFilters ? "No files match your current filters" : "Upload some images or videos to get started"}
              </p>
              {hasActiveFilters && (
                <Button variant="outline" className="mt-4" onClick={clearFilters}>Clear Filters</Button>
              )}
            </div>
          ) : (
            <>
              {/* Folders */}
              {currentFolders.length > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-3">
                  {currentFolders.map((folder) => (
                    <DroppableFolder key={folder.id} folder={folder} onNavigate={navigateToFolder} onRename={setRenameFolder} onDelete={setFolderToDelete} />
                  ))}
                </div>
              )}

              {/* Files Grid/List - simplified for brevity, uses DraggableMediaCard */}
              {viewMode === "grid" ? (
                <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${columnsPerRow}, minmax(0, 1fr))` }}>
                  {displayedFiles.map((file) => (
                    <DraggableMediaCard key={file.id} file={file}>
                      <div className={cn("relative rounded-xl overflow-hidden border-2 transition-all cursor-pointer aspect-square", selectedFiles.has(file.id) ? "border-primary bg-primary/5" : "border-border hover:border-primary/50")} onClick={() => toggleFileSelection(file.id)}>
                        {file.file_type === "image" ? <img src={file.publicUrl} alt="" className="w-full h-full object-cover" onLoad={(e) => { if (!file.metadata?.width) { const img = e.currentTarget; if (img.naturalWidth > 0) healMetadata(file.id, img.naturalWidth, img.naturalHeight); } }} /> : <video src={file.publicUrl} className="w-full h-full object-cover" onLoadedMetadata={(e) => { if (!file.metadata?.width) { const vid = e.currentTarget; if (vid.videoWidth > 0) healMetadata(file.id, vid.videoWidth, vid.videoHeight); } }} />}
                        <div className="absolute bottom-1 left-1 flex gap-0.5">
                          <Badge variant="secondary" className="text-[10px] px-1 py-0 opacity-80">{file.file_type === "video" ? "Video" : "Image"}</Badge>
                          {(() => { const label = getAspectRatioLabel(file.metadata?.width as number, file.metadata?.height as number); return label ? <Badge variant="secondary" className="text-[10px] px-1 py-0 opacity-80">{label}</Badge> : null; })()}
                        </div>
                        <Button size="icon" variant="secondary" className={cn("absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-0 group-hover:opacity-100 transition-opacity shadow-lg", columnsPerRow >= 10 ? "h-5 w-5" : columnsPerRow >= 8 ? "h-7 w-7" : "h-10 w-10")} onClick={(e) => { e.stopPropagation(); setPreviewFile(file); }}><Eye className={columnsPerRow >= 10 ? "w-2.5 h-2.5" : columnsPerRow >= 8 ? "w-3.5 h-3.5" : "w-5 h-5"} /></Button>
                        <div className={cn("absolute rounded-full flex items-center justify-center transition-all", columnsPerRow >= 10 ? "top-0.5 left-0.5 w-3 h-3" : columnsPerRow >= 8 ? "top-1 left-1 w-4 h-4" : "top-1 left-1 w-6 h-6", selectedFiles.has(file.id) ? "bg-primary text-primary-foreground" : "bg-background/80 backdrop-blur opacity-0 group-hover:opacity-100")}>{selectedFiles.has(file.id) ? <CheckCircle2 className={columnsPerRow >= 10 ? "w-2 h-2" : columnsPerRow >= 8 ? "w-3 h-3" : "w-4 h-4"} /> : <div className={cn("rounded-full border-2 border-muted-foreground", columnsPerRow >= 10 ? "w-1.5 h-1.5" : columnsPerRow >= 8 ? "w-2 h-2" : "w-3 h-3")} />}</div>
                        <div className={cn("absolute flex items-center opacity-0 group-hover:opacity-100 transition-opacity", columnsPerRow >= 10 ? "top-0.5 right-0.5 gap-0" : columnsPerRow >= 8 ? "top-1 right-1 gap-0.5" : "top-1 right-1 gap-1")}>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}><Button size="icon" variant="secondary" aria-label="View more options" className={columnsPerRow >= 10 ? "h-4 w-4" : columnsPerRow >= 8 ? "h-5 w-5" : "h-7 w-7"}><MoreVertical className={columnsPerRow >= 10 ? "w-2 h-2" : columnsPerRow >= 8 ? "w-2.5 h-2.5" : "w-3 h-3"} /></Button></DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="bg-background">
                              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setPreviewFile(file); }}><Eye className="w-4 h-4 mr-2" />Open</DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setRenameFile(file); }}><Pencil className="w-4 h-4 mr-2" />Rename</DropdownMenuItem>
                              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setShareFile(file); }}><Share2 className="w-4 h-4 mr-2" />Share / Embed</DropdownMenuItem>
                              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setSingleFileMoveId(file.id); }}><Move className="w-4 h-4 mr-2" />Move</DropdownMenuItem>
                              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setReplaceFile(file); }}><RefreshCw className="w-4 h-4 mr-2" />Replace</DropdownMenuItem>
                              {file.file_type === "image" && <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setImageToolsFile(file); }}><Wand2 className="w-4 h-4 mr-2" />Image Tools</DropdownMenuItem>}
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleDownload(file); }}><Download className="w-4 h-4 mr-2" />Download</DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem className="text-destructive" onClick={(e) => { e.stopPropagation(); setFileToDelete(file.id); }}><Trash2 className="w-4 h-4 mr-2" />Delete</DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>
                    </DraggableMediaCard>
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  {displayedFiles.map((file) => (
                    <div key={file.id} className={cn("flex items-center gap-4 p-3 rounded-xl border-2 transition-all cursor-pointer", selectedFiles.has(file.id) ? "border-primary bg-primary/5" : "border-border hover:border-primary/50")} onClick={() => toggleFileSelection(file.id)}>
                      <div className="w-16 h-16 rounded-lg overflow-hidden bg-muted shrink-0">{file.file_type === "image" ? <img src={file.publicUrl} alt="" className="w-full h-full object-cover" onLoad={(e) => { if (!file.metadata?.width) { const img = e.currentTarget; if (img.naturalWidth > 0) healMetadata(file.id, img.naturalWidth, img.naturalHeight); } }} /> : <video src={file.publicUrl} className="w-full h-full object-cover" onLoadedMetadata={(e) => { if (!file.metadata?.width) { const vid = e.currentTarget; if (vid.videoWidth > 0) healMetadata(file.id, vid.videoWidth, vid.videoHeight); } }} />}</div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{getFileDisplayName(file)}</p>
                        <div className="flex items-center gap-4 text-sm text-muted-foreground mt-1">
                          <span className="flex items-center gap-1">{file.file_type === "image" ? <Image className="w-3 h-3" /> : <Video className="w-3 h-3" />}{file.file_type}</span>
                          <span>{formatFileSize(file.file_size)}</span>
                          {(() => { const label = getAspectRatioLabel(file.metadata?.width as number, file.metadata?.height as number); return label ? <Badge variant="secondary" className="text-[10px] px-1 py-0">{label}</Badge> : null; })()}
                          <span>{format(new Date(file.created_at), "MMM d, yyyy")}</span>
                        </div>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}><Button size="icon" variant="ghost" aria-label="View more options"><MoreVertical className="w-4 h-4" /></Button></DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="bg-background">
                          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setPreviewFile(file); }}><Eye className="w-4 h-4 mr-2" />Open</DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setRenameFile(file); }}><Pencil className="w-4 h-4 mr-2" />Rename</DropdownMenuItem>
                          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleDownload(file); }}><Download className="w-4 h-4 mr-2" />Download</DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-destructive" onClick={(e) => { e.stopPropagation(); setFileToDelete(file.id); }}><Trash2 className="w-4 h-4 mr-2" />Delete</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Drag Overlay */}
        <DragOverlay>
          {activeFile && (
            <div className="relative">
              <div className="w-24 h-24 rounded-lg overflow-hidden border-2 border-primary shadow-lg bg-muted">{activeFile.file_type === "image" ? <img src={activeFile.publicUrl} alt="" className="w-full h-full object-cover" /> : <video src={activeFile.publicUrl} className="w-full h-full object-cover" />}</div>
              {selectedFiles.has(activeFile.id) && selectedFiles.size > 1 && <div className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center shadow-lg">{selectedFiles.size}</div>}
            </div>
          )}
        </DragOverlay>

        {/* Dialogs */}
        <MediaUploadDialog open={uploadDialogOpen} onClose={() => setUploadDialogOpen(false)} currentFolder={currentFolder} onUploadComplete={() => refetch()} />
        {user && <CreateFolderDialog open={createFolderDialogOpen} onClose={() => setCreateFolderDialogOpen(false)} parentPath={currentFolder} userId={user.id} onFolderCreated={() => refetchFolders()} />}
        <MoveFileDialog open={moveDialogOpen || !!singleFileMoveId} onClose={() => { setMoveDialogOpen(false); setSingleFileMoveId(null); }} fileIds={singleFileMoveId ? [singleFileMoveId] : Array.from(selectedFiles)} folders={folders} currentFolder={currentFolder} onFileMoved={() => { refetch(); setSelectedFiles(new Set()); setSingleFileMoveId(null); }} />
        {bgRemovalFile && <BackgroundRemovalDialog open={!!bgRemovalFile} onClose={() => setBgRemovalFile(null)} file={bgRemovalFile} cloudName={extractCloudName(bgRemovalFile.publicUrl)} onProcessComplete={() => refetch()} />}
        {imageToolsFile && <ImageToolsDialog open={!!imageToolsFile} onClose={() => setImageToolsFile(null)} file={imageToolsFile} cloudName={extractCloudName(imageToolsFile.publicUrl)} onProcessComplete={() => refetch()} />}
        <BatchImageToolsDialog files={mediaFiles.filter((f) => selectedFiles.has(f.id))} open={batchImageToolsOpen} onClose={() => setBatchImageToolsOpen(false)} cloudName="" onProcessComplete={() => { refetch(); setSelectedFiles(new Set()); }} />
        {renameFile && <RenameFileDialog open={!!renameFile} onClose={() => setRenameFile(null)} fileId={renameFile.id} currentName={renameFile.file_path} storageBucket={renameFile.storage_bucket} cloudinaryPublicId={renameFile.cloudinary_public_id} onRenamed={() => refetch()} />}
        {renameFolder && <RenameFolderDialog open={!!renameFolder} onClose={() => setRenameFolder(null)} folderId={renameFolder.id} currentName={renameFolder.name} currentPath={renameFolder.full_path} parentPath={renameFolder.parent_path} onRenamed={() => refetchFolders()} />}
        {shareFile && <ShareEmbedDialog open={!!shareFile} file={shareFile} onClose={() => setShareFile(null)} />}
        {replaceFile && user && <ReplaceFileDialog open={!!replaceFile} onClose={() => setReplaceFile(null)} file={replaceFile} userId={user.id} onReplaced={() => refetch()} />}
        <BatchRenameDialog files={mediaFiles.filter((f) => selectedFiles.has(f.id))} open={batchRenameDialogOpen} onClose={() => setBatchRenameDialogOpen(false)} onRenameComplete={() => { refetch(); setSelectedFiles(new Set()); }} />
        <MediaPreviewDialog file={previewFile} socialAccounts={socialAccounts} onClose={() => setPreviewFile(null)} onDownload={handleDownload} onCopyLink={copyFileLink} onDelete={setFileToDelete} onMove={setSingleFileMoveId} onRename={setRenameFile} onShare={setShareFile} onReplace={setReplaceFile} onImageTools={setImageToolsFile} onBgRemoval={setBgRemovalFile} />
        <DeleteFileDialog open={!!fileToDelete} onClose={() => setFileToDelete(null)} onConfirm={() => { if (fileToDelete) { handleDelete(fileToDelete); setFileToDelete(null); } }} />
        <BulkDeleteDialog open={deleteDialogOpen} count={selectedFiles.size} onClose={() => setDeleteDialogOpen(false)} onConfirm={() => { handleBulkDelete(); setDeleteDialogOpen(false); }} />
        <DeleteFolderDialog folder={folderToDelete} onClose={() => setFolderToDelete(null)} onConfirm={handleDeleteFolder} />
      </DndContext>
    </DashboardLayout>
  );
}
