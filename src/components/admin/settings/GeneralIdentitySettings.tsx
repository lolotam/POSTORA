import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bookmark, CreditCard, Globe, Image as ImageIcon, Loader2, RotateCcw, Save, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface AppSetting {
  id: string;
  key: string;
  value: unknown;
  description: string | null;
}

interface IdentityField {
  key: string;
  label: string;
  icon: LucideIcon;
  placeholder: string;
  /** Image fields upload to the CDN on save and show a preview with a reset control. */
  isImage?: boolean;
  /** Shown when the field is empty, so the preview says what users actually see. */
  fallbackSrc?: string;
}

const FIELDS: IdentityField[] = [
  { key: "app_name", label: "Application name", icon: Globe, placeholder: "My App" },
  { key: "app_logo", label: "Logo URL", icon: ImageIcon, placeholder: "https://example.com/logo.png", isImage: true },
  { key: "app_favicon", label: "Favicon URL", icon: Bookmark, placeholder: "https://example.com/favicon.png", isImage: true, fallbackSrc: "/favicon.png" },
  { key: "default_plan", label: "Default plan", icon: CreditCard, placeholder: "free" },
];

function parseStoredValue(value: unknown): string {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return typeof parsed === "string" ? parsed : JSON.stringify(parsed);
  } catch {
    return String(value ?? "");
  }
}

