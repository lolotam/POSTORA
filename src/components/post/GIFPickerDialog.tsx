import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Loader2, Search, Film, Video } from "lucide-react";
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
  KlipyClip
} from "@/lib/klipyApi";
import { useDebounce } from "@/hooks/shared/useDebounce";

interface GIFPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (url: string) => void;
}

type TabType = "gifs" | "clips";

export function GIFPickerDialog({ open, onOpenChange, onSelect }: GIFPickerDialogProps) {
  const { t } = useTranslation("postmedia");
  const [activeTab, setActiveTab] = useState<TabType>("gifs");
  const [searchQuery, setSearchQuery] = useState("");
  const [gifs, setGifs] = useState<KlipyGif[]>([]);
  const [clips, setClips] = useState<KlipyClip[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const debouncedQuery = useDebounce(searchQuery, 400);

  // Fetch GIFs
  const fetchGifsData = useCallback(async (query: string) => {
    setLoading(true);
    setError(null);
    try {
      const results = query.trim() 
        ? await searchGifs(query) 
        : await fetchTrendingGifs();
      setGifs(Array.isArray(results) ? results : []);
    } catch (err) {
      console.error("Failed to fetch GIFs:", err);
      setError(t("gifPicker.errorGifs", "Failed to load GIFs. Please try again."));
      setGifs([]);
    } finally {
      setLoading(false);
    }
  }, [t]);

  // Fetch Clips
  const fetchClipsData = useCallback(async (query: string) => {
    setLoading(true);
    setError(null);
    try {
      const results = query.trim() 
        ? await searchClips(query) 
        : await fetchTrendingClips();
      setClips(Array.isArray(results) ? results : []);
    } catch (err) {
      console.error("Failed to fetch Clips:", err);
      setError(t("gifPicker.errorClips", "Failed to load Clips. Please try again."));
      setClips([]);
    } finally {
      setLoading(false);
    }
  }, [t]);

  // Fetch data based on active tab
  const fetchData = useCallback((query: string) => {
    if (activeTab === "gifs") {
      fetchGifsData(query);
    } else {
      fetchClipsData(query);
    }
  }, [activeTab, fetchGifsData, fetchClipsData]);

  // Load data when dialog opens
  useEffect(() => {
    if (open) {
      setSearchQuery("");
      fetchData("");
    }
  }, [open]);

  // Refetch when tab changes
  useEffect(() => {
    if (open) {
      fetchData(debouncedQuery);
    }
  }, [activeTab, open]);

  // Search when debounced query changes
  useEffect(() => {
    if (open) {
      fetchData(debouncedQuery);
    }
  }, [debouncedQuery]);

  const handleSelectGif = (gif: KlipyGif) => {
    const gifUrl = getEmbedUrl(gif);
    if (gifUrl) {
      onSelect(gifUrl);
      onOpenChange(false);
    }
  };

  const handleSelectClip = (clip: KlipyClip) => {
    const clipUrl = getClipEmbedUrl(clip);
    if (clipUrl) {
      onSelect(clipUrl);
      onOpenChange(false);
    }
  };

  const handleTabChange = (value: string) => {
    setActiveTab(value as TabType);
    setError(null);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Film className="w-5 h-5" />
            {t("gifPicker.title", "Add from KLIPY")}
          </DialogTitle>
        </DialogHeader>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
          <TabsList className="grid w-full grid-cols-2 mb-3">
            <TabsTrigger value="gifs" className="flex items-center gap-1.5">
              <Film className="w-4 h-4" />
              {t("gifPicker.tabGifs", "GIFs")}
            </TabsTrigger>
            <TabsTrigger value="clips" className="flex items-center gap-1.5">
              <Video className="w-4 h-4" />
              {t("gifPicker.tabClips", "Clips")}
            </TabsTrigger>
          </TabsList>

          {/* Search input */}
          <div className="relative mb-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder={activeTab === "gifs" ? t("gifPicker.searchGifs", "Search GIFs...") : t("gifPicker.searchClips", "Search Clips...")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
              autoFocus
            />
          </div>

          {/* GIFs Tab Content */}
          <TabsContent value="gifs" className="mt-0">
            <ScrollArea className="h-[350px]">
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                </div>
              ) : error ? (
                <div className="flex items-center justify-center py-12 text-destructive text-sm">
                  {error}
                </div>
              ) : gifs.length === 0 ? (
                <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
                  {searchQuery ? t("gifPicker.noGifsFound", "No GIFs found") : t("gifPicker.noTrendingGifs", "No trending GIFs available")}
                </div>
              ) : (
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 p-1">
                  {gifs.map((gif, index) => {
                    const thumbnailUrl = getThumbnailUrl(gif);
                    if (!thumbnailUrl) return null;
                    
                    return (
                      <button
                        key={gif.id || gif.slug || index}
                        type="button"
                        onClick={() => handleSelectGif(gif)}
                        className="relative aspect-square rounded-lg overflow-hidden border border-border hover:border-primary transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 group bg-muted"
                      >
                        <img
                          src={thumbnailUrl}
                          alt={gif.title || "GIF"}
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
                      </button>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          </TabsContent>

          {/* Clips Tab Content */}
          <TabsContent value="clips" className="mt-0">
            <ScrollArea className="h-[350px]">
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                </div>
              ) : error ? (
                <div className="flex items-center justify-center py-12 text-destructive text-sm">
                  {error}
                </div>
              ) : clips.length === 0 ? (
                <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
                  {searchQuery ? t("gifPicker.noClipsFound", "No Clips found") : t("gifPicker.noTrendingClips", "No trending Clips available")}
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-1">
                  {clips.map((clip, index) => {
                    const thumbnailUrl = getClipThumbnailUrl(clip);
                    if (!thumbnailUrl) return null;
                    
                    return (
                      <button
                        key={clip.slug || index}
                        type="button"
                        onClick={() => handleSelectClip(clip)}
                        className="relative aspect-video rounded-lg overflow-hidden border border-border hover:border-primary transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 group bg-muted"
                      >
                        <img
                          src={thumbnailUrl}
                          alt={clip.title || "Clip"}
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
                        {clip.title && (
                          <div className="absolute bottom-0 left-0 right-0 p-1.5 bg-gradient-to-t from-black/70 to-transparent">
                            <p className="text-[10px] text-white truncate">{clip.title}</p>
                          </div>
                        )}
                        <div className="absolute top-1 right-1">
                          <Video className="w-3 h-3 text-white drop-shadow-md" />
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          </TabsContent>
        </Tabs>

        {/* KLIPY Attribution */}
        <div className="flex items-center justify-center pt-2 border-t">
          <a
            href="https://klipy.co"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5"
          >
            {t("gifPicker.poweredBy", "Powered by")} <span className="font-semibold">KLIPY</span>
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}
