import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Search, Film, Video, Image, Clapperboard, Sparkles, Play, Camera, Layers } from "lucide-react";
import { useDebounce } from "@/hooks/shared/useDebounce";
import { Badge } from "@/components/ui/badge";
import { Icon3D, GradientHeading } from "@/components/fx";
import { cn } from "@/lib/utils";

// KLIPY imports
import { 
  fetchTrendingGifs, 
  searchGifs, 
  getThumbnailUrl, 
  getEmbedUrl, 
  KlipyGif,
  fetchTrendingClips,
  searchClips,
  getClipThumbnailUrl,
  getClipEmbedUrl,
  KlipyClip,
  fetchGifsByCategory as fetchKlipyGifsByCategory,
  fetchClipsByCategory as fetchKlipyClipsByCategory,
  KLIPY_CATEGORIES,
} from "@/lib/klipyApi";

// Pexels imports
import {
  fetchCuratedPhotos,
  searchPhotos as searchPexelsPhotos,
  fetchPopularVideos as fetchPexelsVideos,
  searchVideos as searchPexelsVideos,
  getPhotoThumbnail as getPexelsPhotoThumbnail,
  getPhotoFullSize as getPexelsPhotoFullSize,
  getVideoThumbnail as getPexelsVideoThumbnail,
  getVideoUrl as getPexelsVideoUrl,
  PexelsPhoto,
  PexelsVideo,
  PexelsOrientation,
} from "@/lib/pexelsApi";

// Pixabay imports
import {
  fetchPopularPhotos as fetchPixabayPhotos,
  searchPhotos as searchPixabayPhotos,
  fetchPopularVideos as fetchPixabayVideos,
  searchVideos as searchPixabayVideos,
  fetchPopularGifs as fetchPixabayGifs,
  searchGifs as searchPixabayGifs,
  getPhotoThumbnail as getPixabayPhotoThumbnail,
  getPhotoFullSize as getPixabayPhotoFullSize,
  getVideoThumbnail as getPixabayVideoThumbnail,
  getVideoUrl as getPixabayVideoUrl,
  PixabayPhoto,
  PixabayVideo,
  PixabayOrientation,
} from "@/lib/pixabayApi";

// Giphy imports
import {
  fetchTrendingGifs as fetchGiphyTrendingGifs,
  searchGifs as searchGiphyGifs,
  fetchTrendingStickers as fetchGiphyTrendingStickers,
  searchStickers as searchGiphyStickers,
  fetchTrendingClips as fetchGiphyTrendingClips,
  searchClips as searchGiphyClips,
  fetchGifsByCategory as fetchGiphyGifsByCategory,
  fetchClipsByCategory as fetchGiphyClipsByCategory,
  getThumbnailUrl as getGiphyThumbnailUrl,
  getFullUrl as getGiphyFullUrl,
  getClipVideoUrl as getGiphyClipVideoUrl,
  getClipThumbnailUrl as getGiphyClipThumbnailUrl,
  GiphyGif,
  GIPHY_POPULAR_CATEGORIES,
} from "@/lib/giphyApi";

// Unsplash imports
import {
  fetchEditorialPhotos as fetchUnsplashPhotos,
  searchPhotos as searchUnsplashPhotos,
  getPhotoThumbnail as getUnsplashPhotoThumbnail,
  getPhotoFullSize as getUnsplashPhotoFullSize,
  getPhotographerUrl as getUnsplashPhotographerUrl,
  getUnsplashUrl,
  trackDownload as trackUnsplashDownload,
  UnsplashPhoto,
  UnsplashOrientation,
  UNSPLASH_ORIENTATIONS,
} from "@/lib/unsplashApi";

// ============ Types ============

// Extended tabs to include combined sources
type MainTab = "all-photos" | "all-videos" | "all-gifs" | "klipy" | "pexels" | "pixabay" | "giphy" | "unsplash";
type KlipySubTab = "gifs" | "clips";
type PexelsSubTab = "photos" | "videos";
type PixabaySubTab = "photos" | "videos" | "gifs";
type GiphySubTab = "gifs" | "stickers" | "clips";

export type MediaType = "image" | "video" | "gif";

export interface SelectedMedia {
  url: string;
  thumbnailUrl: string;
  type: MediaType;
  source: "klipy" | "pexels" | "pixabay" | "giphy" | "unsplash";
  attribution?: string;
  /** Unsplash only: photographer name */
  photographerName?: string;
  /** Unsplash only: photographer profile URL with UTM */
  photographerUrl?: string;
  /** Unsplash only: Unsplash URL with UTM */
  unsplashUrl?: string;
}

interface StockMediaPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (media: SelectedMedia) => void;
  /** If true, only shows Pexels and Pixabay with Photos only (no KLIPY, no videos) */
  photosOnly?: boolean;
}

// Combined photo item for multi-source display
interface CombinedPhotoItem {
  id: string;
  source: "unsplash" | "pexels" | "pixabay";
  thumbnailUrl: string;
  attribution: string;
  originalData: UnsplashPhoto | PexelsPhoto | PixabayPhoto;
}

// Combined video item for multi-source display
interface CombinedVideoItem {
  id: string;
  source: "pexels" | "pixabay";
  thumbnailUrl: string;
  attribution: string;
  duration?: number;
  originalData: PexelsVideo | PixabayVideo;
}

// Combined GIF item for multi-source display
interface CombinedGifItem {
  id: string;
  source: "klipy" | "giphy" | "pixabay";
  thumbnailUrl: string;
  title?: string;
  originalData: KlipyGif | GiphyGif | PixabayPhoto;
}

// Unified orientation filter for combined tabs
type CombinedOrientation = "all" | "landscape" | "portrait" | "square";

const COMBINED_ORIENTATIONS: { value: CombinedOrientation; label: string }[] = [
  { value: "all", label: "All" },
  { value: "landscape", label: "Landscape" },
  { value: "portrait", label: "Portrait" },
  { value: "square", label: "Square" },
];

// Orientation filter options
const PEXELS_ORIENTATIONS: { value: PexelsOrientation; label: string }[] = [
  { value: "all", label: "All" },
  { value: "landscape", label: "Landscape" },
  { value: "portrait", label: "Portrait" },
  { value: "square", label: "Square" },
];

const PIXABAY_ORIENTATIONS: { value: PixabayOrientation; label: string }[] = [
  { value: "all", label: "All" },
  { value: "horizontal", label: "Landscape" },
  { value: "vertical", label: "Portrait" },
];

const PER_PAGE = 24;

// ============ Component ============