export function GeneralIdentitySettings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  // One entry per in-flight write. The mutation's own `variables` only ever describes
  // the most recent call, so saving a second field while the first is still running
  // would re-enable the first field's button and allow a concurrent, racing write.
  const [savingKeys, setSavingKeys] = useState<ReadonlySet<string>>(new Set());

  const { data: settings = [], isLoading, isError, error, refetch } = useQuery({
    queryKey: ["admin-settings"],
    queryFn: async (): Promise<AppSetting[]> => {
      const { data, error } = await supabase.from("app_settings").select("*").order("key");
      if (error) throw error;
      return data || [];
    },
  });

  const updateSetting = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string }) => {
      const { error } = await supabase
        .from("app_settings")
        .upsert(
          { key, value: JSON.stringify(value), updated_at: new Date().toISOString() },
          { onConflict: "key" },
        );
      if (error) throw error;
    },
    onMutate: ({ key }) => {
      setSavingKeys((prev) => new Set(prev).add(key));
    },
    onSettled: (_data, _error, { key }) => {
      setSavingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    },
    onSuccess: (_data, { key }) => {
      queryClient.invalidateQueries({ queryKey: ["admin-settings"] });
      queryClient.invalidateQueries({ queryKey: ["app-settings-public"] });
      setEdits((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      toast({ title: "Saved" });
    },
    onError: (error) => {
      toast({
        title: "Could not save",
        description: error instanceof Error ? error.message : "Try again.",
        variant: "destructive",
      });
    },
  });

  const isBusy = (key: string): boolean => uploadingKey === key || savingKeys.has(key);

  const storedValue = (key: string): string => {
    const setting = settings.find((s) => s.key === key);
    return setting ? parseStoredValue(setting.value) : "";
  };

  const fieldValue = (key: string): string => edits[key] ?? storedValue(key);

  /** Returns the CDN URL, or null when the copy failed and the user has been told why. */
  const uploadToCdn = async (key: string, sourceUrl: string): Promise<string | null> => {
    setUploadingKey(key);
    try {
      const { data, error } = await supabase.functions.invoke("cloudinary-upload", {
        body: { externalUrl: sourceUrl, fileName: key, fileType: "image" },
      });
      if (error) {
        // A non-2xx reply arrives as FunctionsHttpError with `data` null; the reason the
        // function gave (which provider refused the file, and why) is only on its Response.
        const envelope = error.context instanceof Response
          ? await error.context.clone().json().catch(() => null)
          : null;
        throw new Error(envelope?.error || "The image could not be copied to the CDN.");
      }
      if (!data?.success) {
        throw new Error(data?.error || "The image could not be copied to the CDN.");
      }
      return data.url as string;
    } catch (err) {
      toast({
        title: "Upload failed",
        description: err instanceof Error ? err.message : "The image could not be copied to the CDN.",
        variant: "destructive",
      });
      return null;
    } finally {
      setUploadingKey(null);
    }
  };

  const handleSave = async (field: IdentityField) => {
    const value = edits[field.key];
    if (value === undefined) return;

    // Logos and favicons are served from the CDN, so an entered URL is copied there
    // before the setting points at it. A failed upload must not store the origin URL.
    if (field.isImage && value.startsWith("http")) {
      const cdnUrl = await uploadToCdn(field.key, value);
      if (cdnUrl === null) return;
      updateSetting.mutate({ key: field.key, value: cdnUrl });
      return;
    }

    updateSetting.mutate({ key: field.key, value });
  };

  const handleReset = (key: string) => {
    updateSetting.mutate({ key, value: "" });
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  // A failed read leaves no rows, and the fields are a fixed list rather than a map over
  // what came back — so rendering the form here would show four blank inputs over live
  // values and invite an admin to "correct" them. Refuse until a read succeeds.
  if (isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-destructive" />
            Identity settings could not be loaded
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            These fields are hidden rather than shown blank, so nothing is saved over the
            current values by mistake. {error instanceof Error ? error.message : ""}
          </p>
          <Button variant="outline" onClick={() => refetch()} className="gap-2">
            <RotateCcw className="w-4 h-4" />
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="w-5 h-5" />
            Identity
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {FIELDS.map((field) => {
              const Icon = field.icon;
              const value = fieldValue(field.key);
              const hasChanges = edits[field.key] !== undefined;
              const busy = isBusy(field.key);
              const savedUrl = storedValue(field.key);

              return (
                <div key={field.key} className="space-y-2">
                  <Label htmlFor={`setting-${field.key}`} className="flex items-center gap-2">
                    <Icon className="w-4 h-4 text-muted-foreground" />
                    {field.label}
                  </Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id={`setting-${field.key}`}
                      value={value}
                      onChange={(e) => setEdits((prev) => ({ ...prev, [field.key]: e.target.value }))}
                      placeholder={field.placeholder}
                      className="flex-1"
                    />
                    <Button
                      onClick={() => handleSave(field)}
                      disabled={!hasChanges || busy}
                      className="gap-2"
                    >
                      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                      Save
                    </Button>
                    {field.isImage && savedUrl && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleReset(field.key)}
                        disabled={busy}
                        title="Reset to default"
                      >
                        <RotateCcw className="w-4 h-4" />
                      </Button>
                    )}
                  </div>

                  {field.isImage && (
                    <button
                      type="button"
                      className="flex items-center gap-3 rounded-md border bg-muted/30 p-2 w-full text-left transition-opacity hover:opacity-80"
                      onClick={() => {
                        const src = savedUrl || field.fallbackSrc;
                        if (src) setPreviewImage(src);
                      }}
                    >
                      {savedUrl || field.fallbackSrc ? (
                        <img
                          src={savedUrl || field.fallbackSrc}
                          alt={`${field.label} preview`}
                          className="w-10 h-10 object-contain"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.visibility = "hidden";
                          }}
                        />
                      ) : (
                        <span className="w-10 h-10 rounded bg-primary/10 flex items-center justify-center">
                          <ImageIcon className="w-4 h-4 text-primary" />
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {savedUrl ? "Custom — click to enlarge" : "Using the default"}
                      </span>
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!previewImage} onOpenChange={(open) => !open && setPreviewImage(null)}>
        <DialogContent className="max-w-md flex items-center justify-center p-6">
          {previewImage && (
            <img src={previewImage} alt="Preview" className="max-w-full max-h-[400px] object-contain rounded" />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
