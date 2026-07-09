import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export const DEFAULT_APP_THEME = "default";
export const APP_THEME_ATTRIBUTE = "data-app-theme";

/** app_settings values may be stored as plain strings or JSON-encoded strings. */
export function parseSettingValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") return String(value);
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
}

export function useAppTheme() {
  const { data: appTheme = DEFAULT_APP_THEME } = useQuery({
    queryKey: ["app-theme-setting"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", "app_theme")
        .maybeSingle();

      if (error) {
        console.warn("Error fetching app theme:", error.message);
        return DEFAULT_APP_THEME;
      }

      return parseSettingValue(data?.value) ?? DEFAULT_APP_THEME;
    },
    staleTime: 1000 * 60 * 5, // Cache for 5 minutes
  });

  useEffect(() => {
    if (appTheme === DEFAULT_APP_THEME) {
      document.documentElement.removeAttribute(APP_THEME_ATTRIBUTE);
    } else {
      document.documentElement.setAttribute(APP_THEME_ATTRIBUTE, appTheme);
    }
  }, [appTheme]);

  return appTheme;
}
