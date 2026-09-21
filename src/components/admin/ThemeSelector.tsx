import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Loader2, Palette, Moon, Sparkles, Zap, Leaf, Monitor, MessageCircle, type LucideIcon } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { DEFAULT_APP_THEME, APP_THEME_ATTRIBUTE, parseSettingValue } from "@/hooks/useAppTheme";

interface ThemeOption {
  id: string;
  name: string;
  description: string;
  icon: LucideIcon;
  preview: {
    bg: string;
    primary: string;
    accent: string;
  };
}

const THEME_OPTIONS: ThemeOption[] = [
  {
    id: "dark-black",
    name: "Dark Black",
    description: "Classic dark theme with pure black backgrounds and subtle contrasts",
    icon: Moon,
    preview: {
      bg: "hsl(0 0% 5%)",
      primary: "hsl(220 90% 56%)",
      accent: "hsl(250 85% 60%)",
    },
  },
  {
    id: "dark-blue-cyan",
    name: "Futuristic Blue",
    description: "Deep navy backgrounds with bright cyan accents and enhanced glow effects",
    icon: Zap,
    preview: {
      bg: "hsl(210 80% 8%)",
      primary: "hsl(195 100% 50%)",
      accent: "hsl(190 100% 45%)",
    },
  },
  {
    id: "dark-purple-magenta",
    name: "Neon Purple",
    description: "Purple-to-magenta gradient with cyan accents and multi-color gradient glows",
    icon: Sparkles,
    preview: {
      bg: "hsl(260 60% 8%)",
      primary: "hsl(280 80% 60%)",
      accent: "hsl(320 90% 55%)",
    },
  },
  {
    id: "dark-neon-green",
    name: "Neon Green",
    description: "Vibrant neon green with dark backgrounds and electric glow effects",
    icon: Leaf,
    preview: {
      bg: "hsl(120 30% 5%)",
      primary: "hsl(100 80% 50%)",
      accent: "hsl(85 90% 45%)",
    },
  },
];

const APP_THEME_OPTIONS: ThemeOption[] = [
  {
    id: DEFAULT_APP_THEME,
    name: "Postora Classic",
    description: "The standard Postora look with blue and purple accents",
    icon: Monitor,
    preview: {
      bg: "hsl(0 0% 100%)",
      primary: "hsl(199 89% 48%)",
      accent: "hsl(262 83% 58%)",
    },
  },
  {
    id: "whatsapp-green",
    name: "WhatsApp Green",
    description: "Teal header with green accents, cloned from the WhatsApp mini-app",
    icon: MessageCircle,
    preview: {
      bg: "hsl(174 86% 20%)",
      primary: "hsl(142 70% 49%)",
      accent: "hsl(94 78% 87%)",
    },
  },
];

function ThemeOptionLabel({
  theme,
  isSelected,
  radioId,
}: {
  theme: ThemeOption;
  isSelected: boolean;
  radioId: string;
}) {
  const Icon = theme.icon;

  return (
    <Label
      htmlFor={radioId}
      className={`
        relative flex flex-col gap-3 p-4 rounded-xl border-2 cursor-pointer
        transition-all duration-300 ease-out
        ${isSelected
          ? "border-primary bg-primary/5 shadow-lg shadow-primary/20 scale-[1.02]"
          : "border-border hover:border-primary/50 hover:bg-muted/50"
        }
      `}
    >
      <RadioGroupItem value={theme.id} id={radioId} className="sr-only" />

      {/* Theme Preview */}
      <div
        className="w-full h-20 rounded-lg overflow-hidden relative border border-border"
        style={{ backgroundColor: theme.preview.bg }}
      >
        <div
          className="absolute top-2 start-2 w-8 h-8 rounded-lg"
          style={{ backgroundColor: theme.preview.primary }}
        />
        <div
          className="absolute bottom-2 end-2 w-12 h-4 rounded"
          style={{ backgroundColor: theme.preview.accent }}
        />
        <div
          className="absolute top-2 end-2 w-6 h-6 rounded-full opacity-60"
          style={{
            background: `radial-gradient(circle, ${theme.preview.primary} 0%, transparent 70%)`,
          }}
        />
      </div>

      {/* Theme Info */}
      <div className="flex items-start gap-2">
        <Icon className={`w-5 h-5 mt-0.5 ${isSelected ? "text-primary" : "text-muted-foreground"}`} />
        <div className="flex-1 min-w-0">
          <p className={`font-medium ${isSelected ? "text-primary" : ""}`}>
            {theme.name}
          </p>
          <p className="text-xs text-muted-foreground line-clamp-2">
            {theme.description}
          </p>
        </div>
      </div>

      {/* Selected Indicator */}
      {isSelected && (
        <div className="absolute top-2 end-2 w-5 h-5 rounded-full bg-primary flex items-center justify-center">
          <svg className="w-3 h-3 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
          </svg>
        </div>
      )}
    </Label>
  );
}

