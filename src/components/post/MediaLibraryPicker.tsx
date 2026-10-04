import { useState, useMemo, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { getAspectRatioLabel } from "@/lib/aspectRatioUtils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCdnConfig } from "@/hooks/useCdnConfig";
import { resolveMediaPublicUrl } from "@/lib/mediaUrl";
import { isPostableLibraryFile, librarySearchText } from "@/lib/mediaTypes";
import { mergeHealedDimensions } from "@/lib/mediaMetadata";
import { useAuth } from "@/hooks/useAuth";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
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
import { 
  FolderOpen, 
  Image, 
  Video, 
  Search, 
  Check,
  ChevronRight,
  Home,
  Loader2,
  Calendar,
  Filter,
  X,
  User,
  Grid3X3,
  LayoutList,
  Columns,
  HardDrive,
  Upload,
  Wand2,
  RectangleHorizontal,
  RectangleVertical,
  Square,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { UploadedFile } from "@/hooks/usePostForm";
import { format, startOfDay, isEqual, parseISO } from "date-fns";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Icon3D, GradientHeading, GradientRingCard, Reveal } from "@/components/fx";

interface MediaFile {
  id: string;
  file_path: string;
  current_object_version?: number;
  media_file_providers?: Array<{ provider: string; object_version: number; status: string; delivery_url?: string | null }>;
  file_type: string;
  file_size: number | null;
  created_at: string | null;
  upload_date: string | null;
  folder_path: string | null;
  platforms: string[] | null;
  social_account_ids: string[] | null;
  storage_bucket: string | null;
  metadata: {
    width?: number;
    height?: number;
    duration?: number;
    format?: string;
    kind?: string;
    original_filename?: string;
  } | null;
}

interface MediaLibraryPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (files: UploadedFile[]) => void;
  maxFiles?: number;
  currentFileCount?: number;
  /** When true, only show images (no videos) - used for AI generators */
  imagesOnly?: boolean;
  /** When true, show extended filters (date, source, account, items per page) - now always shows full filters */
  showExtendedFilters?: boolean;
}

type ViewMode = "grid" | "list";
type FilterType = "all" | "image" | "video";
type AspectRatioFilter = "all" | "square" | "portrait" | "landscape";
type ItemsPerPage = 5 | 8 | 10 | 20 | 50;
type ColumnsPerRow = 4 | 5 | 6 | 7 | 8;

