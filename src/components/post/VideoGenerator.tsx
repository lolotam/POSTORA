import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Clapperboard, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useAiGenerationJob } from "@/hooks/useAiGenerationJob";
import { CAMERA_MOTION_PRESETS, buildVideoPrompt } from "@/lib/higgsfieldModels";
import {
  defaultParamsFor,
  mergeModelSpec,
  missingRequiredParams,
  paramLabel,
  resolveAspectRatio,
  resolveDuration,
  type HiggsfieldModelSpec,
} from "@/lib/higgsfieldModelSpecs";

export interface VideoGeneratorProps {
  onVideoGenerated: (videoUrl: string) => void;
  triggerClassName?: string;
  triggerLabel?: string;
}
type VideoModel = {
  model_id: string;
  name?: string;
  metadata?: unknown;
  capabilities?: string[];
};
export function VideoGenerator({
  onVideoGenerated,
  triggerClassName,
  triggerLabel,
}: VideoGeneratorProps) {
  const { t } = useTranslation("postmedia");
  const finalTriggerLabel = triggerLabel ?? t("videoGen.triggerLabel", "Create video with AI");
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [models, setModels] = useState<VideoModel[]>([]);
  const [modelId, setModelId] = useState("");
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [duration, setDuration] = useState(5);
  const [motion, setMotion] = useState("static");
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [jobId, setJobId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const job = useAiGenerationJob(jobId);
  useEffect(() => {
    if (!open) return;
    void supabase
      .from("ai_models")
      .select("model_id,name,metadata,capabilities,is_active")
      .eq("is_active", true)
      .contains("capabilities", ["video"])
      .then(({ data }) => {
        const rows = data ?? [];
        setModels(rows);
        if (!modelId && rows[0]) setModelId(rows[0].model_id);
      });
  }, [open, modelId]);
  const selected = models.find((m) => m.model_id === modelId);
  const spec: HiggsfieldModelSpec | null = useMemo(
    () => (modelId ? mergeModelSpec(modelId, selected?.metadata ?? null, "video") : null),
    [modelId, selected?.metadata],
  );
  useEffect(() => {
    if (!spec) return;
    setParams(defaultParamsFor(spec));
    setAspectRatio((value) => resolveAspectRatio(spec, value) ?? spec.aspectRatios[0] ?? value);
    setDuration((value) => resolveDuration(spec, value) ?? value);
  }, [spec]);
  const submit = async () => {
    if (!prompt.trim() || !modelId || !spec)
      return toast({ title: t("videoGen.toastPromptAndModel", "Add a prompt and choose a model"), variant: "destructive" });
    const missing = missingRequiredParams(spec, params);
    if (missing.length)
      return toast({
        title: t("videoGen.toastMissingSettings", "Missing model settings"),
        description: missing.map(paramLabel).join(", "),
        variant: "destructive",
      });
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke("generate-video", {
        body: {
          prompt: buildVideoPrompt(prompt, motion),
          model_id: modelId,
          aspect_ratio: aspectRatio,
          duration: Number.isFinite(duration)
            ? Math.min(spec.durationRange?.max ?? duration, Math.max(spec.durationRange?.min ?? duration, duration))
            : undefined,
          params,
        },
      });
      if (error || data?.error) throw error ?? new Error(data.error);
      setJobId(data.jobId);
      toast({ title: t("videoGen.toastStarted", "Video generation started") });
    } catch (e) {
      toast({
        title: t("videoGen.toastFailed", "Could not start video"),
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" className={triggerClassName}>
          <Clapperboard className="me-2 h-4 w-4" />
          {finalTriggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("videoGen.title", "Generate video for this post")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{t("videoGen.describeVideo", "Describe the video")}</Label>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder={t("videoGen.promptPlaceholder", "A cinematic product reveal with soft studio light")}
            />
          </div>
          <div className="space-y-2">
            <Label>{t("videoGen.model", "Model")}</Label>
            <Select value={modelId} onValueChange={setModelId}>
              <SelectTrigger>
                <SelectValue placeholder={t("videoGen.selectModelPlaceholder", "Select a video model")} />
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m.model_id} value={m.model_id}>
                    {m.name || m.model_id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {spec && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>{t("videoGen.cameraMotion", "Camera motion")}</Label>
                  <Select value={motion} onValueChange={setMotion}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CAMERA_MOTION_PRESETS.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {spec.aspectRatios.length > 0 && (
                  <div className="space-y-2">
                    <Label>{t("videoGen.aspectRatio", "Aspect ratio")}</Label>
                    <Select value={aspectRatio} onValueChange={setAspectRatio}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {spec.aspectRatios.map((r) => (
                          <SelectItem key={r} value={r}>
                            {r}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
              {(spec.durations || spec.durationRange) && (
                <div className="space-y-2">
                  <Label>{t("videoGen.duration", "Duration (seconds)")}</Label>
                  <Input
                    type="number"
                    value={duration}
                    min={spec.durationRange?.min}
                    max={spec.durationRange?.max}
                    onChange={(e) => setDuration(Number(e.target.value))}
                  />
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                {spec.parameters.map((parameter) => (
                  <div className="space-y-2" key={parameter.name}>
                    <Label>
                      {parameter.name}
                      {parameter.required ? " *" : ""}
                    </Label>
                    {parameter.type === "bool" ? (
                      <Select
                        value={String(params[parameter.name] ?? parameter.default ?? false)}
                        onValueChange={(v) =>
                          setParams((p) => ({ ...p, [parameter.name]: v === "true" }))
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="true">{t("videoGen.on", "On")}</SelectItem>
                          <SelectItem value="false">{t("videoGen.off", "Off")}</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : parameter.options ? (
                      <Select
                        value={String(params[parameter.name] ?? parameter.default ?? "")}
                        onValueChange={(v) => setParams((p) => ({ ...p, [parameter.name]: v }))}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {parameter.options.map((v) => (
                            <SelectItem key={v} value={v}>
                              {v}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        type={parameter.type === "number" ? "number" : "text"}
                        value={String(params[parameter.name] ?? parameter.default ?? "")}
                        onChange={(e) =>
                          setParams((p) => ({
                            ...p,
                            [parameter.name]:
                              parameter.type === "number" ? Number(e.target.value) : e.target.value,
                          }))
                        }
                      />
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
          <Button
            className="w-full"
            onClick={() => void submit()}
            disabled={submitting || job.isPolling || !models.length}
          >
            {submitting || job.isPolling ? (
              <>
                <Loader2 className="me-2 h-4 w-4 animate-spin" />
                {job.isPolling
                  ? t("videoGen.renderingSeconds", "Rendering… {{seconds}}s", { seconds: job.elapsedSeconds })
                  : t("videoGen.submitting", "Submitting…")}
              </>
            ) : (
              t("videoGen.generateBtn", "Generate video")
            )}
          </Button>
          {job.error && (
            <p className="rounded border border-destructive/30 bg-destructive/10 p-3 text-sm">
              {job.error}
            </p>
          )}
          {job.videoUrl && (
            <div className="space-y-3">
              <video src={job.videoUrl} controls className="w-full rounded border" />
              <Button
                className="w-full"
                onClick={() => {
                  onVideoGenerated(job.videoUrl!);
                  setOpen(false);
                }}
              >
                {t("videoGen.attachBtn", "Attach video to post")}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
export default VideoGenerator;