export function StockMediaPicker({ open, onOpenChange, onSelect, photosOnly = false }: StockMediaPickerProps) {
  const { t } = useTranslation("postmedia");

  const getOrientationLabel = (value: string, label: string) => {
    switch (value) {
      case "all": return t("stockMedia.orientationAll", label);
      case "landscape":
      case "horizontal": return t("stockMedia.orientationLandscape", label);
      case "portrait":
      case "vertical": return t("stockMedia.orientationPortrait", label);
      case "square": return t("stockMedia.orientationSquare", label);
      default: return label;
    }
  };

  // Main tabs state - default to combined tabs
  const [mainTab, setMainTab] = useState<MainTab>(photosOnly ? "all-photos" : "all-gifs");
  const [klipySubTab, setKlipySubTab] = useState<KlipySubTab>("gifs");
  const [pexelsSubTab, setPexelsSubTab] = useState<PexelsSubTab>("photos");
  const [pixabaySubTab, setPixabaySubTab] = useState<PixabaySubTab>("photos");
  const [giphySubTab, setGiphySubTab] = useState<GiphySubTab>("gifs");

  // Orientation filters
  const [pexelsOrientation, setPexelsOrientation] = useState<PexelsOrientation>("all");
  const [pixabayOrientation, setPixabayOrientation] = useState<PixabayOrientation>("all");
  const [unsplashOrientation, setUnsplashOrientation] = useState<UnsplashOrientation>("all");
  const [combinedPhotoOrientation, setCombinedPhotoOrientation] = useState<CombinedOrientation>("all");
  const [combinedVideoOrientation, setCombinedVideoOrientation] = useState<CombinedOrientation>("all");

  // Category filters
  const [klipyCategory, setKlipyCategory] = useState<string>("all");
  const [giphyCategory, setGiphyCategory] = useState<string>("all");

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const debouncedQuery = useDebounce(searchQuery, 400);

  // Loading and error states
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pagination state
  const [pages, setPages] = useState<Record<string, number>>({});
  const [hasMore, setHasMore] = useState<Record<string, boolean>>({});

  // KLIPY data
  const [gifs, setGifs] = useState<KlipyGif[]>([]);
  const [clips, setClips] = useState<KlipyClip[]>([]);

  // Pexels data
  const [pexelsPhotos, setPexelsPhotos] = useState<PexelsPhoto[]>([]);
  const [pexelsVideos, setPexelsVideos] = useState<PexelsVideo[]>([]);

  // Pixabay data
  const [pixabayPhotos, setPixabayPhotos] = useState<PixabayPhoto[]>([]);
  const [pixabayVideos, setPixabayVideos] = useState<PixabayVideo[]>([]);
  const [pixabayGifsData, setPixabayGifsData] = useState<PixabayPhoto[]>([]);

  // Giphy data
  const [giphyGifs, setGiphyGifs] = useState<GiphyGif[]>([]);
  const [giphyStickers, setGiphyStickers] = useState<GiphyGif[]>([]);
  const [giphyClips, setGiphyClips] = useState<GiphyGif[]>([]);

  // Unsplash data
  const [unsplashPhotos, setUnsplashPhotos] = useState<UnsplashPhoto[]>([]);

  // Combined data for multi-source tabs
  const [combinedPhotos, setCombinedPhotos] = useState<CombinedPhotoItem[]>([]);
  const [combinedVideos, setCombinedVideos] = useState<CombinedVideoItem[]>([]);
  const [combinedGifs, setCombinedGifs] = useState<CombinedGifItem[]>([]);

  // Scroll area ref for infinite scroll
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  // Get current key for pagination tracking
  const getCurrentKey = useCallback(() => {
    if (mainTab === "all-photos") return `all-photos-${combinedPhotoOrientation}`;
    if (mainTab === "all-videos") return `all-videos-${combinedVideoOrientation}`;
    if (mainTab === "all-gifs") return "all-gifs";
    if (mainTab === "klipy") return `klipy-${klipySubTab}`;
    if (mainTab === "pexels") return `pexels-${pexelsSubTab}`;
    if (mainTab === "pixabay") return `pixabay-${pixabaySubTab}`;
    if (mainTab === "giphy") return `giphy-${giphySubTab}`;
    if (mainTab === "unsplash") return "unsplash";
    return "unknown";
  }, [mainTab, klipySubTab, pexelsSubTab, pixabaySubTab, giphySubTab, combinedPhotoOrientation, combinedVideoOrientation]);

  // ============ Individual Fetch Functions ============

  const fetchKlipyGifs = useCallback(async (query: string, category: string, page: number, append: boolean) => {
    try {
      let results: KlipyGif[];
      if (query.trim()) {
        results = await searchGifs(query, page, PER_PAGE);
      } else if (category && category !== "all") {
        results = await fetchKlipyGifsByCategory(category, page, PER_PAGE);
      } else {
        results = await fetchTrendingGifs(page, PER_PAGE);
      }
      const data = Array.isArray(results) ? results : [];
      setGifs(prev => append ? [...prev, ...data] : data);
      setHasMore(prev => ({ ...prev, "klipy-gifs": data.length >= PER_PAGE }));
      return data;
    } catch (err) {
      console.error("Failed to fetch KLIPY GIFs:", err);
      if (!append) setGifs([]);
      return [];
    }
  }, []);

  const fetchKlipyClips = useCallback(async (query: string, category: string, page: number, append: boolean) => {
    try {
      let results: KlipyClip[];
      if (query.trim()) {
        results = await searchClips(query, page, PER_PAGE);
      } else if (category && category !== "all") {
        results = await fetchKlipyClipsByCategory(category, page, PER_PAGE);
      } else {
        results = await fetchTrendingClips(page, PER_PAGE);
      }
      const data = Array.isArray(results) ? results : [];
      setClips(prev => append ? [...prev, ...data] : data);
      setHasMore(prev => ({ ...prev, "klipy-clips": data.length >= PER_PAGE }));
      return data;
    } catch (err) {
      console.error("Failed to fetch KLIPY Clips:", err);
      if (!append) setClips([]);
      return [];
    }
  }, []);

  const fetchPexelsPhotosData = useCallback(async (query: string, orientation: PexelsOrientation, page: number, append: boolean) => {
    try {
      const results = query.trim() 
        ? await searchPexelsPhotos(query, page, PER_PAGE, orientation) 
        : await fetchCuratedPhotos(page, PER_PAGE, orientation);
      setPexelsPhotos(prev => append ? [...prev, ...results] : results);
      setHasMore(prev => ({ ...prev, "pexels-photos": results.length >= PER_PAGE }));
      return results;
    } catch (err) {
      console.error("Failed to fetch Pexels photos:", err);
      if (!append) setPexelsPhotos([]);
      return [];
    }
  }, []);

  const fetchPexelsVideosData = useCallback(async (query: string, orientation: PexelsOrientation, page: number, append: boolean) => {
    try {
      const results = query.trim() 
        ? await searchPexelsVideos(query, page, PER_PAGE, orientation) 
        : await fetchPexelsVideos(page, PER_PAGE, orientation);
      setPexelsVideos(prev => append ? [...prev, ...results] : results);
      setHasMore(prev => ({ ...prev, "pexels-videos": results.length >= PER_PAGE }));
      return results;
    } catch (err) {
      console.error("Failed to fetch Pexels videos:", err);
      if (!append) setPexelsVideos([]);
      return [];
    }
  }, []);

  const fetchPixabayPhotosData = useCallback(async (query: string, orientation: PixabayOrientation, page: number, append: boolean) => {
    try {
      const results = query.trim() 
        ? await searchPixabayPhotos(query, page, PER_PAGE, orientation) 
        : await fetchPixabayPhotos(page, PER_PAGE, orientation);
      setPixabayPhotos(prev => append ? [...prev, ...results] : results);
      setHasMore(prev => ({ ...prev, "pixabay-photos": results.length >= PER_PAGE }));
      return results;
    } catch (err) {
      console.error("Failed to fetch Pixabay photos:", err);
      if (!append) setPixabayPhotos([]);
      return [];
    }
  }, []);

  const fetchPixabayVideosData = useCallback(async (query: string, orientation: PixabayOrientation, page: number, append: boolean) => {
    try {
      const results = query.trim() 
        ? await searchPixabayVideos(query, page, PER_PAGE, orientation) 
        : await fetchPixabayVideos(page, PER_PAGE, orientation);
      setPixabayVideos(prev => append ? [...prev, ...results] : results);
      setHasMore(prev => ({ ...prev, "pixabay-videos": results.length >= PER_PAGE }));
      return results;
    } catch (err) {
      console.error("Failed to fetch Pixabay videos:", err);
      if (!append) setPixabayVideos([]);
      return [];
    }
  }, []);

  const fetchPixabayGifsData = useCallback(async (query: string, orientation: PixabayOrientation, page: number, append: boolean) => {
    try {
      const results = query.trim() 
        ? await searchPixabayGifs(query, page, PER_PAGE, orientation) 
        : await fetchPixabayGifs(page, PER_PAGE, orientation);
      setPixabayGifsData(prev => append ? [...prev, ...results] : results);
      setHasMore(prev => ({ ...prev, "pixabay-gifs": results.length >= PER_PAGE }));
      return results;
    } catch (err) {
      console.error("Failed to fetch Pixabay GIFs:", err);
      if (!append) setPixabayGifsData([]);
      return [];
    }
  }, []);

  // Giphy fetch functions
  const fetchGiphyGifsData = useCallback(async (query: string, category: string, page: number, append: boolean) => {
    try {
      let results: GiphyGif[];
      if (query.trim()) {
        results = await searchGiphyGifs(query, page, PER_PAGE);
      } else if (category) {
        results = await fetchGiphyGifsByCategory(category, page, PER_PAGE);
      } else {
        results = await fetchGiphyTrendingGifs(page, PER_PAGE);
      }
      setGiphyGifs(prev => append ? [...prev, ...results] : results);
      setHasMore(prev => ({ ...prev, "giphy-gifs": results.length >= PER_PAGE }));
      return results;
    } catch (err) {
      console.error("Failed to fetch Giphy GIFs:", err);
      if (!append) setGiphyGifs([]);
      return [];
    }
  }, []);

  const fetchGiphyStickersData = useCallback(async (query: string, page: number, append: boolean) => {
    try {
      const results = query.trim() 
        ? await searchGiphyStickers(query, page, PER_PAGE) 
        : await fetchGiphyTrendingStickers(page, PER_PAGE);
      setGiphyStickers(prev => append ? [...prev, ...results] : results);
      setHasMore(prev => ({ ...prev, "giphy-stickers": results.length >= PER_PAGE }));
      return results;
    } catch (err) {
      console.error("Failed to fetch Giphy Stickers:", err);
      if (!append) setGiphyStickers([]);
      return [];
    }
  }, []);

  const fetchGiphyClipsData = useCallback(async (query: string, category: string, page: number, append: boolean) => {
    try {
      let results: GiphyGif[];
      if (query.trim()) {
        results = await searchGiphyClips(query, page, PER_PAGE);
      } else if (category) {
        results = await fetchGiphyClipsByCategory(category, page, PER_PAGE);
      } else {
        results = await fetchGiphyTrendingClips(page, PER_PAGE);
      }
      setGiphyClips(prev => append ? [...prev, ...results] : results);
      setHasMore(prev => ({ ...prev, "giphy-clips": results.length >= PER_PAGE }));
      return results;
    } catch (err) {
      console.error("Failed to fetch Giphy Clips:", err);
      if (!append) setGiphyClips([]);
      return [];
    }
  }, []);

  // Unsplash fetch function
  const fetchUnsplashPhotosData = useCallback(async (query: string, orientation: UnsplashOrientation, page: number, append: boolean) => {
    try {
      const results = query.trim()
        ? await searchUnsplashPhotos(query, page, PER_PAGE, orientation)
        : await fetchUnsplashPhotos(page, PER_PAGE);
      setUnsplashPhotos(prev => append ? [...prev, ...results] : results);
      setHasMore(prev => ({ ...prev, "unsplash": results.length >= PER_PAGE }));
      return results;
    } catch (err) {
      console.error("Failed to fetch Unsplash photos:", err);
      if (!append) setUnsplashPhotos([]);
      return [];
    }
  }, []);

  // ============ Combined Multi-Source Fetch Functions ============

  // Helper to convert combined orientation to API-specific orientation
  const toPexelsOrientation = (o: CombinedOrientation): PexelsOrientation => o;
  const toPixabayOrientation = (o: CombinedOrientation): PixabayOrientation => {
    if (o === "landscape") return "horizontal";
    if (o === "portrait") return "vertical";
    return "all"; // square not directly supported, will filter client-side
  };
  const toUnsplashOrientation = (o: CombinedOrientation): UnsplashOrientation => {
    if (o === "square") return "squarish";
    return o as UnsplashOrientation;
  };

  // Client-side filtering for accurate aspect ratio matching
  const filterPhotosByOrientation = (
    items: PixabayPhoto[],
    orientation: CombinedOrientation
  ): PixabayPhoto[] => {
    if (orientation === "all") return items;
    const TOLERANCE = 0.15;
    return items.filter(item => {
      const ratio = item.imageWidth / item.imageHeight;
      if (orientation === "square") {
        return ratio >= 1 - TOLERANCE && ratio <= 1 + TOLERANCE;
      }
      if (orientation === "landscape") {
        return ratio > 1 + TOLERANCE;
      }
      if (orientation === "portrait") {
        return ratio < 1 - TOLERANCE;
      }
      return true;
    });
  };

  const filterVideosByOrientation = (
    items: PixabayVideo[],
    orientation: CombinedOrientation
  ): PixabayVideo[] => {
    if (orientation === "all") return items;
    const TOLERANCE = 0.15;
    return items.filter(item => {
      const videoSize = item.videos.medium || item.videos.small || item.videos.tiny;
      const ratio = videoSize.width / videoSize.height;
      if (orientation === "square") {
        return ratio >= 1 - TOLERANCE && ratio <= 1 + TOLERANCE;
      }
      if (orientation === "landscape") {
        return ratio > 1 + TOLERANCE;
      }
      if (orientation === "portrait") {
        return ratio < 1 - TOLERANCE;
      }
      return true;
    });
  };

  const filterPexelsPhotosByOrientation = (
    items: PexelsPhoto[],
    orientation: CombinedOrientation
  ): PexelsPhoto[] => {
    if (orientation === "all") return items;
    const TOLERANCE = 0.15;
    return items.filter(item => {
      const ratio = item.width / item.height;
      if (orientation === "square") {
        return ratio >= 1 - TOLERANCE && ratio <= 1 + TOLERANCE;
      }
      if (orientation === "landscape") {
        return ratio > 1 + TOLERANCE;
      }
      if (orientation === "portrait") {
        return ratio < 1 - TOLERANCE;
      }
      return true;
    });
  };

  const filterPexelsVideosByOrientation = (
    items: PexelsVideo[],
    orientation: CombinedOrientation
  ): PexelsVideo[] => {
    if (orientation === "all") return items;
    const TOLERANCE = 0.15;
    return items.filter(item => {
      const ratio = item.width / item.height;
      if (orientation === "square") {
        return ratio >= 1 - TOLERANCE && ratio <= 1 + TOLERANCE;
      }
      if (orientation === "landscape") {
        return ratio > 1 + TOLERANCE;
      }
      if (orientation === "portrait") {
        return ratio < 1 - TOLERANCE;
      }
      return true;
    });
  };

  const filterUnsplashPhotosByOrientation = (
    items: UnsplashPhoto[],
    orientation: CombinedOrientation
  ): UnsplashPhoto[] => {
    if (orientation === "all") return items;
    const TOLERANCE = 0.15;
    return items.filter(item => {
      const ratio = item.width / item.height;
      if (orientation === "square") {
        return ratio >= 1 - TOLERANCE && ratio <= 1 + TOLERANCE;
      }
      if (orientation === "landscape") {
        return ratio > 1 + TOLERANCE;
      }
      if (orientation === "portrait") {
        return ratio < 1 - TOLERANCE;
      }
      return true;
    });
  };

  const fetchAllPhotos = useCallback(async (query: string, orientation: CombinedOrientation, page: number, append: boolean) => {
    if (page === 1) setLoading(true);
    else setLoadingMore(true);
    setError(null);

    console.log(`Fetching all photos with orientation: ${orientation}`);

    try {
      // Fetch from all three sources in parallel with orientation filter
      const [unsplashResults, pexelsResults, pixabayResults] = await Promise.allSettled([
        query.trim()
          ? searchUnsplashPhotos(query, page, Math.ceil(PER_PAGE / 3), toUnsplashOrientation(orientation))
          : fetchUnsplashPhotos(page, Math.ceil(PER_PAGE / 3)),
        query.trim()
          ? searchPexelsPhotos(query, page, Math.ceil(PER_PAGE / 3), toPexelsOrientation(orientation))
          : fetchCuratedPhotos(page, Math.ceil(PER_PAGE / 3), toPexelsOrientation(orientation)),
        query.trim()
          ? searchPixabayPhotos(query, page, Math.ceil(PER_PAGE / 3), toPixabayOrientation(orientation))
          : fetchPixabayPhotos(page, Math.ceil(PER_PAGE / 3), toPixabayOrientation(orientation)),
      ]);

      const combined: CombinedPhotoItem[] = [];

      // Process Unsplash results with client-side filtering for accuracy
      if (unsplashResults.status === "fulfilled") {
        const filtered = filterUnsplashPhotosByOrientation(unsplashResults.value, orientation);
        filtered.forEach(photo => {
          combined.push({
            id: `unsplash-${photo.id}`,
            source: "unsplash",
            thumbnailUrl: getUnsplashPhotoThumbnail(photo),
            attribution: photo.user.name,
            originalData: photo,
          });
        });
      }

      // Process Pexels results with client-side filtering
      if (pexelsResults.status === "fulfilled") {
        const filtered = filterPexelsPhotosByOrientation(pexelsResults.value, orientation);
        filtered.forEach(photo => {
          combined.push({
            id: `pexels-${photo.id}`,
            source: "pexels",
            thumbnailUrl: getPexelsPhotoThumbnail(photo),
            attribution: photo.photographer,
            originalData: photo,
          });
        });
      }

      // Process Pixabay results with client-side filtering
      if (pixabayResults.status === "fulfilled") {
        const filtered = filterPhotosByOrientation(pixabayResults.value, orientation);
        filtered.forEach(photo => {
          combined.push({
            id: `pixabay-${photo.id}`,
            source: "pixabay",
            thumbnailUrl: getPixabayPhotoThumbnail(photo),
            attribution: photo.user,
            originalData: photo,
          });
        });
      }

      // Shuffle results to mix sources
      const shuffled = combined.sort(() => Math.random() - 0.5);

      setCombinedPhotos(prev => append ? [...prev, ...shuffled] : shuffled);
      setHasMore(prev => ({ ...prev, [`all-photos-${orientation}`]: combined.length >= PER_PAGE / 3 }));
    } catch (err) {
      console.error("Failed to fetch combined photos:", err);
      setError(t("stockMedia.failedPhotos", "Failed to load photos"));
      if (!append) setCombinedPhotos([]);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [t]);

  const fetchAllVideos = useCallback(async (query: string, orientation: CombinedOrientation, page: number, append: boolean) => {
    if (page === 1) setLoading(true);
    else setLoadingMore(true);
    setError(null);

    console.log(`Fetching all videos with orientation: ${orientation}`);

    try {
      // Fetch from Pexels and Pixabay in parallel with orientation filter
      const [pexelsResults, pixabayResults] = await Promise.allSettled([
        query.trim()
          ? searchPexelsVideos(query, page, Math.ceil(PER_PAGE / 2), toPexelsOrientation(orientation))
          : fetchPexelsVideos(page, Math.ceil(PER_PAGE / 2), toPexelsOrientation(orientation)),
        query.trim()
          ? searchPixabayVideos(query, page, Math.ceil(PER_PAGE / 2), toPixabayOrientation(orientation))
          : fetchPixabayVideos(page, Math.ceil(PER_PAGE / 2), toPixabayOrientation(orientation)),
      ]);

      const combined: CombinedVideoItem[] = [];

      // Process Pexels videos with client-side filtering
      if (pexelsResults.status === "fulfilled") {
        const filtered = filterPexelsVideosByOrientation(pexelsResults.value, orientation);
        filtered.forEach(video => {
          combined.push({
            id: `pexels-${video.id}`,
            source: "pexels",
            thumbnailUrl: getPexelsVideoThumbnail(video),
            attribution: video.user.name,
            duration: video.duration,
            originalData: video,
          });
        });
      }

      // Process Pixabay videos with client-side filtering
      if (pixabayResults.status === "fulfilled") {
        const filtered = filterVideosByOrientation(pixabayResults.value, orientation);
        filtered.forEach(video => {
          combined.push({
            id: `pixabay-${video.id}`,
            source: "pixabay",
            thumbnailUrl: getPixabayVideoThumbnail(video),
            attribution: video.user,
            duration: video.duration,
            originalData: video,
          });
        });
      }

      // Shuffle results to mix sources
      const shuffled = combined.sort(() => Math.random() - 0.5);

      setCombinedVideos(prev => append ? [...prev, ...shuffled] : shuffled);
      setHasMore(prev => ({ ...prev, [`all-videos-${orientation}`]: combined.length >= PER_PAGE / 3 }));
    } catch (err) {
      console.error("Failed to fetch combined videos:", err);
      setError(t("stockMedia.failedVideos", "Failed to load videos"));
      if (!append) setCombinedVideos([]);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [t]);

  const fetchAllGifs = useCallback(async (query: string, page: number, append: boolean) => {
    if (page === 1) setLoading(true);
    else setLoadingMore(true);
    setError(null);

    try {
      // Fetch from KLIPY, GIPHY, and Pixabay in parallel
      const [klipyResults, giphyResults, pixabayResults] = await Promise.allSettled([
        query.trim()
          ? searchGifs(query, page, Math.ceil(PER_PAGE / 3))
          : fetchTrendingGifs(page, Math.ceil(PER_PAGE / 3)),
        query.trim()
          ? searchGiphyGifs(query, page, Math.ceil(PER_PAGE / 3))
          : fetchGiphyTrendingGifs(page, Math.ceil(PER_PAGE / 3)),
        query.trim()
          ? searchPixabayGifs(query, page, Math.ceil(PER_PAGE / 3))
          : fetchPixabayGifs(page, Math.ceil(PER_PAGE / 3)),
      ]);

      const combined: CombinedGifItem[] = [];

      // Process KLIPY results
      if (klipyResults.status === "fulfilled") {
        const klipyData = Array.isArray(klipyResults.value) ? klipyResults.value : [];
        klipyData.forEach((gif, idx) => {
          const thumb = getThumbnailUrl(gif);
          if (thumb) {
            combined.push({
              id: `klipy-${gif.id || gif.slug || idx}`,
              source: "klipy",
              thumbnailUrl: thumb,
              title: gif.title,
              originalData: gif,
            });
          }
        });
      }

      // Process GIPHY results
      if (giphyResults.status === "fulfilled") {
        giphyResults.value.forEach(gif => {
          const thumb = getGiphyThumbnailUrl(gif);
          if (thumb) {
            combined.push({
              id: `giphy-${gif.id}`,
              source: "giphy",
              thumbnailUrl: thumb,
              title: gif.title,
              originalData: gif,
            });
          }
        });
      }

      // Process Pixabay GIF results
      if (pixabayResults.status === "fulfilled") {
        pixabayResults.value.forEach(gif => {
          combined.push({
            id: `pixabay-${gif.id}`,
            source: "pixabay",
            thumbnailUrl: getPixabayPhotoThumbnail(gif),
            title: gif.tags,
            originalData: gif,
          });
        });
      }

      // Shuffle results to mix sources
      const shuffled = combined.sort(() => Math.random() - 0.5);

      setCombinedGifs(prev => append ? [...prev, ...shuffled] : shuffled);
      setHasMore(prev => ({ ...prev, "all-gifs": combined.length >= PER_PAGE / 3 }));
    } catch (err) {
      console.error("Failed to fetch combined GIFs:", err);
      setError(t("stockMedia.failedGifs", "Failed to load GIFs"));
      if (!append) setCombinedGifs([]);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [t]);

  // ============ Data Fetching Logic ============

  const fetchData = useCallback((query: string, page: number, append: boolean) => {
    // Combined sources
    if (mainTab === "all-photos") {
      fetchAllPhotos(query, combinedPhotoOrientation, page, append);
      return;
    }
    if (mainTab === "all-videos") {
      fetchAllVideos(query, combinedVideoOrientation, page, append);
      return;
    }
    if (mainTab === "all-gifs") {
      fetchAllGifs(query, page, append);
      return;
    }

    // Single source fetching with loading state management
    if (page === 1) setLoading(true);
    else setLoadingMore(true);
    setError(null);

    const handleComplete = () => {
      setLoading(false);
      setLoadingMore(false);
    };

    if (mainTab === "klipy") {
      if (klipySubTab === "gifs") {
        fetchKlipyGifs(query, klipyCategory, page, append).finally(handleComplete);
      } else {
        fetchKlipyClips(query, klipyCategory, page, append).finally(handleComplete);
      }
    } else if (mainTab === "pexels") {
      if (pexelsSubTab === "photos") {
        fetchPexelsPhotosData(query, pexelsOrientation, page, append).finally(handleComplete);
      } else {
        fetchPexelsVideosData(query, pexelsOrientation, page, append).finally(handleComplete);
      }
    } else if (mainTab === "pixabay") {
      if (pixabaySubTab === "photos") {
        fetchPixabayPhotosData(query, pixabayOrientation, page, append).finally(handleComplete);
      } else if (pixabaySubTab === "videos") {
        fetchPixabayVideosData(query, pixabayOrientation, page, append).finally(handleComplete);
      } else if (pixabaySubTab === "gifs") {
        fetchPixabayGifsData(query, pixabayOrientation, page, append).finally(handleComplete);
      }
    } else if (mainTab === "giphy") {
      if (giphySubTab === "gifs") {
        fetchGiphyGifsData(query, giphyCategory, page, append).finally(handleComplete);
      } else if (giphySubTab === "stickers") {
        fetchGiphyStickersData(query, page, append).finally(handleComplete);
      } else if (giphySubTab === "clips") {
        fetchGiphyClipsData(query, giphyCategory, page, append).finally(handleComplete);
      }
    } else if (mainTab === "unsplash") {
      fetchUnsplashPhotosData(query, unsplashOrientation, page, append).finally(handleComplete);
    }
  }, [mainTab, klipySubTab, pexelsSubTab, pixabaySubTab, giphySubTab, pexelsOrientation, pixabayOrientation, unsplashOrientation, klipyCategory, giphyCategory, fetchKlipyGifs, fetchKlipyClips, fetchPexelsPhotosData, fetchPexelsVideosData, fetchPixabayPhotosData, fetchPixabayVideosData, fetchPixabayGifsData, fetchGiphyGifsData, fetchGiphyStickersData, fetchGiphyClipsData, fetchUnsplashPhotosData, fetchAllPhotos, fetchAllGifs]);

  // Reset pagination and fetch on tab/filter change
  const resetAndFetch = useCallback(() => {
    const key = getCurrentKey();
    setPages(prev => ({ ...prev, [key]: 1 }));
    fetchData(debouncedQuery, 1, false);
  }, [getCurrentKey, debouncedQuery, fetchData]);

  // Load data when dialog opens
  useEffect(() => {
    if (open) {
      setSearchQuery("");
      setPages({});
      setHasMore({});
      fetchData("", 1, false);
    }
  }, [open]);

  // Refetch when tabs or orientation/category change
  useEffect(() => {
    if (open) {
      resetAndFetch();
    }
  }, [mainTab, klipySubTab, pexelsSubTab, pixabaySubTab, giphySubTab, pexelsOrientation, pixabayOrientation, unsplashOrientation, klipyCategory, giphyCategory, combinedPhotoOrientation, combinedVideoOrientation]);

  // Search when debounced query changes
  useEffect(() => {
    if (open) {
      resetAndFetch();
    }
  }, [debouncedQuery]);

  // ============ Infinite Scroll ============

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement;
    const { scrollTop, scrollHeight, clientHeight } = target;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    
    const key = getCurrentKey();
    const currentPage = pages[key] || 1;
    const canLoadMore = hasMore[key] !== false;

    if (distanceFromBottom < 200 && canLoadMore && !loading && !loadingMore) {
      const nextPage = currentPage + 1;
      setPages(prev => ({ ...prev, [key]: nextPage }));
      fetchData(debouncedQuery, nextPage, true);
    }
  }, [getCurrentKey, pages, hasMore, loading, loadingMore, debouncedQuery, fetchData]);

  // ============ Selection Handlers ============

  const handleSelectCombinedPhoto = (item: CombinedPhotoItem) => {
    if (item.source === "unsplash") {
      handleSelectUnsplashPhoto(item.originalData as UnsplashPhoto);
    } else if (item.source === "pexels") {
      handleSelectPexelsPhoto(item.originalData as PexelsPhoto);
    } else if (item.source === "pixabay") {
      handleSelectPixabayPhoto(item.originalData as PixabayPhoto);
    }
  };

  const handleSelectCombinedGif = (item: CombinedGifItem) => {
    if (item.source === "klipy") {
      handleSelectKlipyGif(item.originalData as KlipyGif);
    } else if (item.source === "giphy") {
      handleSelectGiphyGif(item.originalData as GiphyGif);
    } else if (item.source === "pixabay") {
      handleSelectPixabayGif(item.originalData as PixabayPhoto);
    }
  };

  const handleSelectCombinedVideo = (item: CombinedVideoItem) => {
    if (item.source === "pexels") {
      handleSelectPexelsVideo(item.originalData as PexelsVideo);
    } else if (item.source === "pixabay") {
      handleSelectPixabayVideo(item.originalData as PixabayVideo);
    }
  };

  const handleSelectKlipyGif = (gif: KlipyGif) => {
    const gifUrl = getEmbedUrl(gif);
    const thumbnail = getThumbnailUrl(gif);
    if (gifUrl) {
      onSelect({
        url: gifUrl,
        thumbnailUrl: thumbnail || gifUrl,
        type: "gif",
        source: "klipy",
      });
      onOpenChange(false);
    }
  };

  const handleSelectKlipyClip = (clip: KlipyClip) => {
    const clipUrl = getClipEmbedUrl(clip);
    const thumbnail = getClipThumbnailUrl(clip);
    if (clipUrl) {
      onSelect({
        url: clipUrl,
        thumbnailUrl: thumbnail || clipUrl,
        type: "video",
        source: "klipy",
      });
      onOpenChange(false);
    }
  };

  const handleSelectPexelsPhoto = (photo: PexelsPhoto) => {
    onSelect({
      url: getPexelsPhotoFullSize(photo),
      thumbnailUrl: getPexelsPhotoThumbnail(photo),
      type: "image",
      source: "pexels",
      attribution: photo.photographer,
    });
    onOpenChange(false);
  };

  const handleSelectPexelsVideo = (video: PexelsVideo) => {
    onSelect({
      url: getPexelsVideoUrl(video),
      thumbnailUrl: getPexelsVideoThumbnail(video),
      type: "video",
      source: "pexels",
      attribution: video.user.name,
    });
    onOpenChange(false);
  };

  const handleSelectPixabayPhoto = (photo: PixabayPhoto) => {
    onSelect({
      url: getPixabayPhotoFullSize(photo),
      thumbnailUrl: getPixabayPhotoThumbnail(photo),
      type: "image",
      source: "pixabay",
      attribution: photo.user,
    });
    onOpenChange(false);
  };

  const handleSelectPixabayVideo = (video: PixabayVideo) => {
    onSelect({
      url: getPixabayVideoUrl(video),
      thumbnailUrl: getPixabayVideoThumbnail(video),
      type: "video",
      source: "pixabay",
      attribution: video.user,
    });
    onOpenChange(false);
  };

  const handleSelectPixabayGif = (gif: PixabayPhoto) => {
    onSelect({
      url: getPixabayPhotoFullSize(gif),
      thumbnailUrl: getPixabayPhotoThumbnail(gif),
      type: "gif",
      source: "pixabay",
      attribution: gif.user,
    });
    onOpenChange(false);
  };

  const handleSelectGiphyGif = (gif: GiphyGif) => {
    const gifUrl = getGiphyFullUrl(gif);
    const thumbnail = getGiphyThumbnailUrl(gif);
    if (gifUrl) {
      onSelect({
        url: gifUrl,
        thumbnailUrl: thumbnail || gifUrl,
        type: "gif",
        source: "giphy",
        attribution: gif.user?.display_name,
      });
      onOpenChange(false);
    }
  };

  const handleSelectGiphyClip = (clip: GiphyGif) => {
    const clipUrl = getGiphyClipVideoUrl(clip);
    const thumbnail = getGiphyClipThumbnailUrl(clip);
    if (clipUrl) {
      onSelect({
        url: clipUrl,
        thumbnailUrl: thumbnail || clipUrl,
        type: "video",
        source: "giphy",
        attribution: clip.user?.display_name,
      });
      onOpenChange(false);
    }
  };

  const handleSelectUnsplashPhoto = async (photo: UnsplashPhoto) => {
    // Track download as required by Unsplash API guidelines
    trackUnsplashDownload(photo);
    
    onSelect({
      url: getUnsplashPhotoFullSize(photo),
      thumbnailUrl: getUnsplashPhotoThumbnail(photo),
      type: "image",
      source: "unsplash",
      attribution: `Photo by ${photo.user.name} on Unsplash`,
      photographerName: photo.user.name,
      photographerUrl: getUnsplashPhotographerUrl(photo),
      unsplashUrl: getUnsplashUrl(),
    });
    onOpenChange(false);
  };

  // ============ Get Current Attribution ============

  const getAttribution = () => {
    switch (mainTab) {
      case "all-photos":
        return { name: "Unsplash, Pexels & Pixabay", url: "https://unsplash.com" };
      case "all-videos":
        return { name: "Pexels & Pixabay", url: "https://pexels.com" };
      case "all-gifs":
        return { name: "KLIPY, GIPHY & Pixabay", url: "https://klipy.co" };
      case "klipy":
        return { name: "KLIPY", url: "https://klipy.co" };
      case "pexels":
        return { name: "Pexels", url: "https://pexels.com" };
      case "pixabay":
        return { name: "Pixabay", url: "https://pixabay.com" };
      case "giphy":
        return { name: "GIPHY", url: "https://giphy.com" };
      case "unsplash":
        return { name: "Unsplash", url: "https://unsplash.com?utm_source=postora&utm_medium=referral" };
    }
  };

  // ============ Get Search Placeholder ============

  const getSearchPlaceholder = () => {
    if (mainTab === "all-photos") return t("stockMedia.searchAllPhotos", "Search all photos...");
    if (mainTab === "all-videos") return t("stockMedia.searchAllVideos", "Search all videos...");
    if (mainTab === "all-gifs") return t("stockMedia.searchAllGifs", "Search all GIFs...");
    if (mainTab === "klipy") {
      return klipySubTab === "gifs" ? t("stockMedia.searchGifs", "Search GIFs...") : t("stockMedia.searchClips", "Search Clips...");
    } else if (mainTab === "pexels") {
      return pexelsSubTab === "photos" ? t("stockMedia.searchPhotos", "Search photos...") : t("stockMedia.searchVideos", "Search videos...");
    } else if (mainTab === "pixabay") {
      if (pixabaySubTab === "photos") return t("stockMedia.searchPhotos", "Search photos...");
      if (pixabaySubTab === "videos") return t("stockMedia.searchVideos", "Search videos...");
      return t("stockMedia.searchGifs", "Search GIFs...");
    } else if (mainTab === "giphy") {
      if (giphySubTab === "gifs") return t("stockMedia.searchGifs", "Search GIFs...");
      if (giphySubTab === "stickers") return t("stockMedia.searchStickers", "Search Stickers...");
      return t("stockMedia.searchClips", "Search Clips...");
    } else if (mainTab === "unsplash") {
      return t("stockMedia.searchPhotos", "Search photos...");
    }
    return t("stockMedia.searchDefault", "Search...");
  };

  const attribution = getAttribution();

  // ============ Render Media Grid ============

  const renderLoadingMore = () => (
    loadingMore && (
      <div className="flex items-center justify-center py-4">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        <span className="ml-2 text-xs text-muted-foreground">{t("stockMedia.loadingMore", "Loading more...")}</span>
      </div>
    )
  );

  const renderLoading = () => (
    <div className="flex items-center justify-center py-12">
      <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
    </div>
  );

  const renderError = () => (
    <div className="flex items-center justify-center py-12 text-destructive text-sm">{error}</div>
  );

  const renderEmpty = (message: string) => (
    <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">{message}</div>
  );

  // Source badge component
  const SourceBadge = ({ source }: { source: string }) => (
    <Badge 
      variant="secondary" 
      className="absolute top-1 left-1 text-[8px] px-1 py-0 h-4 bg-black/50 text-white border-0 backdrop-blur-sm"
    >
      {source}
    </Badge>
  );

  // ============ Render ============

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col bg-card/80 backdrop-blur-xl border-border/50 shadow-2xl shadow-emerald-500/10">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3 group">
            <Icon3D icon={Image} variant="emerald" size="sm" />
            <GradientHeading as="h2" size="lg" preset="emerald-cyan-sky" className="!text-2xl md:!text-3xl">
              {photosOnly ? t("stockMedia.titlePhoto", "Add Stock Photo") : t("stockMedia.titleMedia", "Add Stock Media")}
            </GradientHeading>
          </DialogTitle>
        </DialogHeader>

          {/* Main Tabs */}
        <Tabs value={mainTab} onValueChange={(v) => setMainTab(v as MainTab)} className="w-full flex flex-col flex-1 min-h-0">
          <TabsList className={cn(
            "grid w-full mb-3 bg-card/50 backdrop-blur-md border border-border/40 rounded-xl p-1",
            "[&>[data-state=active]]:bg-gradient-to-r [&>[data-state=active]]:from-emerald-500 [&>[data-state=active]]:via-teal-500 [&>[data-state=active]]:to-cyan-500 [&>[data-state=active]]:text-white [&>[data-state=active]]:shadow-md [&>[data-state=active]]:shadow-emerald-500/30",
            photosOnly ? "grid-cols-4" : "grid-cols-8"
          )}>
            {/* Combined tabs */}
            <TabsTrigger value="all-photos" className="flex items-center gap-1.5 text-xs">
              <Layers className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t("stockMedia.allPhotosPrefix", "All")}</span> {t("stockMedia.photosTab", "Photos")}
            </TabsTrigger>
            {!photosOnly && (
              <>
                <TabsTrigger value="all-videos" className="flex items-center gap-1.5 text-xs">
                  <Layers className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">{t("stockMedia.allVideosPrefix", "All")}</span> {t("stockMedia.videosTab", "Videos")}
                </TabsTrigger>
                <TabsTrigger value="all-gifs" className="flex items-center gap-1.5 text-xs">
                  <Layers className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">{t("stockMedia.allGifsPrefix", "All")}</span> {t("stockMedia.gifsTab", "GIFs")}
                </TabsTrigger>
              </>
            )}
            
            {/* Individual source tabs */}
            <TabsTrigger value="unsplash" className="flex items-center gap-1.5 text-xs">
              <Camera className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Unsplash</span>
            </TabsTrigger>
            <TabsTrigger value="pexels" className="flex items-center gap-1.5 text-xs">
              <Image className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Pexels</span>
            </TabsTrigger>
            <TabsTrigger value="pixabay" className="flex items-center gap-1.5 text-xs">
              <Image className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Pixabay</span>
            </TabsTrigger>
            {!photosOnly && (
              <>
                <TabsTrigger value="klipy" className="flex items-center gap-1.5 text-xs">
                  <Clapperboard className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">KLIPY</span>
                </TabsTrigger>
                <TabsTrigger value="giphy" className="flex items-center gap-1.5 text-xs">
                  <Sparkles className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">GIPHY</span>
                </TabsTrigger>
              </>
            )}
          </TabsList>

          {/* All Photos Tab (Combined) */}
          <TabsContent value="all-photos" className="flex-1 flex flex-col min-h-0 mt-0">
            <div className="flex gap-2 mb-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input placeholder={getSearchPlaceholder()} value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-9" />
              </div>
              <Select value={combinedPhotoOrientation} onValueChange={(v) => setCombinedPhotoOrientation(v as CombinedOrientation)}>
                <SelectTrigger className="w-[130px]"><SelectValue placeholder={t("stockMedia.orientationPlaceholder", "Orientation")} /></SelectTrigger>
                <SelectContent>{COMBINED_ORIENTATIONS.map((opt) => (<SelectItem key={opt.value} value={opt.value}>{getOrientationLabel(opt.value, opt.label)}</SelectItem>))}</SelectContent>
              </Select>
            </div>
            <ScrollArea className="h-[350px]" onScrollCapture={handleScroll}>
              {loading ? renderLoading() : error ? renderError() : combinedPhotos.length === 0 ? renderEmpty(searchQuery ? t("stockMedia.noPhotosFound", "No photos found") : t("stockMedia.noPhotosAvailable", "No photos available")) : (
                <>
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 p-1">
                    {combinedPhotos.map((item) => (
                      <button key={item.id} type="button" onClick={() => handleSelectCombinedPhoto(item)} className="relative aspect-square rounded-lg overflow-hidden border border-border hover:border-primary transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 group bg-muted">
                        <img src={item.thumbnailUrl} alt={t("stockMedia.altPhoto", "Photo")} className="w-full h-full object-cover" loading="lazy" />
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
                        <SourceBadge source={item.source} />
                        <div className="absolute bottom-0 left-0 right-0 p-1 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                          <p className="text-[9px] text-white truncate">📷 {item.attribution}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                  {renderLoadingMore()}
                </>
              )}
            </ScrollArea>
          </TabsContent>

          {/* All Videos Tab (Combined) */}
          {!photosOnly && (
            <TabsContent value="all-videos" className="flex-1 flex flex-col min-h-0 mt-0">
              <div className="flex gap-2 mb-3">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input placeholder={t("stockMedia.searchAllVideos", "Search all videos...")} value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-9" />
                </div>
                <Select value={combinedVideoOrientation} onValueChange={(v) => setCombinedVideoOrientation(v as CombinedOrientation)}>
                  <SelectTrigger className="w-[130px]"><SelectValue placeholder={t("stockMedia.orientationPlaceholder", "Orientation")} /></SelectTrigger>
                  <SelectContent>{COMBINED_ORIENTATIONS.map((opt) => (<SelectItem key={opt.value} value={opt.value}>{getOrientationLabel(opt.value, opt.label)}</SelectItem>))}</SelectContent>
                </Select>
              </div>
              <ScrollArea className="h-[350px]" onScrollCapture={handleScroll}>
                {loading ? renderLoading() : error ? renderError() : combinedVideos.length === 0 ? renderEmpty(searchQuery ? t("stockMedia.noVideosFound", "No videos found") : t("stockMedia.noVideosAvailable", "No videos available")) : (
                  <>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-1">
                      {combinedVideos.map((item) => (
                        <button key={item.id} type="button" onClick={() => handleSelectCombinedVideo(item)} className="relative aspect-video rounded-lg overflow-hidden border border-border hover:border-primary transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 group bg-muted">
                          <img src={item.thumbnailUrl} alt={t("stockMedia.altVideoThumbnail", "Video thumbnail")} className="w-full h-full object-cover" loading="lazy" />
                          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
                          <SourceBadge source={item.source} />
                          <div className="absolute top-1 right-1"><Video className="w-3 h-3 text-white drop-shadow-md" /></div>
                          {item.duration && (
                            <div className="absolute bottom-1 right-1 bg-black/70 px-1 rounded text-[9px] text-white">
                              {Math.floor(item.duration / 60)}:{(item.duration % 60).toString().padStart(2, '0')}
                            </div>
                          )}
                          <div className="absolute bottom-0 left-0 right-0 p-1 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                            <p className="text-[9px] text-white truncate">🎬 {item.attribution}</p>
                          </div>
                        </button>
                      ))}
                    </div>
                    {renderLoadingMore()}
                  </>
                )}
              </ScrollArea>
            </TabsContent>
          )}

          {/* All GIFs Tab (Combined) */}
          {!photosOnly && (
            <TabsContent value="all-gifs" className="flex-1 flex flex-col min-h-0 mt-0">
              <div className="flex gap-2 mb-3">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input placeholder={getSearchPlaceholder()} value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-9" />
                </div>
              </div>
              <ScrollArea className="h-[350px]" onScrollCapture={handleScroll}>
                {loading ? renderLoading() : error ? renderError() : combinedGifs.length === 0 ? renderEmpty(searchQuery ? t("stockMedia.noGifsFound", "No GIFs found") : t("stockMedia.noGifsAvailable", "No GIFs available")) : (
                  <>
                    <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 p-1">
                      {combinedGifs.map((item) => (
                        <button key={item.id} type="button" onClick={() => handleSelectCombinedGif(item)} className="relative aspect-square rounded-lg overflow-hidden border border-border hover:border-primary transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 group bg-muted">
                          <img src={item.thumbnailUrl} alt={item.title || t("stockMedia.altGif", "GIF")} className="w-full h-full object-cover" loading="lazy" />
                          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
                          <SourceBadge source={item.source} />
                          <div className="absolute top-1 right-1"><Film className="w-3 h-3 text-white drop-shadow-md" /></div>
                        </button>
                      ))}
                    </div>
                    {renderLoadingMore()}
                  </>
                )}
              </ScrollArea>
            </TabsContent>
          )}

          {/* Unsplash Tab */}
          <TabsContent value="unsplash" className="flex-1 flex flex-col min-h-0 mt-0">
            <div className="flex gap-2 mb-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input placeholder={getSearchPlaceholder()} value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-9" />
              </div>
              <Select value={unsplashOrientation} onValueChange={(v) => setUnsplashOrientation(v as UnsplashOrientation)}>
                <SelectTrigger className="w-[130px]"><SelectValue placeholder={t("stockMedia.orientationPlaceholder", "Orientation")} /></SelectTrigger>
                <SelectContent>{UNSPLASH_ORIENTATIONS.map((opt) => (<SelectItem key={opt.value} value={opt.value}>{getOrientationLabel(opt.value, opt.label)}</SelectItem>))}</SelectContent>
              </Select>
            </div>
            <ScrollArea className="h-[350px]" onScrollCapture={handleScroll}>
              {loading ? renderLoading() : error ? renderError() : unsplashPhotos.length === 0 ? renderEmpty(searchQuery ? t("stockMedia.noPhotosFound", "No photos found") : t("stockMedia.noEditorialPhotos", "No editorial photos available")) : (
                <>
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 p-1">
                    {unsplashPhotos.map((photo) => (
                      <button key={photo.id} type="button" onClick={() => handleSelectUnsplashPhoto(photo)} className="relative aspect-square rounded-lg overflow-hidden border border-border hover:border-primary transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 group bg-muted">
                        <img src={getUnsplashPhotoThumbnail(photo)} alt={photo.alt_description || t("stockMedia.altPhoto", "Photo")} className="w-full h-full object-cover" loading="lazy" />
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
                        {/* Unsplash attribution - visible on hover per API guidelines */}
                        <div className="absolute bottom-0 left-0 right-0 p-1.5 bg-gradient-to-t from-black/70 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                          <p className="text-[9px] text-white/90 truncate leading-tight">
                            {t("stockMedia.photoByPrefix", "Photo by")}{" "}
                            <span 
                              className="underline hover:text-white cursor-pointer"
                              onClick={(e) => {
                                e.stopPropagation();
                                window.open(getUnsplashPhotographerUrl(photo), "_blank", "noopener,noreferrer");
                              }}
                            >
                              {photo.user.name}
                            </span>
                            {" "}{t("stockMedia.onPlatform", "on")}{" "}
                            <span 
                              className="underline hover:text-white cursor-pointer"
                              onClick={(e) => {
                                e.stopPropagation();
                                window.open(getUnsplashUrl(), "_blank", "noopener,noreferrer");
                              }}
                            >
                              Unsplash
                            </span>
                          </p>
                        </div>
                      </button>
                    ))}
                  </div>
                  {renderLoadingMore()}
                </>
              )}
            </ScrollArea>
          </TabsContent>

          {/* KLIPY Tab */}
          {!photosOnly && (
            <TabsContent value="klipy" className="flex-1 flex flex-col min-h-0 mt-0">
              <Tabs value={klipySubTab} onValueChange={(v) => setKlipySubTab(v as KlipySubTab)} className="flex flex-col flex-1 min-h-0">
                <TabsList className="grid w-full grid-cols-2 mb-3">
                  <TabsTrigger value="gifs" className="flex items-center gap-1.5">
                    <Film className="w-4 h-4" />
                    {t("stockMedia.gifsTab", "GIFs")}
                  </TabsTrigger>
                  <TabsTrigger value="clips" className="flex items-center gap-1.5">
                    <Video className="w-4 h-4" />
                    {t("stockMedia.clipsTab", "Clips")}
                  </TabsTrigger>
                </TabsList>

                {/* Search and Category Filter */}
                <div className="flex gap-2 mb-3">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input placeholder={getSearchPlaceholder()} value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-9" />
                  </div>
                  <Select value={klipyCategory} onValueChange={setKlipyCategory}>
                    <SelectTrigger className="w-[140px]">
                      <SelectValue placeholder={t("stockMedia.categoryPlaceholder", "Category")} />
                    </SelectTrigger>
                    <SelectContent>
                      {KLIPY_CATEGORIES.map((cat) => (
                        <SelectItem key={cat.value} value={cat.value}>{cat.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <TabsContent value="gifs" className="flex-1 mt-0">
                  <ScrollArea className="h-[350px]" onScrollCapture={handleScroll}>
                    {loading ? renderLoading() : error ? renderError() : gifs.length === 0 ? renderEmpty(searchQuery || klipyCategory !== "all" ? t("stockMedia.noGifsFound", "No GIFs found") : t("stockMedia.noTrendingGifs", "No trending GIFs available")) : (
                      <>
                        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 p-1">
                          {gifs.map((gif, index) => {
                            const thumbnailUrl = getThumbnailUrl(gif);
                            if (!thumbnailUrl) return null;
                            return (
                              <button key={gif.id || gif.slug || index} type="button" onClick={() => handleSelectKlipyGif(gif)} className="relative aspect-square rounded-lg overflow-hidden border border-border hover:border-primary transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 group bg-muted">
                                <img src={thumbnailUrl} alt={gif.title || t("stockMedia.altGif", "GIF")} className="w-full h-full object-cover" loading="lazy" />
                                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
                              </button>
                            );
                          })}
                        </div>
                        {renderLoadingMore()}
                      </>
                    )}
                  </ScrollArea>
                </TabsContent>

                <TabsContent value="clips" className="flex-1 mt-0">
                  <ScrollArea className="h-[350px]" onScrollCapture={handleScroll}>
                    {loading ? renderLoading() : error ? renderError() : clips.length === 0 ? renderEmpty(searchQuery || klipyCategory !== "all" ? t("stockMedia.noClipsFound", "No Clips found") : t("stockMedia.noTrendingClips", "No trending Clips available")) : (
                      <>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-1">
                          {clips.map((clip, index) => {
                            const thumbnailUrl = getClipThumbnailUrl(clip);
                            if (!thumbnailUrl) return null;
                            return (
                              <button key={clip.slug || index} type="button" onClick={() => handleSelectKlipyClip(clip)} className="relative aspect-video rounded-lg overflow-hidden border border-border hover:border-primary transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 group bg-muted">
                                <img src={thumbnailUrl} alt={clip.title || t("stockMedia.altClip", "Clip")} className="w-full h-full object-cover" loading="lazy" />
                                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
                                <div className="absolute top-1 right-1"><Video className="w-3 h-3 text-white drop-shadow-md" /></div>
                                {clip.title && (<div className="absolute bottom-0 left-0 right-0 p-1.5 bg-gradient-to-t from-black/70 to-transparent"><p className="text-[10px] text-white truncate">{clip.title}</p></div>)}
                              </button>
                            );
                          })}
                        </div>
                        {renderLoadingMore()}
                      </>
                    )}
                  </ScrollArea>
                </TabsContent>
              </Tabs>
            </TabsContent>
          )}

          {/* GIPHY Tab */}
          {!photosOnly && (
            <TabsContent value="giphy" className="flex-1 flex flex-col min-h-0 mt-0">
              <Tabs value={giphySubTab} onValueChange={(v) => setGiphySubTab(v as GiphySubTab)} className="flex flex-col flex-1 min-h-0">
                <TabsList className="grid w-full grid-cols-3 mb-3">
                  <TabsTrigger value="gifs" className="flex items-center gap-1.5">
                    <Film className="w-4 h-4" />
                    {t("stockMedia.gifsTab", "GIFs")}
                  </TabsTrigger>
                  <TabsTrigger value="clips" className="flex items-center gap-1.5">
                    <Play className="w-4 h-4" />
                    {t("stockMedia.clipsTab", "Clips")}
                  </TabsTrigger>
                  <TabsTrigger value="stickers" className="flex items-center gap-1.5">
                    <Sparkles className="w-4 h-4" />
                    {t("stockMedia.stickersTab", "Stickers")}
                  </TabsTrigger>
                </TabsList>

                {/* Search and Category Filter */}
                <div className="flex gap-2 mb-3">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input placeholder={getSearchPlaceholder()} value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-9" />
                  </div>
                  {(giphySubTab === "gifs" || giphySubTab === "clips") && (
                    <Select value={giphyCategory} onValueChange={setGiphyCategory}>
                      <SelectTrigger className="w-[140px]">
                        <SelectValue placeholder={t("stockMedia.categoryPlaceholder", "Category")} />
                      </SelectTrigger>
                      <SelectContent>
                        {GIPHY_POPULAR_CATEGORIES.map((cat) => (
                          <SelectItem key={cat.value} value={cat.value}>{cat.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>

                {/* GIFs Content */}
                <TabsContent value="gifs" className="flex-1 mt-0">
                  <ScrollArea className="h-[350px]" onScrollCapture={handleScroll}>
                    {loading ? renderLoading() : error ? renderError() : giphyGifs.length === 0 ? renderEmpty(searchQuery || giphyCategory ? t("stockMedia.noGifsFound", "No GIFs found") : t("stockMedia.noTrendingGifs", "No trending GIFs available")) : (
                      <>
                        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 p-1">
                          {giphyGifs.map((gif) => {
                            const thumbnailUrl = getGiphyThumbnailUrl(gif);
                            if (!thumbnailUrl) return null;
                            return (
                              <button key={gif.id} type="button" onClick={() => handleSelectGiphyGif(gif)} className="relative aspect-square rounded-lg overflow-hidden border border-border hover:border-primary transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 group bg-muted">
                                <img src={thumbnailUrl} alt={gif.title || t("stockMedia.altGif", "GIF")} className="w-full h-full object-cover" loading="lazy" />
                                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
                                <div className="absolute top-1 right-1"><Film className="w-3 h-3 text-white drop-shadow-md" /></div>
                              </button>
                            );
                          })}
                        </div>
                        {renderLoadingMore()}
                      </>
                    )}
                  </ScrollArea>
                </TabsContent>

                {/* Clips Content */}
                <TabsContent value="clips" className="flex-1 mt-0">
                  <ScrollArea className="h-[350px]" onScrollCapture={handleScroll}>
                    {loading ? renderLoading() : error ? renderError() : giphyClips.length === 0 ? renderEmpty(searchQuery || giphyCategory ? t("stockMedia.noClipsFound", "No Clips found") : t("stockMedia.noTrendingClips", "No trending Clips available")) : (
                      <>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-1">
                          {giphyClips.map((clip) => {
                            const thumbnailUrl = getGiphyClipThumbnailUrl(clip);
                            if (!thumbnailUrl) return null;
                            return (
                              <button key={clip.id} type="button" onClick={() => handleSelectGiphyClip(clip)} className="relative aspect-video rounded-lg overflow-hidden border border-border hover:border-primary transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 group bg-muted">
                                <img src={thumbnailUrl} alt={clip.title || t("stockMedia.altClip", "Clip")} className="w-full h-full object-cover" loading="lazy" />
                                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
                                <div className="absolute top-1 right-1"><Play className="w-3 h-3 text-white drop-shadow-md" /></div>
                                {clip.title && (<div className="absolute bottom-0 left-0 right-0 p-1.5 bg-gradient-to-t from-black/70 to-transparent"><p className="text-[10px] text-white truncate">{clip.title}</p></div>)}
                              </button>
                            );
                          })}
                        </div>
                        {renderLoadingMore()}
                      </>
                    )}
                  </ScrollArea>
                </TabsContent>

                {/* Stickers Content */}
                <TabsContent value="stickers" className="flex-1 mt-0">
                  <ScrollArea className="h-[350px]" onScrollCapture={handleScroll}>
                    {loading ? renderLoading() : error ? renderError() : giphyStickers.length === 0 ? renderEmpty(searchQuery ? t("stockMedia.noStickersFound", "No stickers found") : t("stockMedia.noTrendingStickers", "No trending stickers available")) : (
                      <>
                        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 p-1">
                          {giphyStickers.map((sticker) => {
                            const thumbnailUrl = getGiphyThumbnailUrl(sticker);
                            if (!thumbnailUrl) return null;
                            return (
                              <button key={sticker.id} type="button" onClick={() => handleSelectGiphyGif(sticker)} className="relative aspect-square rounded-lg overflow-hidden border border-border hover:border-primary transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 group bg-muted">
                                <img src={thumbnailUrl} alt={sticker.title || t("stockMedia.altSticker", "Sticker")} className="w-full h-full object-contain" loading="lazy" />
                                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
                                <div className="absolute top-1 right-1"><Sparkles className="w-3 h-3 text-white drop-shadow-md" /></div>
                              </button>
                            );
                          })}
                        </div>
                        {renderLoadingMore()}
                      </>
                    )}
                  </ScrollArea>
                </TabsContent>
              </Tabs>
            </TabsContent>
          )}

          {/* Pexels Tab */}
          <TabsContent value="pexels" className="flex-1 flex flex-col min-h-0 mt-0">
            {photosOnly ? (
              <div className="flex flex-col flex-1 min-h-0">
                <div className="relative mb-3">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input placeholder={t("stockMedia.searchPhotos", "Search photos...")} value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-9" />
                </div>
                <ScrollArea className="h-[350px]" onScrollCapture={handleScroll}>
                  {loading ? renderLoading() : error ? renderError() : pexelsPhotos.length === 0 ? renderEmpty(searchQuery ? t("stockMedia.noPhotosFound", "No photos found") : t("stockMedia.noCuratedPhotos", "No curated photos available")) : (
                    <>
                      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 p-1">
                        {pexelsPhotos.map((photo) => (
                          <button key={photo.id} type="button" onClick={() => handleSelectPexelsPhoto(photo)} className="relative aspect-square rounded-lg overflow-hidden border border-border hover:border-primary transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 group bg-muted">
                            <img src={getPexelsPhotoThumbnail(photo)} alt={photo.alt || t("stockMedia.altPhoto", "Photo")} className="w-full h-full object-cover" loading="lazy" />
                            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
                            <div className="absolute bottom-0 left-0 right-0 p-1 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                              <p className="text-[9px] text-white truncate">📷 {photo.photographer}</p>
                            </div>
                          </button>
                        ))}
                      </div>
                      {renderLoadingMore()}
                    </>
                  )}
                </ScrollArea>
              </div>
            ) : (
              <Tabs value={pexelsSubTab} onValueChange={(v) => setPexelsSubTab(v as PexelsSubTab)} className="flex flex-col flex-1 min-h-0">
                <TabsList className="grid w-full grid-cols-2 mb-3">
                  <TabsTrigger value="photos" className="flex items-center gap-1.5"><Image className="w-4 h-4" />{t("stockMedia.photosTab", "Photos")}</TabsTrigger>
                  <TabsTrigger value="videos" className="flex items-center gap-1.5"><Video className="w-4 h-4" />{t("stockMedia.videosTab", "Videos")}</TabsTrigger>
                </TabsList>

                <div className="flex gap-2 mb-3">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input placeholder={getSearchPlaceholder()} value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-9" />
                  </div>
                  <Select value={pexelsOrientation} onValueChange={(v) => setPexelsOrientation(v as PexelsOrientation)}>
                    <SelectTrigger className="w-[130px]"><SelectValue placeholder={t("stockMedia.orientationPlaceholder", "Orientation")} /></SelectTrigger>
                    <SelectContent>{PEXELS_ORIENTATIONS.map((opt) => (<SelectItem key={opt.value} value={opt.value}>{getOrientationLabel(opt.value, opt.label)}</SelectItem>))}</SelectContent>
                  </Select>
                </div>

                <TabsContent value="photos" className="flex-1 mt-0">
                  <ScrollArea className="h-[350px]" onScrollCapture={handleScroll}>
                    {loading ? renderLoading() : error ? renderError() : pexelsPhotos.length === 0 ? renderEmpty(searchQuery ? t("stockMedia.noPhotosFound", "No photos found") : t("stockMedia.noCuratedPhotos", "No curated photos available")) : (
                      <>
                        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 p-1">
                          {pexelsPhotos.map((photo) => (
                            <button key={photo.id} type="button" onClick={() => handleSelectPexelsPhoto(photo)} className="relative aspect-square rounded-lg overflow-hidden border border-border hover:border-primary transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 group bg-muted">
                              <img src={getPexelsPhotoThumbnail(photo)} alt={photo.alt || t("stockMedia.altPhoto", "Photo")} className="w-full h-full object-cover" loading="lazy" />
                              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
                              <div className="absolute bottom-0 left-0 right-0 p-1 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                                <p className="text-[9px] text-white truncate">📷 {photo.photographer}</p>
                              </div>
                            </button>
                          ))}
                        </div>
                        {renderLoadingMore()}
                      </>
                    )}
                  </ScrollArea>
                </TabsContent>

                <TabsContent value="videos" className="flex-1 mt-0">
                  <ScrollArea className="h-[350px]" onScrollCapture={handleScroll}>
                    {loading ? renderLoading() : error ? renderError() : pexelsVideos.length === 0 ? renderEmpty(searchQuery ? t("stockMedia.noVideosFound", "No videos found") : t("stockMedia.noPopularVideos", "No popular videos available")) : (
                      <>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-1">
                          {pexelsVideos.map((video) => (
                            <button key={video.id} type="button" onClick={() => handleSelectPexelsVideo(video)} className="relative aspect-video rounded-lg overflow-hidden border border-border hover:border-primary transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 group bg-muted">
                              <img src={getPexelsVideoThumbnail(video)} alt={t("stockMedia.altVideoThumbnail", "Video thumbnail")} className="w-full h-full object-cover" loading="lazy" />
                              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
                              <div className="absolute top-1 right-1"><Video className="w-3 h-3 text-white drop-shadow-md" /></div>
                              <div className="absolute bottom-0 left-0 right-0 p-1 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                                <p className="text-[9px] text-white truncate">🎬 {video.user.name}</p>
                              </div>
                            </button>
                          ))}
                        </div>
                        {renderLoadingMore()}
                      </>
                    )}
                  </ScrollArea>
                </TabsContent>
              </Tabs>
            )}
          </TabsContent>

          {/* Pixabay Tab */}
          <TabsContent value="pixabay" className="flex-1 flex flex-col min-h-0 mt-0">
            {photosOnly ? (
              <div className="flex flex-col flex-1 min-h-0">
                <div className="relative mb-3">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input placeholder={t("stockMedia.searchPhotos", "Search photos...")} value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-9" />
                </div>
                <ScrollArea className="h-[350px]" onScrollCapture={handleScroll}>
                  {loading ? renderLoading() : error ? renderError() : pixabayPhotos.length === 0 ? renderEmpty(searchQuery ? t("stockMedia.noPhotosFound", "No photos found") : t("stockMedia.noPopularPhotos", "No popular photos available")) : (
                    <>
                      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 p-1">
                        {pixabayPhotos.map((photo) => (
                          <button key={photo.id} type="button" onClick={() => handleSelectPixabayPhoto(photo)} className="relative aspect-square rounded-lg overflow-hidden border border-border hover:border-primary transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 group bg-muted">
                            <img src={getPixabayPhotoThumbnail(photo)} alt={photo.tags || t("stockMedia.altPhoto", "Photo")} className="w-full h-full object-cover" loading="lazy" />
                            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
                            <div className="absolute bottom-0 left-0 right-0 p-1 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                              <p className="text-[9px] text-white truncate">📷 {photo.user}</p>
                            </div>
                          </button>
                        ))}
                      </div>
                      {renderLoadingMore()}
                    </>
                  )}
                </ScrollArea>
              </div>
            ) : (
              <Tabs value={pixabaySubTab} onValueChange={(v) => setPixabaySubTab(v as PixabaySubTab)} className="flex flex-col flex-1 min-h-0">
                <TabsList className="grid w-full grid-cols-3 mb-3">
                  <TabsTrigger value="photos" className="flex items-center gap-1.5"><Image className="w-4 h-4" />{t("stockMedia.photosTab", "Photos")}</TabsTrigger>
                  <TabsTrigger value="videos" className="flex items-center gap-1.5"><Video className="w-4 h-4" />{t("stockMedia.videosTab", "Videos")}</TabsTrigger>
                  <TabsTrigger value="gifs" className="flex items-center gap-1.5"><Film className="w-4 h-4" />{t("stockMedia.gifsTab", "GIFs")}</TabsTrigger>
                </TabsList>

                <div className="flex gap-2 mb-3">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input placeholder={getSearchPlaceholder()} value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-9" />
                  </div>
                  <Select value={pixabayOrientation} onValueChange={(v) => setPixabayOrientation(v as PixabayOrientation)}>
                    <SelectTrigger className="w-[130px]"><SelectValue placeholder={t("stockMedia.orientationPlaceholder", "Orientation")} /></SelectTrigger>
                    <SelectContent>{PIXABAY_ORIENTATIONS.map((opt) => (<SelectItem key={opt.value} value={opt.value}>{getOrientationLabel(opt.value, opt.label)}</SelectItem>))}</SelectContent>
                  </Select>
                </div>

                <TabsContent value="photos" className="flex-1 mt-0">
                  <ScrollArea className="h-[350px]" onScrollCapture={handleScroll}>
                    {loading ? renderLoading() : error ? renderError() : pixabayPhotos.length === 0 ? renderEmpty(searchQuery ? t("stockMedia.noPhotosFound", "No photos found") : t("stockMedia.noPopularPhotos", "No popular photos available")) : (
                      <>
                        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 p-1">
                          {pixabayPhotos.map((photo) => (
                            <button key={photo.id} type="button" onClick={() => handleSelectPixabayPhoto(photo)} className="relative aspect-square rounded-lg overflow-hidden border border-border hover:border-primary transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 group bg-muted">
                              <img src={getPixabayPhotoThumbnail(photo)} alt={photo.tags || t("stockMedia.altPhoto", "Photo")} className="w-full h-full object-cover" loading="lazy" />
                              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
                              <div className="absolute bottom-0 left-0 right-0 p-1 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                                <p className="text-[9px] text-white truncate">📷 {photo.user}</p>
                              </div>
                            </button>
                          ))}
                        </div>
                        {renderLoadingMore()}
                      </>
                    )}
                  </ScrollArea>
                </TabsContent>

                <TabsContent value="videos" className="flex-1 mt-0">
                  <ScrollArea className="h-[350px]" onScrollCapture={handleScroll}>
                    {loading ? renderLoading() : error ? renderError() : pixabayVideos.length === 0 ? renderEmpty(searchQuery ? t("stockMedia.noVideosFound", "No videos found") : t("stockMedia.noPopularVideos", "No popular videos available")) : (
                      <>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-1">
                          {pixabayVideos.map((video) => (
                            <button key={video.id} type="button" onClick={() => handleSelectPixabayVideo(video)} className="relative aspect-video rounded-lg overflow-hidden border border-border hover:border-primary transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 group bg-muted">
                              <img src={getPixabayVideoThumbnail(video)} alt={t("stockMedia.altVideoThumbnail", "Video thumbnail")} className="w-full h-full object-cover" loading="lazy" />
                              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
                              <div className="absolute top-1 right-1"><Video className="w-3 h-3 text-white drop-shadow-md" /></div>
                              <div className="absolute bottom-0 left-0 right-0 p-1 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                                <p className="text-[9px] text-white truncate">🎬 {video.user}</p>
                              </div>
                            </button>
                          ))}
                        </div>
                        {renderLoadingMore()}
                      </>
                    )}
                  </ScrollArea>
                </TabsContent>

                <TabsContent value="gifs" className="flex-1 mt-0">
                  <ScrollArea className="h-[350px]" onScrollCapture={handleScroll}>
                    {loading ? renderLoading() : error ? renderError() : pixabayGifsData.length === 0 ? renderEmpty(searchQuery ? t("stockMedia.noGifsFound", "No GIFs found") : t("stockMedia.noPopularGifs", "No popular GIFs available")) : (
                      <>
                        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 p-1">
                          {pixabayGifsData.map((gif) => (
                            <button key={gif.id} type="button" onClick={() => handleSelectPixabayGif(gif)} className="relative aspect-square rounded-lg overflow-hidden border border-border hover:border-primary transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 group bg-muted">
                              <img src={getPixabayPhotoThumbnail(gif)} alt={gif.tags || t("stockMedia.altGif", "GIF")} className="w-full h-full object-cover" loading="lazy" />
                              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
                              <div className="absolute top-1 right-1"><Film className="w-3 h-3 text-white drop-shadow-md" /></div>
                              <div className="absolute bottom-0 left-0 right-0 p-1 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                                <p className="text-[9px] text-white truncate">🎞️ {gif.user}</p>
                              </div>
                            </button>
                          ))}
                        </div>
                        {renderLoadingMore()}
                      </>
                    )}
                  </ScrollArea>
                </TabsContent>
              </Tabs>
            )}
          </TabsContent>
        </Tabs>

        {/* Attribution */}
        <div className="flex items-center justify-center pt-2 border-t">
          <a href={attribution?.url} target="_blank" rel="noopener noreferrer" className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5">
            {t("stockMedia.poweredByPrefix", "Powered by")} <span className="font-semibold">{attribution?.name}</span>
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}