export function MediaLibraryPicker({
  open,
  onOpenChange,
  onSelect,
  maxFiles = 10,
  currentFileCount = 0,
  imagesOnly = false,
  showExtendedFilters = false,
}: MediaLibraryPickerProps) {
  const { t } = useTranslation("postmedia");
  const { user } = useAuth();
  const { data: cdnConfig } = useCdnConfig();
  const queryClient = useQueryClient();
  const healedIdsRef = useRef<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const healMetadata = useCallback((
    fileId: string,
    width: number,
    height: number,
    existingMetadata: MediaFile["metadata"],
  ) => {
    if (healedIdsRef.current.has(fileId)) return;
    healedIdsRef.current.add(fileId);
    const metadata = mergeHealedDimensions(existingMetadata, width, height);
    supabase.from("media_files").update({ metadata } as any).eq("id", fileId).then(({ error }) => {
      if (error) {
        // Let a later render retry rather than leaving the row permanently unhealed.
        healedIdsRef.current.delete(fileId);
        return;
      }
      // Patch the one row instead of invalidating: an invalidation refetches the
      // whole folder listing once per healed image, which is what turned opening
      // the picker into a refetch cascade. The dimensions are already known here.
      queryClient.setQueriesData<MediaFile[]>(
        { queryKey: ["media-files-picker"] },
        (files) => files?.map((file) => (file.id === fileId ? { ...file, metadata } : file)),
      );
    });
  }, [queryClient]);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPath, setCurrentPath] = useState("/");
  
  // Filter states - matching /media page exactly
  const [filterType, setFilterType] = useState<FilterType>(imagesOnly ? "image" : "all");
  const [aspectRatioFilter, setAspectRatioFilter] = useState<AspectRatioFilter>("all");
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined);
  const [selectedPlatform, setSelectedPlatform] = useState<string | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [itemsPerPage, setItemsPerPage] = useState<ItemsPerPage>(50);
  const [columnsPerRow, setColumnsPerRow] = useState<ColumnsPerRow>(5);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");

  const remainingSlots = maxFiles - currentFileCount;

  // Fetch folders
  const { data: folders = [] } = useQuery({
    queryKey: ["media-folders-picker", user?.id, currentPath],
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await supabase
        .from("media_folders")
        .select("*")
        .eq("user_id", user.id)
        .eq("parent_path", currentPath === "/" ? null : currentPath)
        .order("name");
      if (error) throw error;
      return data || [];
    },
    enabled: !!user && open,
  });

  // Fetch media files
  const { data: mediaFiles = [], isLoading } = useQuery({
    queryKey: ["media-files-picker", user?.id, currentPath],
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await supabase
        .from("media_files")
        .select("id, file_path, file_type, file_size, created_at, folder_path, metadata, platforms, social_account_ids, storage_bucket, current_object_version, media_file_providers(provider, object_version, status, delivery_url)")
        .eq("user_id", user.id)
        .eq("folder_path", currentPath)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return ((data || []) as MediaFile[]).filter((file) => isPostableLibraryFile(file));
    },
    enabled: !!user && open,
  });

  // Fetch social accounts for account filter
  const { data: socialAccounts = [] } = useQuery({
    queryKey: ["social-accounts-filter-picker", user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await supabase
        .from("social_accounts")
        .select("id, platform_username, platform, avatar_url")
        .eq("user_id", user.id)
        .eq("is_active", true);
      if (error) throw error;
      return data || [];
    },
    enabled: !!user && open,
  });

  // Get unique platforms from media files for source filter
  const availablePlatforms = useMemo(() => {
    const platforms = new Set<string>();
    mediaFiles.forEach(file => {
      // Add storage-based categories
      if (file.storage_bucket === "media" || file.storage_bucket === "supabase") {
        platforms.add("_local");
      }
      if (file.storage_bucket === "cloudinary") {
        platforms.add("_cloudinary");
      }
      // Check for processed files
      const fileName = file.file_path.split("/").pop() || "";
      if (fileName.includes("bg-removed") || fileName.includes("filtered") || 
          fileName.includes("upscaled") || fileName.includes("_square") ||
          fileName.includes("_portrait") || fileName.includes("_landscape") ||
          fileName.includes("_custom")) {
        platforms.add("_processed");
      }
      // Add actual platforms
      file.platforms?.forEach(p => platforms.add(p));
    });
    return Array.from(platforms);
  }, [mediaFiles]);

  // Get accounts that have media associated
  const accountsWithMedia = useMemo(() => {
    const accountIds = new Set<string>();
    mediaFiles.forEach(file => {
      file.social_account_ids?.forEach(id => accountIds.add(id));
    });
    return socialAccounts.filter(acc => accountIds.has(acc.id));
  }, [mediaFiles, socialAccounts]);

  // Get available dates for calendar highlighting
  const availableDates = useMemo(() => {
    const dates = new Set<string>();
    mediaFiles.forEach(file => {
      if (file.created_at) {
        dates.add(format(new Date(file.created_at), "yyyy-MM-dd"));
      }
    });
    return dates;
  }, [mediaFiles]);

  // Get account info by ID
  const getAccountInfo = (accountId: string) => {
    return socialAccounts.find((a) => a.id === accountId);
  };

  // Filter files based on all criteria
  const filteredFiles = useMemo(() => {
    let filtered = mediaFiles.filter((file) => {
      // Search filter
      const matchesSearch = searchQuery
        ? librarySearchText(file).includes(searchQuery.toLowerCase())
        : true;
      
      // Type filter - if imagesOnly, always filter to images only
      const typeToFilter = imagesOnly ? "image" : filterType;
      const matchesType = typeToFilter === "all" || file.file_type === typeToFilter;

      // Date filter
      let matchesDate = true;
      if (selectedDate) {
        const fileDate = file.created_at 
          ? startOfDay(new Date(file.created_at))
          : null;
        matchesDate = fileDate ? isEqual(startOfDay(selectedDate), fileDate) : false;
      }

      // Platform/Source filter
      let matchesPlatform = true;
      if (selectedPlatform) {
        if (selectedPlatform === "_local") {
          matchesPlatform = file.storage_bucket === "media" || file.storage_bucket === "supabase";
        } else if (selectedPlatform === "_cloudinary") {
          matchesPlatform = file.storage_bucket === "cloudinary";
        } else if (selectedPlatform === "_processed") {
          const fileName = file.file_path.split("/").pop() || "";
          matchesPlatform = fileName.includes("bg-removed") || 
                            fileName.includes("filtered") || 
                            fileName.includes("upscaled") ||
                            fileName.includes("_square") ||
                            fileName.includes("_portrait") ||
                            fileName.includes("_landscape") ||
                            fileName.includes("_custom");
        } else {
          matchesPlatform = file.platforms?.includes(selectedPlatform) || false;
        }
      }

      // Account filter
      let matchesAccount = true;
      if (selectedAccountId) {
        matchesAccount = file.social_account_ids?.includes(selectedAccountId) || false;
      }

      // Aspect ratio filter
      let matchesAspectRatio = true;
      if (aspectRatioFilter !== "all" && file.metadata?.width && file.metadata?.height) {
        const ratio = file.metadata.width / file.metadata.height;
        if (aspectRatioFilter === "square") matchesAspectRatio = ratio >= 0.9 && ratio <= 1.1;
        else if (aspectRatioFilter === "portrait") matchesAspectRatio = ratio < 0.9;
        else if (aspectRatioFilter === "landscape") matchesAspectRatio = ratio > 1.1;
      }
      
      return matchesSearch && matchesType && matchesDate && matchesPlatform && matchesAccount && matchesAspectRatio;
    });

    // Apply items per page limit
    return filtered.slice(0, itemsPerPage);
  }, [mediaFiles, searchQuery, filterType, imagesOnly, selectedDate, selectedPlatform, selectedAccountId, aspectRatioFilter, itemsPerPage]);

  // Breadcrumb navigation
  const pathParts = currentPath.split("/").filter(Boolean);
  const breadcrumbs = [
    { name: t("mediaLibrary.breadcrumbRoot", "Library"), path: "/" },
    ...pathParts.map((part, i) => ({
      name: part,
      path: "/" + pathParts.slice(0, i + 1).join("/"),
    })),
  ];

  const toggleSelection = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else if (newSelected.size < remainingSlots) {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };

  const resolvePublicUrl = (file: MediaFile): string => {
    return resolveMediaPublicUrl(file, (bucket, path) => supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl, file.media_file_providers, cdnConfig);
  };

  const handleConfirm = async () => {
    const selectedFiles = mediaFiles.filter((f) => selectedIds.has(f.id) && isPostableLibraryFile(f));
    if (selectedFiles.length === 0) return;
    
    const uploadedFiles: UploadedFile[] = selectedFiles.map((file) => {
      const publicUrl = resolvePublicUrl(file);
      const isCloudinary = file.storage_bucket === "cloudinary" || file.file_path.includes("res.cloudinary.com");

      return {
        id: `media-${file.id}-${Date.now()}`,
        file: new File([], file.file_path.split("/").pop() || "library-file"),
        previewUrl: publicUrl,
        fileType: file.file_type as "image" | "video",
        uploadProgress: 100,
        uploaded: true,
        storagePath: file.id,
        cloudinaryUrl: isCloudinary ? publicUrl : undefined,
        cloudinaryPublicId: isCloudinary ? file.file_path : undefined,
        fromMediaLibrary: true,
        width: file.metadata?.width,
        height: file.metadata?.height,
        duration: file.metadata?.duration,
      };
    });

    onSelect(uploadedFiles);
    setSelectedIds(new Set());
    onOpenChange(false);
  };

  const navigateToFolder = (path: string) => {
    setCurrentPath(path);
    setSelectedIds(new Set());
  };

  const clearFilters = () => {
    setSelectedDate(undefined);
    setSelectedPlatform(null);
    setSelectedAccountId(null);
    setAspectRatioFilter("all");
    if (!imagesOnly) {
      setFilterType("all");
    }
    setItemsPerPage(50);
    setSearchQuery("");
  };

  const hasActiveFilters = selectedDate || selectedPlatform || selectedAccountId || 
    (filterType !== "all" && !imagesOnly) || aspectRatioFilter !== "all" || searchQuery || itemsPerPage !== 50;

  // Total count for display
  const totalFilteredCount = useMemo(() => {
    return mediaFiles.filter((file) => {
      const matchesSearch = searchQuery
        ? librarySearchText(file).includes(searchQuery.toLowerCase())
        : true;
      const typeToFilter = imagesOnly ? "image" : filterType;
      const matchesType = typeToFilter === "all" || file.file_type === typeToFilter;
      let matchesDate = true;
      if (selectedDate) {
        const fileDate = file.created_at ? startOfDay(new Date(file.created_at)) : null;
        matchesDate = fileDate ? isEqual(startOfDay(selectedDate), fileDate) : false;
      }
      let matchesPlatform = true;
      if (selectedPlatform) {
        if (selectedPlatform === "_local") {
          matchesPlatform = file.storage_bucket === "media" || file.storage_bucket === "supabase";
        } else if (selectedPlatform === "_cloudinary") {
          matchesPlatform = file.storage_bucket === "cloudinary";
        } else if (selectedPlatform === "_processed") {
          const fileName = file.file_path.split("/").pop() || "";
          matchesPlatform = fileName.includes("bg-removed") || fileName.includes("filtered") || 
                            fileName.includes("upscaled") || fileName.includes("_square") ||
                            fileName.includes("_portrait") || fileName.includes("_landscape") ||
                            fileName.includes("_custom");
        } else {
          matchesPlatform = file.platforms?.includes(selectedPlatform) || false;
        }
      }
      let matchesAccount = true;
      if (selectedAccountId) {
        matchesAccount = file.social_account_ids?.includes(selectedAccountId) || false;
      }
      return matchesSearch && matchesType && matchesDate && matchesPlatform && matchesAccount;
    }).length;
  }, [mediaFiles, searchQuery, filterType, imagesOnly, selectedDate, selectedPlatform, selectedAccountId, aspectRatioFilter]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[85vh] flex flex-col bg-card border-border/50 shadow-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3 group">
            <Icon3D icon={FolderOpen} variant="sky" size="sm" />
            <GradientHeading as="h2" size="lg" preset="sky-violet" className="!text-2xl md:!text-3xl">
              {t("mediaLibrary.title", "Select from Media Library")}
            </GradientHeading>
            {imagesOnly && (
              <Badge className="text-xs bg-muted text-foreground dark:text-neutral-200 border border-input">
                {t("mediaLibrary.imagesOnly", "Images Only")}
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        {/* Filter Toolbar - matching /media page exactly */}
        <div className="flex flex-wrap items-center gap-2 pb-3 border-b">
          {/* Search */}
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder={t("mediaLibrary.searchPlaceholder", "Search files...")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="ps-9 h-9"
            />
          </div>

          {/* Date Filter */}
          <Popover>
            <PopoverTrigger asChild>
              <Button 
                variant="outline" 
                className={cn("gap-2 h-9", selectedDate && "border-primary")}
              >
                <Calendar className="w-4 h-4" />
                {selectedDate ? format(selectedDate, "MMM d") : t("mediaLibrary.dateFilter", "Date")}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <CalendarComponent
                mode="single"
                selected={selectedDate}
                onSelect={setSelectedDate}
                modifiers={{
                  hasMedia: (date) => availableDates.has(format(date, "yyyy-MM-dd")),
                }}
                modifiersStyles={{
                  hasMedia: { fontWeight: "bold" },
                }}
                initialFocus
              />
              {selectedDate && (
                <div className="p-3 border-t">
                  <Button variant="ghost" size="sm" className="w-full" onClick={() => setSelectedDate(undefined)}>
                    {t("mediaLibrary.clearDate", "Clear date")}
                  </Button>
                </div>
              )}
            </PopoverContent>
          </Popover>

          {/* Source/Platform Filter */}
          {availablePlatforms.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className={cn("gap-2 h-9", selectedPlatform && "border-primary")}>
                  {selectedPlatform === "_local" ? (
                    <>
                      <HardDrive className="w-4 h-4" />
                      {t("mediaLibrary.sourceLocal", "Local")}
                    </>
                  ) : selectedPlatform === "_cloudinary" ? (
                    <>
                      <Upload className="w-4 h-4" />
                      {t("mediaLibrary.sourceCloudinary", "Cloudinary")}
                    </>
                  ) : selectedPlatform === "_processed" ? (
                    <>
                      <Wand2 className="w-4 h-4" />
                      {t("mediaLibrary.sourceProcessed", "Processed")}
                    </>
                  ) : selectedPlatform ? (
                    <>
                      <PlatformIcon platform={selectedPlatform as any} size="sm" />
                      {selectedPlatform.charAt(0).toUpperCase() + selectedPlatform.slice(1)}
                    </>
                  ) : (
                    <>
                      <Filter className="w-4 h-4" />
                      {t("mediaLibrary.sourceFilter", "Source")}
                    </>
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setSelectedPlatform(null)}>
                  {t("mediaLibrary.allSources", "All Sources")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {availablePlatforms.map((platform) => (
                  <DropdownMenuItem key={platform} onClick={() => setSelectedPlatform(platform)}>
                    {platform === "_local" ? (
                      <>
                        <HardDrive className="w-4 h-4 me-2" />
                        {t("mediaLibrary.localUploads", "Local Uploads")}
                      </>
                    ) : platform === "_cloudinary" ? (
                      <>
                        <Upload className="w-4 h-4 me-2" />
                        {t("mediaLibrary.cloudinaryFiles", "Cloudinary Files")}
                      </>
                    ) : platform === "_processed" ? (
                      <>
                        <Wand2 className="w-4 h-4 me-2" />
                        {t("mediaLibrary.processedFiles", "Processed Files")}
                      </>
                    ) : (
                      <>
                        <PlatformIcon platform={platform as any} size="sm" className="me-2" />
                        {platform.charAt(0).toUpperCase() + platform.slice(1)}
                      </>
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Account Filter */}
          {accountsWithMedia.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className={cn("gap-2 h-9", selectedAccountId && "border-primary")}>
                  {selectedAccountId ? (
                    <>
                      <Avatar className="h-4 w-4">
                        <AvatarImage src={getAccountInfo(selectedAccountId)?.avatar_url || undefined} />
                        <AvatarFallback className="text-[8px]">
                          {(getAccountInfo(selectedAccountId)?.platform_username || "?")[0]?.toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <span className="max-w-[60px] truncate">
                        {getAccountInfo(selectedAccountId)?.platform_username || t("mediaLibrary.accountFilter", "Account")}
                      </span>
                    </>
                  ) : (
                    <>
                      <User className="w-4 h-4" />
                      {t("mediaLibrary.accountFilter", "Account")}
                    </>
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem onClick={() => setSelectedAccountId(null)}>
                  {t("mediaLibrary.allAccounts", "All Accounts")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {accountsWithMedia.map((account) => (
                  <DropdownMenuItem key={account.id} onClick={() => setSelectedAccountId(account.id)}>
                    <div className="flex items-center gap-2">
                      <Avatar className="h-5 w-5">
                        <AvatarImage src={account.avatar_url || undefined} />
                        <AvatarFallback className="text-[10px]">
                          {(account.platform_username || "?")[0]?.toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <PlatformIcon platform={account.platform as any} size="sm" />
                      <span className="truncate">{account.platform_username}</span>
                    </div>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Type Filter - only show if not imagesOnly */}
          {!imagesOnly && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className={cn("gap-2 h-9", filterType !== "all" && "border-primary")}>
                  <Filter className="w-4 h-4" />
                  {filterType === "all" ? t("mediaLibrary.allFiles", "All") : filterType === "image" ? t("mediaLibrary.typeImages", "Images") : t("mediaLibrary.typeVideos", "Videos")}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setFilterType("all")}>
                  {t("mediaLibrary.allFiles", "All Files")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setFilterType("image")}>
                  <Image className="w-4 h-4 me-2" />
                  {t("mediaLibrary.imagesOnly", "Images Only")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setFilterType("video")}>
                  <Video className="w-4 h-4 me-2" />
                  {t("mediaLibrary.videosOnly", "Videos Only")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Aspect Ratio Filter */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className={cn("gap-2 h-9", aspectRatioFilter !== "all" && "border-primary")}>
                {aspectRatioFilter === "square" ? <Square className="w-4 h-4" /> :
                 aspectRatioFilter === "portrait" ? <RectangleVertical className="w-4 h-4" /> :
                 aspectRatioFilter === "landscape" ? <RectangleHorizontal className="w-4 h-4" /> :
                 <RectangleHorizontal className="w-4 h-4" />}
                {aspectRatioFilter === "all" ? t("mediaLibrary.ratioFilter", "Ratio") : aspectRatioFilter === "square" ? t("mediaLibrary.ratioSquare", "Square") : aspectRatioFilter === "portrait" ? t("mediaLibrary.ratioPortrait", "Portrait") : t("mediaLibrary.ratioLandscape", "Landscape")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setAspectRatioFilter("all")}>{t("mediaLibrary.allRatios", "All Ratios")}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setAspectRatioFilter("square")}>
                <Square className="w-4 h-4 me-2" />{t("mediaLibrary.ratioSquare11", "Square (1:1)")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setAspectRatioFilter("portrait")}>
                <RectangleVertical className="w-4 h-4 me-2" />{t("mediaLibrary.ratioPortrait", "Portrait")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setAspectRatioFilter("landscape")}>
                <RectangleHorizontal className="w-4 h-4 me-2" />{t("mediaLibrary.ratioLandscape", "Landscape")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className={cn("gap-2 h-9", itemsPerPage !== 50 && "border-primary")}>
                <Filter className="w-4 h-4" />
                {t("mediaLibrary.itemsCount", "{{count}} items", { count: itemsPerPage })}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {[5, 8, 10, 20, 50].map((count) => (
                <DropdownMenuItem 
                  key={count} 
                  onClick={() => setItemsPerPage(count as ItemsPerPage)}
                  className={cn(itemsPerPage === count && "bg-secondary")}
                >
                  {t("mediaLibrary.itemsCount", "{{count}} items", { count })}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Columns per row - only in grid view */}
          {viewMode === "grid" && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="gap-2 h-9">
                  <Columns className="w-4 h-4" />
                  {columnsPerRow}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {[4, 5, 6, 7, 8].map((cols) => (
                  <DropdownMenuItem 
                    key={cols} 
                    onClick={() => setColumnsPerRow(cols as ColumnsPerRow)}
                    className={cn(columnsPerRow === cols && "bg-secondary")}
                  >
                    {t("mediaLibrary.colsPerRow", "{{cols}} per row", { cols })}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* View toggle */}
          <div className="flex border border-border rounded-lg overflow-hidden">
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "rounded-none h-9 w-9",
                viewMode === "grid" && "bg-secondary"
              )}
              onClick={() => setViewMode("grid")}
            >
              <Grid3X3 className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "rounded-none h-9 w-9",
                viewMode === "list" && "bg-secondary"
              )}
              onClick={() => setViewMode("list")}
            >
              <LayoutList className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* Active filters display */}
        {hasActiveFilters && (
          <div className="flex items-center gap-2 flex-wrap py-2">
            <span className="text-xs text-muted-foreground">{t("mediaLibrary.activeFilters", "Active:")}</span>
            {searchQuery && (
              <Badge variant="secondary" className="gap-1 text-xs">
                <Search className="w-3 h-3" />
                "{searchQuery}"
                <button onClick={() => setSearchQuery("")} className="ms-1 hover:text-destructive">
                  <X className="w-3 h-3" />
                </button>
              </Badge>
            )}
            {selectedDate && (
              <Badge variant="secondary" className="gap-1 text-xs">
                <Calendar className="w-3 h-3" />
                {format(selectedDate, "MMM d, yyyy")}
                <button onClick={() => setSelectedDate(undefined)} className="ms-1 hover:text-destructive">
                  <X className="w-3 h-3" />
                </button>
              </Badge>
            )}
            {selectedPlatform && (
              <Badge variant="secondary" className="gap-1 text-xs">
                {selectedPlatform === "_local" ? <HardDrive className="w-3 h-3" /> : 
                 selectedPlatform === "_cloudinary" ? <Upload className="w-3 h-3" /> :
                 selectedPlatform === "_processed" ? <Wand2 className="w-3 h-3" /> :
                 <PlatformIcon platform={selectedPlatform as any} size="sm" />}
                {selectedPlatform === "_local" ? t("mediaLibrary.sourceLocal", "Local") : 
                 selectedPlatform === "_cloudinary" ? t("mediaLibrary.sourceCloudinary", "Cloudinary") :
                 selectedPlatform === "_processed" ? t("mediaLibrary.sourceProcessed", "Processed") : selectedPlatform}
                <button onClick={() => setSelectedPlatform(null)} className="ms-1 hover:text-destructive">
                  <X className="w-3 h-3" />
                </button>
              </Badge>
            )}
            {selectedAccountId && (
              <Badge variant="secondary" className="gap-1 text-xs">
                <User className="w-3 h-3" />
                {getAccountInfo(selectedAccountId)?.platform_username || t("mediaLibrary.accountFilter", "Account")}
                <button onClick={() => setSelectedAccountId(null)} className="ms-1 hover:text-destructive">
                  <X className="w-3 h-3" />
                </button>
              </Badge>
            )}
            {filterType !== "all" && !imagesOnly && (
              <Badge variant="secondary" className="gap-1 text-xs">
                {filterType === "image" ? <Image className="w-3 h-3" /> : <Video className="w-3 h-3" />}
                {filterType}s
                <button onClick={() => setFilterType("all")} className="ms-1 hover:text-destructive">
                  <X className="w-3 h-3" />
                </button>
              </Badge>
            )}
            {aspectRatioFilter !== "all" && (
              <Badge variant="secondary" className="gap-1 text-xs">
                {aspectRatioFilter === "square" ? <Square className="w-3 h-3" /> :
                 aspectRatioFilter === "portrait" ? <RectangleVertical className="w-3 h-3" /> :
                 <RectangleHorizontal className="w-3 h-3" />}
                {aspectRatioFilter === "square" ? t("mediaLibrary.ratioSquare", "Square") :
                 aspectRatioFilter === "portrait" ? t("mediaLibrary.ratioPortrait", "Portrait") :
                 t("mediaLibrary.ratioLandscape", "Landscape")}
                <button onClick={() => setAspectRatioFilter("all")} className="ms-1 hover:text-destructive">
                  <X className="w-3 h-3" />
                </button>
              </Badge>
            )}
            {itemsPerPage !== 50 && (
              <Badge variant="secondary" className="gap-1 text-xs">
                <Filter className="w-3 h-3" />
                {t("mediaLibrary.itemsCount", "{{count}} items", { count: itemsPerPage })}
                <button onClick={() => setItemsPerPage(50)} className="ms-1 hover:text-destructive">
                  <X className="w-3 h-3" />
                </button>
              </Badge>
            )}
            <Button variant="ghost" size="sm" onClick={clearFilters} className="text-xs text-muted-foreground h-6">
              {t("mediaLibrary.clearAll", "Clear all")}
            </Button>
          </div>
        )}

        {/* Breadcrumbs */}
        <div className="flex items-center gap-1 text-sm flex-wrap">
          {breadcrumbs.map((crumb, i) => (
            <div key={crumb.path} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="w-3 h-3 text-muted-foreground" />}
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2"
                onClick={() => navigateToFolder(crumb.path)}
              >
                {i === 0 ? <Home className="w-3 h-3 me-1" /> : null}
                {crumb.name}
              </Button>
            </div>
          ))}
          <span className="ms-auto text-xs text-muted-foreground">
            {filteredFiles.length === totalFilteredCount 
              ? t("mediaLibrary.totalFilesCount", "{{count}} files", { count: totalFilteredCount })
              : t("mediaLibrary.showingFilesCount", "Showing {{current}} of {{total}} files", { current: filteredFiles.length, total: totalFilteredCount })
            }
          </span>
        </div>

        {/* Content */}
        <ScrollArea className="flex-1 min-h-[300px]">
          {isLoading ? (
            <div className="flex items-center justify-center h-full py-12">
              <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-4 p-1">
              {/* Folders */}
              {folders.length > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-2">
                  {folders.map((folder) => (
                    <button
                      key={folder.id}
                      onClick={() => navigateToFolder(folder.full_path)}
                      className="flex flex-col items-center gap-1 p-3 rounded-lg border hover:bg-secondary/50 transition-colors"
                    >
                      <FolderOpen className="w-8 h-8 text-primary" />
                      <span className="text-xs text-center truncate w-full">
                        {folder.name}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {/* Files */}
              {filteredFiles.length === 0 && folders.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <FolderOpen className="w-12 h-12 mx-auto mb-3 opacity-50" />
                  <p>
                    {imagesOnly
                      ? t("mediaLibrary.noImagesInFolder", "No images in this folder")
                      : t("mediaLibrary.noMediaInFolder", "No media files in this folder")}
                  </p>
                </div>
              ) : viewMode === "grid" ? (
                <div 
                  className="grid gap-2"
                  style={{
                    gridTemplateColumns: `repeat(${columnsPerRow}, minmax(0, 1fr))`
                  }}
                >
                  {filteredFiles.map((file) => {
                    const isSelected = selectedIds.has(file.id);
                    const isDisabled = !isSelected && selectedIds.size >= remainingSlots;

                    return (
                      <button
                        key={file.id}
                        onClick={() => !isDisabled && toggleSelection(file.id)}
                        disabled={isDisabled}
                        className={cn(
                          "relative aspect-square rounded-lg overflow-hidden border-2 transition-all",
                          isSelected
                            ? "border-primary ring-2 ring-primary/30"
                            : "border-transparent hover:border-primary/50",
                          isDisabled && "opacity-50 cursor-not-allowed"
                        )}
                      >
                        {file.file_type === "video" ? (
                          <video
                            src={resolvePublicUrl(file)}
                            className="w-full h-full object-cover"
                            muted
                            preload="metadata"
                            onLoadedMetadata={(e) => { if (!file.metadata?.width) { const vid = e.currentTarget; if (vid.videoWidth > 0) healMetadata(file.id, vid.videoWidth, vid.videoHeight, file.metadata); } }}
                          />
                        ) : (
                          <img
                            src={resolvePublicUrl(file)}
                            alt=""
                            className="w-full h-full object-cover"
                            loading="lazy"
                            onLoad={(e) => { if (!file.metadata?.width) { const img = e.currentTarget; if (img.naturalWidth > 0) healMetadata(file.id, img.naturalWidth, img.naturalHeight, file.metadata); } }}
                          />
                        )}

                        {/* Selection indicator */}
                        <div
                          className={cn(
                            "absolute top-1 end-1 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors",
                            isSelected
                              ? "bg-primary border-primary text-primary-foreground"
                              : "bg-background/80 border-muted-foreground/50"
                          )}
                        >
                          {isSelected && <Check className="w-3 h-3" />}
                        </div>

                        {/* Type & ratio badges */}
                        <div className="absolute bottom-1 start-1 flex gap-0.5">
                          <Badge variant="secondary" className="text-[10px] px-1 py-0">
                            {file.file_type === "video" ? t("mediaLibrary.badgeVideo", "Video") : t("mediaLibrary.badgeImage", "Image")}
                          </Badge>
                          {(() => { const label = getAspectRatioLabel(file.metadata?.width as number, file.metadata?.height as number); return label ? <Badge variant="secondary" className="text-[10px] px-1 py-0">{label}</Badge> : null; })()}
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                /* List view */
                <div className="space-y-2">
                  {filteredFiles.map((file) => {
                    const isSelected = selectedIds.has(file.id);
                    const isDisabled = !isSelected && selectedIds.size >= remainingSlots;
                    const fileName = file.file_path.split("/").pop() || "file";

                    return (
                      <button
                        key={file.id}
                        onClick={() => !isDisabled && toggleSelection(file.id)}
                        disabled={isDisabled}
                        className={cn(
                          "w-full flex items-center gap-3 p-2 rounded-lg border transition-all text-start",
                          isSelected
                            ? "border-primary bg-primary/5"
                            : "border-border hover:border-primary/50",
                          isDisabled && "opacity-50 cursor-not-allowed"
                        )}
                      >
                        {/* Thumbnail */}
                        <div className="w-12 h-12 rounded overflow-hidden flex-shrink-0 bg-muted">
                          {file.file_type === "video" ? (
                            <video
                              src={resolvePublicUrl(file)}
                              className="w-full h-full object-cover"
                              muted
                              preload="metadata"
                              onLoadedMetadata={(e) => { if (!file.metadata?.width) { const vid = e.currentTarget; if (vid.videoWidth > 0) healMetadata(file.id, vid.videoWidth, vid.videoHeight, file.metadata); } }}
                            />
                          ) : (
                            <img
                              src={resolvePublicUrl(file)}
                              alt=""
                              className="w-full h-full object-cover"
                              loading="lazy"
                              onLoad={(e) => { if (!file.metadata?.width) { const img = e.currentTarget; if (img.naturalWidth > 0) healMetadata(file.id, img.naturalWidth, img.naturalHeight, file.metadata); } }}
                            />
                          )}
                        </div>

                        {/* File info */}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{fileName}</p>
                          <p className="text-xs text-muted-foreground flex items-center gap-1">
                            {file.file_type} • {file.created_at && format(new Date(file.created_at), "MMM d, yyyy")}
                            {(() => { const label = getAspectRatioLabel(file.metadata?.width as number, file.metadata?.height as number); return label ? <Badge variant="secondary" className="text-[10px] px-1 py-0 ms-1">{label}</Badge> : null; })()}
                          </p>
                        </div>

                        {/* Selection indicator */}
                        <div
                          className={cn(
                            "w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0",
                            isSelected
                              ? "bg-primary border-primary text-primary-foreground"
                              : "border-muted-foreground/50"
                          )}
                        >
                          {isSelected && <Check className="w-3 h-3" />}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </ScrollArea>

        {/* Footer */}
        <DialogFooter className="border-t pt-4">
          <div className="flex items-center gap-2 me-auto">
            <Badge variant="outline">
              {t("mediaLibrary.selectedCount", "{{count}} selected", { count: selectedIds.size })}
            </Badge>
            {remainingSlots < 10 && (
              <span className="text-xs text-muted-foreground">
                {t("mediaLibrary.slotsRemaining", "({{count}} slots remaining)", { count: remainingSlots })}
              </span>
            )}
          </div>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common:cancel", "Cancel")}
          </Button>
          <Button onClick={handleConfirm} disabled={selectedIds.size === 0}>
            {selectedIds.size > 0
              ? t("mediaLibrary.addCountFiles", "Add {{count}} Files", { count: selectedIds.size })
              : t("mediaLibrary.addFiles", "Add Files")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
