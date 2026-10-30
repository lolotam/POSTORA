import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useMediaUploadLimitsState, useSaveMediaUploadLimits } from "@/features/media-upload";
import { UPLOAD_LIMIT_OPTIONS_MB, type UploadLimits } from "@/lib/mediaTypes";

const LIMIT_FIELDS = [
  { field: "image_max_mb", label: "Maximum image size", options: UPLOAD_LIMIT_OPTIONS_MB.image },
  { field: "video_max_mb", label: "Maximum video size", options: UPLOAD_LIMIT_OPTIONS_MB.video },
] as const;

/** Admin → Settings → Media upload limits: the largest image and video any user may upload. */
export function MediaUploadLimitsSettings() {
  const { toast } = useToast();
  const { limits: saved, status, retry } = useMediaUploadLimitsState();
  const save = useSaveMediaUploadLimits();
  // Until the stored row is read the editor shows the defaults, and saving them would
  // overwrite the admin's real choice.
  const loaded = status === "ready";
  const [draft, setDraft] = useState<UploadLimits>(saved);

  // Follow the stored values once they load. Keyed on the numbers, not the object,
  // so a fresh object with the same values does not reset an edit in progress.
  const { image_max_mb: savedImage, video_max_mb: savedVideo } = saved;
  useEffect(() => {
    setDraft({ image_max_mb: savedImage, video_max_mb: savedVideo });
  }, [savedImage, savedVideo]);

  const changed = draft.image_max_mb !== saved.image_max_mb || draft.video_max_mb !== saved.video_max_mb;

  const onSave = () => {
    save.mutate(draft, {
      onSuccess: () => toast({ title: "Upload limits saved" }),
      onError: (error) => toast({
        title: "Could not save upload limits",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      }),
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Media upload limits</CardTitle>
        <CardDescription>
          The largest image and video a user may upload. Files over 10 MB go straight from the browser to the storage provider.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          {LIMIT_FIELDS.map(({ field, label, options }) => (
            <div className="space-y-2" key={field}>
              <Label htmlFor={`upload-limit-${field}`}>{label}</Label>
              <Select
                disabled={!loaded}
                value={String(draft[field])}
                onValueChange={(value) => setDraft((current) => ({ ...current, [field]: Number(value) }))}
              >
                <SelectTrigger id={`upload-limit-${field}`} aria-label={label}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {options.map((megabytes) => (
                    <SelectItem key={megabytes} value={String(megabytes)}>
                      {megabytes} MB
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>

        <div className="rounded-md border p-3 text-xs text-muted-foreground space-y-1">
          <p className="font-medium text-foreground">Postora cannot check these for you:</p>
          <p>Openinary's <code>MAX_FILE_SIZE_MB</code> must be at least the video limit (its default is 50).</p>
          <p>Above 100 MB, the Openinary upload host must not be proxied by Cloudflare (set <code>OPENINARY_UPLOAD_URL</code>).</p>
          <p>Cloudinary's plan caps file size (free plan: images 10 MB, video 100 MB); over it only the Openinary copy is kept.</p>
          <p>1000 MB and 2000 MB videos need more memory on the Openinary server, and a 2 GB upload must finish within one hour.</p>
        </div>

        {status === "loading" && <p className="text-sm text-muted-foreground">Loading the current limits…</p>}
        {status === "error" && (
          <div role="alert" className="flex items-center gap-3 text-sm text-destructive">
            <span>Could not load the current limits.</span>
            <Button variant="outline" size="sm" onClick={retry}>Retry</Button>
          </div>
        )}

        <Button onClick={onSave} disabled={!loaded || !changed || save.isPending}>
          {save.isPending ? "Saving…" : "Save limits"}
        </Button>
      </CardContent>
    </Card>
  );
}