async function fetchSetting(key: string, fallback: string): Promise<string> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", key)
    .single();

  if (error && error.code !== "PGRST116") throw error;

  return parseSettingValue(data?.value) ?? fallback;
}

async function saveSetting(key: string, value: string, description: string) {
  const { data: existing } = await supabase
    .from("app_settings")
    .select("id")
    .eq("key", key)
    .single();

  if (existing) {
    const { error } = await supabase
      .from("app_settings")
      .update({ value: JSON.stringify(value) })
      .eq("key", key);
    if (error) throw error;
  } else {
    const { error } = await supabase
      .from("app_settings")
      .insert({ key, value: JSON.stringify(value), description });
    if (error) throw error;
  }
}

export function ThemeSelector() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedTheme, setSelectedTheme] = useState("dark-purple-magenta");
  const [selectedAppTheme, setSelectedAppTheme] = useState(DEFAULT_APP_THEME);

  const { data: themeSetting, isLoading } = useQuery({
    queryKey: ["dark-theme-setting"],
    queryFn: () => fetchSetting("dark_theme_variant", "dark-purple-magenta"),
  });

  const { data: appThemeSetting, isLoading: isAppThemeLoading } = useQuery({
    queryKey: ["app-theme-setting"],
    queryFn: () => fetchSetting("app_theme", DEFAULT_APP_THEME),
  });

  useEffect(() => {
    if (themeSetting) {
      setSelectedTheme(themeSetting);
      applyTheme(themeSetting);
    }
  }, [themeSetting]);

  useEffect(() => {
    if (appThemeSetting) {
      setSelectedAppTheme(appThemeSetting);
      applyAppTheme(appThemeSetting);
    }
  }, [appThemeSetting]);

  const applyTheme = (themeId: string) => {
    document.documentElement.setAttribute("data-dark-theme", themeId);
  };

  const applyAppTheme = (themeId: string) => {
    if (themeId === DEFAULT_APP_THEME) {
      document.documentElement.removeAttribute(APP_THEME_ATTRIBUTE);
    } else {
      document.documentElement.setAttribute(APP_THEME_ATTRIBUTE, themeId);
    }
  };

  const updateThemeMutation = useMutation({
    mutationFn: (themeId: string) =>
      saveSetting("dark_theme_variant", themeId, "Selected dark theme color variant"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dark-theme-setting"] });
      queryClient.invalidateQueries({ queryKey: ["app-settings-public"] });
      toast({ title: "Theme updated", description: "Dark theme variant has been saved" });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to save theme",
        variant: "destructive",
      });
    },
  });

  const updateAppThemeMutation = useMutation({
    mutationFn: (themeId: string) =>
      saveSetting("app_theme", themeId, "Admin-selected global app theme (default | whatsapp-green)"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["app-theme-setting"] });
      queryClient.invalidateQueries({ queryKey: ["app-settings-public"] });
      toast({ title: "App theme updated", description: "The app theme has been saved for all users" });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to save app theme",
        variant: "destructive",
      });
    },
  });

  const handleThemeChange = (themeId: string) => {
    setSelectedTheme(themeId);
    applyTheme(themeId);
    updateThemeMutation.mutate(themeId);
  };

  const handleAppThemeChange = (themeId: string) => {
    setSelectedAppTheme(themeId);
    applyAppTheme(themeId);
    updateAppThemeMutation.mutate(themeId);
  };

  if (isLoading || isAppThemeLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <Palette className="w-5 h-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-lg">App Theme</CardTitle>
              <CardDescription>Choose the global look applied to all users across the app</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <RadioGroup
            value={selectedAppTheme}
            onValueChange={handleAppThemeChange}
            className="grid gap-4 sm:grid-cols-3"
          >
            {APP_THEME_OPTIONS.map((theme) => (
              <ThemeOptionLabel
                key={theme.id}
                theme={theme}
                isSelected={selectedAppTheme === theme.id}
                radioId={`app-theme-${theme.id}`}
              />
            ))}
          </RadioGroup>

          {updateAppThemeMutation.isPending && (
            <div className="flex items-center gap-2 mt-4 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              Saving app theme...
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <Moon className="w-5 h-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-lg">Dark Theme Variant</CardTitle>
              <CardDescription>Choose a color scheme for dark mode</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <RadioGroup
            value={selectedTheme}
            onValueChange={handleThemeChange}
            className="grid gap-4 sm:grid-cols-3"
          >
            {THEME_OPTIONS.map((theme) => (
              <ThemeOptionLabel
                key={theme.id}
                theme={theme}
                isSelected={selectedTheme === theme.id}
                radioId={theme.id}
              />
            ))}
          </RadioGroup>

          {updateThemeMutation.isPending && (
            <div className="flex items-center gap-2 mt-4 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              Saving theme...
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
