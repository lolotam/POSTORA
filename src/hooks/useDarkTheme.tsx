import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export function useDarkTheme() {
  const { data: themeVariant = "dark-purple-magenta" } = useQuery({
    queryKey: ["dark-theme-setting"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", "dark_theme_variant")
        .maybeSingle();

      if (error) {
        console.warn("Error fetching theme:", error.message);
        return "dark-purple-magenta";
      }

      if (data?.value) {
        const parsed = typeof data.value === "string" ? JSON.parse(data.value) : data.value;
        return parsed as string;
      }
      return "dark-purple-magenta";
    },
    staleTime: 1000 * 60 * 5, // Cache for 5 minutes
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-dark-theme", themeVariant);
  }, [themeVariant]);

  return themeVariant;
}
