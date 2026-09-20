import { useState, useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { MapPin, X, Loader2, AlertTriangle, Info } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

export type PlaceSource = "threads" | "facebook" | "nominatim" | "meta";

export interface PlaceResult {
  id: string;
  name: string;
  address?: string;
  city?: string;
  country?: string;
  latitude?: number | null;
  longitude?: number | null;
  source: PlaceSource;
  taggable_on_threads?: boolean;
  taggable_on_instagram?: boolean | null;
  taggable_on_facebook?: boolean | null;
  eligibility_reason?: string;
}

interface LocationAutocompleteProps {
  locationId: string;
  setLocationId: (v: string) => void;
  locationName: string;
  setLocationName: (v: string) => void;
  accountId?: string;
  /** Drives both which search edge function is used AND which taggable badge is shown. */
  platform?: "facebook" | "instagram" | "threads";
  /** Optional callback so parents can persist the full selected place (source, lat/lng, eligibility). */
  onSelectPlace?: (place: PlaceResult) => void;
}

function platformBadge(
  place: PlaceResult,
  platform: LocationAutocompleteProps["platform"],
  t: TFunction<"postsettings">,
): { label: string; tone: "ok" | "warn" | "muted" } {
  // OSM is never taggable on Meta
  if (place.source === "nominatim" || String(place.id).startsWith("osm_")) {
    return { label: t("location.referenceOnly", "Reference only"), tone: "warn" };
  }

  if (platform === "threads") {
    if (place.taggable_on_threads === true && place.source === "threads") {
      return { label: t("location.threadsTaggable", "Threads taggable"), tone: "ok" };
    }
    return { label: t("location.referenceOnly", "Reference only"), tone: "warn" };
  }

  if (platform === "instagram") {
    if (place.taggable_on_instagram === true) return { label: t("location.instagramTaggable", "Instagram taggable"), tone: "ok" };
    if (place.taggable_on_instagram === false) return { label: t("location.notEligibleInstagram", "Not eligible for Instagram"), tone: "warn" };
    return { label: t("location.unverified", "Unverified"), tone: "warn" };
  }

  if (platform === "facebook") {
    if (place.taggable_on_facebook === true) return { label: t("location.likelyFacebookPlace", "Likely Facebook place"), tone: "ok" };
    if (place.taggable_on_facebook === false) return { label: t("location.mayNotAppear", "May not appear"), tone: "warn" };
    return { label: t("location.unverified", "Unverified"), tone: "muted" };
  }

  // No platform context — show source as a neutral hint
  return { label: place.source, tone: "muted" };
}

function badgeClass(tone: "ok" | "warn" | "muted"): string {
  switch (tone) {
    case "ok": return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20";
    case "warn": return "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20";
    case "muted":
    default: return "bg-muted text-muted-foreground border-transparent";
  }
}

/**
 * Strict selection rules: returns true only if the place can actually be tagged
 * by Meta on the active platform. Used to disable selection for reference-only
 * results that would otherwise be silently dropped at publish time.
 */
function isSelectableForPlatform(
  place: PlaceResult,
  platform: LocationAutocompleteProps["platform"],
): boolean {
  if (!place || !place.id) return false;
  if (String(place.id).startsWith("osm_") || place.source === "nominatim") return false;
  if (platform === "instagram") {
    return place.source === "facebook" && place.taggable_on_instagram === true;
  }
  if (platform === "threads") {
    return place.source === "threads" && place.taggable_on_threads === true;
  }
  if (platform === "facebook") {
    return place.taggable_on_facebook !== false;
  }
  return true;
}

function disabledReasonFor(
  place: PlaceResult,
  platform: LocationAutocompleteProps["platform"],
  t: TFunction<"postsettings">,
): string {
  if (String(place.id).startsWith("osm_") || place.source === "nominatim") {
    return platform === "instagram"
      ? t("location.disabledReasonRefInstagram", "Reference only — won't be tagged on Instagram")
      : platform === "threads"
      ? t("location.disabledReasonRefThreads", "Reference only — won't be tagged on Threads")
      : t("location.disabledReasonRefPost", "Reference only — won't be tagged on the published post");
  }
  if (platform === "instagram") {
    if (place.taggable_on_instagram === false) return t("location.notEligibleInstagram", "Not eligible for Instagram");
    if (place.taggable_on_instagram !== true) return t("location.disabledReasonUnverifiedInstagram", "Unverified — not guaranteed to tag on Instagram");
  }
  if (platform === "threads") {
    if (place.source !== "threads") return t("location.disabledReasonNotNativeThreads", "Not a native Threads location — won't be tagged");
    if (place.taggable_on_threads !== true) return t("location.disabledReasonNotTaggableThreads", "Not taggable on Threads");
  }
  return t("location.disabledReasonNotSelectable", "Not selectable for this platform");
}

export function LocationAutocomplete({
  locationId,
  setLocationId,
  locationName,
  setLocationName,
  accountId,
  platform,
  onSelectPlace,
}: LocationAutocompleteProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [threadsSampleDataDetected, setThreadsSampleDataDetected] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const containerRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { t } = useTranslation("postsettings");

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const searchPlaces = async (searchQuery: string) => {
    if (!searchQuery || searchQuery.length < 2) {
      setResults([]);
      setErrorMessage(null);
      setNeedsReconnect(false);
      setThreadsSampleDataDetected(false);
      return;
    }

    setLoading(true);
    setErrorMessage(null);
    setNeedsReconnect(false);
    setThreadsSampleDataDetected(false);

    try {
      let collected: PlaceResult[] = [];

      if (platform === "threads") {
        const { data } = await supabase.functions.invoke("threads-location-search", {
          body: { query: searchQuery },
        });
        if (data?.sampleDataDetected) setThreadsSampleDataDetected(true);
        if (data?.ok && Array.isArray(data.results)) {
          collected = data.results.map((p: any): PlaceResult => ({
            id: String(p.id),
            name: p.name,
            address: p.address || undefined,
            city: p.city || undefined,
            country: p.country || undefined,
            latitude: p.latitude ?? null,
            longitude: p.longitude ?? null,
            source: (p.source as PlaceSource) || "threads",
            taggable_on_threads: typeof p.taggable_on_threads === "boolean" ? p.taggable_on_threads : p.source === "threads",
            eligibility_reason: p.eligibility_reason || undefined,
          }));
        } else if (data?.needsConnection) {
          setErrorMessage(t("location.connectThreadsToSearch", "Connect Threads to search locations."));
        }
      } else {
        const { data, error } = await supabase.functions.invoke("facebook-places-search", {
          body: { query: searchQuery, account_id: accountId, platform },
        });

        if (error) throw error;

        if (data?.error) {
          if (data.error === "RECONNECT_REQUIRED") setNeedsReconnect(true);
          else setErrorMessage(data.error);
        }

        const fbSource: PlaceSource = data?.source === "nominatim" ? "nominatim" : "facebook";
        collected = (data?.places || []).map((p: any): PlaceResult => ({
          id: String(p.id),
          name: p.name,
          address: p.address || undefined,
          city: p.city || undefined,
          country: p.country || undefined,
          latitude: p.latitude ?? null,
          longitude: p.longitude ?? null,
          source: (p.source as PlaceSource) || fbSource,
          taggable_on_instagram:
            typeof p.taggable_on_instagram === "boolean" ? p.taggable_on_instagram : null,
          taggable_on_facebook:
            typeof p.taggable_on_facebook === "boolean" ? p.taggable_on_facebook : null,
          eligibility_reason: p.eligibility_reason || undefined,
        }));
      }

      // Sort taggable results first for the active platform
      collected.sort((a, b) => {
        const ta = isSelectableForPlatform(a, platform);
        const tb = isSelectableForPlatform(b, platform);
        if (ta === tb) return 0;
        return ta ? -1 : 1;
      });

      setResults(collected);
      setShowDropdown(true);
    } catch (err) {
      console.error("Place search error:", err);
      setErrorMessage(t("location.failedToSearch", "Failed to search locations. Please try again."));
      setResults([]);
      setShowDropdown(true);
    } finally {
      setLoading(false);
    }
  };

  const handleInputChange = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => searchPlaces(value), 500);
  };

  const selectPlace = (place: PlaceResult) => {
    // Block selecting OSM as a real Meta tag — keep current legacy guard behavior
    setLocationId(place.id);
    setLocationName(place.name + (place.city ? `, ${place.city}` : ""));
    if (onSelectPlace) onSelectPlace(place);
    setQuery("");
    setShowDropdown(false);
    setResults([]);
    setErrorMessage(null);
    setNeedsReconnect(false);
  };

  const clearSelection = () => {
    setLocationId("");
    setLocationName("");
    if (onSelectPlace) {
      // Notify parent so it can clear the structured object too
      onSelectPlace({ id: "", name: "", source: "meta" });
    }
    setQuery("");
    setResults([]);
    setErrorMessage(null);
    setNeedsReconnect(false);
    setThreadsSampleDataDetected(false);
  };

  const isOsmLocation = locationId.startsWith("osm_");

  if (locationId && locationName) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 p-2 bg-secondary/50 rounded-lg border">
          <MapPin className="w-4 h-4 text-muted-foreground shrink-0" />
          <span className="text-sm truncate">{locationName}</span>
          <button
            type="button"
            onClick={clearSelection}
            className="ml-auto p-1 hover:bg-destructive/10 rounded transition-colors"
          >
            <X className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
        </div>
        {isOsmLocation && (
          <div className="flex items-start gap-1.5 px-2 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              {t("location.osmWarning", "Reference only — this location won't be tagged on the published post.")}{" "}
              <button
                type="button"
                onClick={() => navigate("/profiles")}
                className="underline font-medium ml-1 hover:text-amber-700 dark:hover:text-amber-300"
              >
                {t("location.reconnectAccount", "Reconnect your account")}
              </button>
              {" "}{t("location.toEnableTagging", "to enable native location tagging.")}
            </span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <p className="text-xs text-muted-foreground mb-1.5 leading-snug">
        {platform === "threads"
          ? t("location.threadsHelper", "Only native Threads results can appear as a Threads location tag. Facebook/Reference results are shown as fallback only.")
          : platform === "instagram"
          ? t("location.instagramHelper", "Instagram only accepts eligible Meta place IDs. Non-taggable results are marked and will be skipped at publish time.")
          : platform === "facebook"
          ? t("location.facebookHelper", "Facebook may publish the post successfully but silently ignore invalid place tags. We pre-check and verify after publish.")
          : t("location.defaultHelper", "Tag a location on your post.")}
      </p>
      <div className="relative">
        <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder={t("location.searchPlaceholder", "Search for a location...")}
          value={query}
          onChange={(e) => handleInputChange(e.target.value)}
          onFocus={() => (results.length > 0 || errorMessage || needsReconnect) && setShowDropdown(true)}
          className="pl-9 pr-8"
        />
        {loading && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground animate-spin" />
        )}
      </div>

      {showDropdown && needsReconnect && !loading && (
        <div className="absolute z-50 w-full mt-1 bg-popover border border-amber-500/30 rounded-lg shadow-lg p-3 text-sm">
          <div className="flex items-start gap-2 text-amber-700 dark:text-amber-400">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">{t("location.permissionUpdateNeeded", "Permission update needed")}</p>
              <p className="text-xs mt-1 text-muted-foreground">
                {t("location.reconnectToSearch", "Reconnect your account to enable native location search.")}
              </p>
              <button
                type="button"
                onClick={() => navigate("/profiles")}
                className="mt-2 text-xs font-medium text-primary underline hover:no-underline"
              >
                {t("location.goToProfilesReconnect", "Go to Profiles → Reconnect")}
              </button>
            </div>
          </div>
        </div>
      )}

      {showDropdown && results.length > 0 && (
        <div className="absolute z-50 w-full mt-1 bg-popover border rounded-lg shadow-lg max-h-56 overflow-y-auto">
          {results.map((place) => {
            const selectable = isSelectableForPlatform(place, platform);
            const badge = platformBadge(place, platform, t);
            const reason = !selectable ? disabledReasonFor(place, platform, t) : undefined;
            return (
              <button
                key={`${place.source}-${place.id}`}
                type="button"
                onClick={() => {
                  if (!selectable) {
                    if (platform === "instagram") {
                      toast.error(t("location.toastRefInstagram", "This location is reference-only and cannot be tagged on Instagram. Try a Meta place result or search a more specific official place name."));
                    } else if (platform === "threads") {
                      toast.error(t("location.toastRefThreads", "This location is reference-only and cannot be tagged on Threads. Threads only accepts native Threads location results."));
                    } else {
                      toast.error(reason || t("location.toastNotSelectable", "This location is not selectable."));
                    }
                    return;
                  }
                  selectPlace(place);
                }}
                aria-disabled={!selectable}
                className={cn(
                  "w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2",
                  selectable
                    ? "hover:bg-accent cursor-pointer"
                    : "opacity-60 cursor-not-allowed hover:bg-transparent"
                )}
                title={reason}
              >
                <MapPin className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <div className="truncate flex-1">
                  <span className="font-medium">{place.name}</span>
                  {(place.city || place.country) && (
                    <span className="text-muted-foreground ml-1">
                      {[place.city, place.country].filter(Boolean).join(", ")}
                    </span>
                  )}
                </div>
                <Badge
                  variant="outline"
                  className={cn("text-[10px] h-4 px-1.5 shrink-0 border", badgeClass(badge.tone))}
                >
                  {badge.label}
                </Badge>
              </button>
            );
          })}
        </div>
      )}

      {showDropdown && errorMessage && !loading && !needsReconnect && (
        <div className="absolute z-50 w-full mt-1 bg-popover border border-amber-500/30 rounded-lg shadow-lg p-3 text-sm text-amber-700 dark:text-amber-400">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{errorMessage}</span>
          </div>
        </div>
      )}

      {showDropdown && query.length >= 2 && results.length === 0 && !loading && !errorMessage && !needsReconnect && (
        <div className="absolute z-50 w-full mt-1 bg-popover border rounded-lg shadow-lg p-3 text-sm text-muted-foreground text-center">
          {t("location.noLocationsFound", "No locations found")}
        </div>
      )}

      {platform === "threads" && threadsSampleDataDetected && (
        <div className="mt-1.5 flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>
            {t("location.threadsSampleDataWarning", "Threads native results unavailable for this query — showing Facebook/Reference results (won't be tagged on Threads).")}
          </span>
        </div>
      )}

      {platform === "instagram" &&
        showDropdown &&
        results.length > 0 &&
        results.every((r) => !isSelectableForPlatform(r, "instagram")) && (
          <div className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              {t("location.instagramNoTaggableWarning", "No Instagram-taggable location found for this search. The results shown are reference-only and will not appear on the published Instagram post. Try a more specific official place name (mall, restaurant, landmark, or city).")}
            </span>
          </div>
        )}

      {platform === "threads" &&
        showDropdown &&
        results.length > 0 &&
        results.every((r) => !isSelectableForPlatform(r, "threads")) && (
          <div className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              {t("location.threadsNoTaggableWarning", "No Threads-taggable location found for this search. The results shown are reference-only and will not appear on the published Threads post. Threads requires native Threads location results.")}
            </span>
          </div>
        )}
    </div>
  );
}

function isTaggableForPlatform(p: PlaceResult, platform: LocationAutocompleteProps["platform"]): boolean {
  if (String(p.id).startsWith("osm_") || p.source === "nominatim") return false;
  if (platform === "threads") return p.source === "threads" && p.taggable_on_threads === true;
  if (platform === "instagram") return p.taggable_on_instagram !== false; // unverified counts as taggable for sort
  if (platform === "facebook") return p.taggable_on_facebook !== false;
  return true;
}
