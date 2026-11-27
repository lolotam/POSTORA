import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ResolvedModelCards, type ResolvedTier } from "@/components/ai/ResolvedModelCards";
import { MediaLibraryPicker } from "@/components/post/MediaLibraryPicker";
import { StockMediaPicker, type SelectedMedia } from "@/components/post/StockMediaPicker";
import { handleAIError } from "@/lib/aiErrorHandler";
import type { UploadedFile } from "@/hooks/usePostForm";
import type { YouTubeCapabilityReason, YouTubeCapabilityState } from "../domain/types";
import {
  THUMBNAIL_MAX_BYTES,
  checkThumbnailFile,
  isDirectThumbnailCandidate,
  isThumbnailFileFailure,
  type YouTubeThumbnailCandidate,
  type YouTubeThumbnailOutcome,
} from "../domain/thumbnail";

export interface YouTubeThumbnailChangeProps {
  /** The server's derived capability; never a client-side flag. */
  capability: YouTubeCapabilityState | null;
  /** The creator's own library images; the picker filters them. */
  candidates: readonly YouTubeThumbnailCandidate[];
  candidatesLoading: boolean;
  candidatesError: unknown;
  onRetryCandidates?: () => void;
  /** Injected write seam; the call is made once per confirmed choice. */
  onSetThumbnail?: (mediaFileId: string) => Promise<YouTubeThumbnailOutcome>;
  /** The thumbnail the video shows today, so the creator sees what changes. */
  currentThumbnailUrl?: string | null;
  /** Stores an image the creator picked on this device. */
  onUploadImage?: (params: {
    blob: Blob;
    fileName: string;
    mimeType: "image/jpeg" | "image/png";
  }) => Promise<YouTubeThumbnailCandidate>;
  /** Generates an image with the app's own image generator. */
  onGenerateAiImage?: (params: { prompt: string; referenceImage?: string }) => Promise<{ imageUrl: string }>;
  /** Turns a generated image into a storable thumbnail. */
  prepareAiImageBlob?: (imageUrl: string) => Promise<{ blob: Blob; mimeType: "image/jpeg" | "image/png" }>;
  /** Configured image generation model tiers to display in the AI tab. */
  resolvedImageTiers?: readonly ResolvedTier[];
}

/** Why the control is disabled, in the creator's words. */
function ThumbnailUnavailableReason({ reason }: { reason: YouTubeCapabilityReason | null }): JSX.Element {
  const { t } = useTranslation("accounts");
  let message: string;
  switch (reason) {
    case "reconnect_required":
      message = t(
        "youtubeManagement.thumbnail.reconnectRequired",
        "This channel needs to be reconnected before changing thumbnails is available.",
      );
      break;
    case "missing_scope":
      message = t(
        "youtubeManagement.thumbnail.missingScope",
        "Reconnect this channel and grant YouTube upload permissions to change thumbnails.",
      );
      break;
    case "provider_unsupported":
      message = t(
        "youtubeManagement.thumbnail.providerUnsupported",
        "Changing thumbnails is not available for managed connections.",
      );
      break;
    default:
      message = t(
        "youtubeManagement.thumbnail.unavailable",
        "Changing thumbnails is currently unavailable for this channel.",
      );
      break;
  }
  return <p className="text-xs text-muted-foreground">{message}</p>;
}

/** A file size the creator can read at a glance. */
function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The 96 px preview of the thumbnail the video shows. */
function ThumbnailPreview({ url, note }: { url: string | null; note: string | null }): JSX.Element {
  const { t } = useTranslation("accounts");
  return (
    <div className="space-y-1">
      <div className="aspect-video w-24 overflow-hidden rounded border bg-muted">
        {url ? (
          <img
            src={url}
            alt={t("youtubeManagement.thumbnail.dialog.previewAlt", "Thumbnail preview")}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : null}
      </div>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}

/** The one image list the creator may choose from. */
function ThumbnailImageChoices({
  candidates,
  selectedId,
  disabled,
  onSelect,
}: {
  candidates: readonly YouTubeThumbnailCandidate[];
  selectedId: string;
  disabled: boolean;
  onSelect: (id: string) => void;
}): JSX.Element {
  return (
    <RadioGroup value={selectedId} onValueChange={onSelect} disabled={disabled}>
      {candidates.map((candidate) => (
        <label key={candidate.id} className="flex items-center gap-2">
          <RadioGroupItem value={candidate.id} aria-label={candidate.file_name} disabled={disabled} />
          {candidate.preview_url ? (
            <img src={candidate.preview_url} alt="" loading="lazy" className="h-9 w-16 rounded object-cover" />
          ) : null}
          <span className="text-sm">{candidate.file_name}</span>
          <span className="text-xs text-muted-foreground">{formatBytes(candidate.file_size)}</span>
        </label>
      ))}
    </RadioGroup>
  );
}

/** The library, or the one sentence that explains why it cannot be shown. */
function ThumbnailPickerBody({
  candidates,
  loading,
  error,
  onRetry,
  selectedId,
  disabled,
  onSelect,
}: {
  candidates: readonly YouTubeThumbnailCandidate[];
  loading: boolean;
  error: unknown;
  onRetry?: () => void;
  selectedId: string;
  disabled: boolean;
  onSelect: (id: string) => void;
}): JSX.Element {
  const { t } = useTranslation("accounts");
  if (error !== null && error !== undefined) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          {t("youtubeManagement.thumbnail.libraryError", "Postora could not read your media library. Nothing was changed.")}
        </p>
        {onRetry ? (
          <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onRetry}>
            {t("youtubeManagement.thumbnail.retryLibrary", "Retry loading images")}
          </Button>
        ) : null}
      </div>
    );
  }
  if (loading) {
    return <p className="text-xs text-muted-foreground">{t("youtubeManagement.thumbnail.loading", "Loading your images…")}</p>;
  }
  if (candidates.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {t(
          "youtubeManagement.thumbnail.noEligible",
          "Your media library has no JPEG or PNG image to use as a thumbnail.",
        )}
      </p>
    );
  }
  return <ThumbnailImageChoices candidates={candidates} selectedId={selectedId} disabled={disabled} onSelect={onSelect} />;
}

/** The explicit confirmation: the thumbnail is what viewers see on YouTube. */
function ThumbnailConfirmation({
  candidate,
  busy,
  onConfirm,
  onCancel,
}: {
  candidate: YouTubeThumbnailCandidate;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  const { t } = useTranslation("accounts");
  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="text-xs font-medium">
        {t("youtubeManagement.thumbnail.chosen", "New thumbnail: {{name}}", { name: candidate.file_name })}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("youtubeManagement.thumbnail.confirmPrompt", "This replaces the thumbnail viewers see on YouTube")}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={onConfirm}>
          {t("youtubeManagement.thumbnail.confirm", "Confirm thumbnail change")}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onCancel}>
          {t("common:cancel", "Cancel")}
        </Button>
      </div>
    </div>
  );
}

/** What one attempt produced, in words the creator can act on. */
function ThumbnailOutcomeMessage({ outcome }: { outcome: YouTubeThumbnailOutcome }): JSX.Element {
  const { t } = useTranslation("accounts");
  let message: string;
  switch (outcome) {
    case "applied":
      message = t("youtubeManagement.thumbnail.applied", "Thumbnail updated on YouTube.");
      break;
    case "thumbnail_not_allowed":
      message = t(
        "youtubeManagement.thumbnail.thumbnailNotAllowed",
        "This YouTube channel is not eligible to set custom thumbnails.",
      );
      break;
    case "media_not_usable":
      message = t(
        "youtubeManagement.thumbnail.mediaNotUsable",
        "This image cannot be used. Choose a JPEG or PNG image under 2 MB from your library.",
      );
      break;
    case "rate_limited":
    case "quota_exceeded":
      message = t("youtubeManagement.thumbnail.writeLimit", "Thumbnail write limit reached. Try again later.");
      break;
    case "refused":
      message = t(
        "youtubeManagement.thumbnail.refused",
        "Thumbnail could not be updated. Nothing was changed on YouTube.",
      );
      break;
    default:
      message = t("youtubeManagement.thumbnail.outcomeUnknown", "YouTube may have applied it. Refresh to check.");
      break;
  }
  return (
    <p role="status" className="text-xs text-muted-foreground">
      {message}
    </p>
  );
}

/**
 * Turns a generated image into a storable thumbnail.
 *
 * The generator may answer with any size and any format, and YouTube accepts
 * neither: the image is drawn to a 1280x720 canvas with a cover fit and
 * encoded as JPEG at a falling quality until it fits under 2 MB.
 */
async function prepareGeneratedThumbnail(imageUrl: string): Promise<{ blob: Blob; mimeType: "image/jpeg" | "image/png" }> {
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error("The generated image could not be fetched");
  const source = await createImageBitmap(await response.blob());
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  try {
    if (source.width <= 0 || source.height <= 0) {
      throw new Error("The generated image has invalid dimensions");
    }
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The browser could not draw the generated image");
    const scale = Math.max(canvas.width / source.width, canvas.height / source.height);
    const width = source.width * scale;
    const height = source.height * scale;
    context.drawImage(source, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
  } finally {
    source.close?.();
  }
  for (const quality of [0.9, 0.8, 0.7, 0.6, 0.5]) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (blob && blob.size <= THUMBNAIL_MAX_BYTES) return { blob, mimeType: "image/jpeg" };
  }
  throw new Error("The generated image could not be brought under 2 MB");
}

/** The file the creator picked on this device. */
function UploadFileTab({
  disabled,
  errorMessage,
  onFile,
}: {
  disabled: boolean;
  errorMessage: string | null;
  onFile: (file: File | undefined) => void;
}): JSX.Element {
  const { t } = useTranslation("accounts");
  const inputId = useId();
  return (
    <div className="space-y-2">
      <label htmlFor={inputId} className="text-xs font-medium">
        {t("youtubeManagement.thumbnail.dialog.uploadLabel", "Choose a JPEG or PNG image")}
      </label>
      <input
        id={inputId}
        type="file"
        accept="image/jpeg,image/png"
        disabled={disabled}
        onChange={(event) => onFile(event.target.files?.[0])}
        className="text-xs"
      />
      {errorMessage ? <p className="text-xs text-muted-foreground">{errorMessage}</p> : null}
    </div>
  );
}

/** The generator, its prompt and the reference images it works from. */
function GenerateWithAiTab({
  disabled,
  canGenerate,
  resolvedTiers,
  prompt,
  onPromptChange,
  references,
  onReferenceFiles,
  onRemoveReference,
  libraryCandidates,
  onUseLibraryReference,
  onOpenLibraryPicker,
  onOpenStockPicker,
  onGenerate,
  generatedImageUrl,
  onUseGeneratedImage,
  errorMessage,
}: {
  disabled: boolean;
  canGenerate: boolean;
  resolvedTiers: ResolvedTier[];
  prompt: string;
  onPromptChange: (prompt: string) => void;
  references: string[];
  onReferenceFiles: (files: FileList | null) => void;
  onRemoveReference: (index: number) => void;
  libraryCandidates: readonly YouTubeThumbnailCandidate[];
  onUseLibraryReference: (previewUrl: string) => void;
  onOpenLibraryPicker: () => void;
  onOpenStockPicker: () => void;
  onGenerate: () => void;
  generatedImageUrl: string | null;
  onUseGeneratedImage: () => void;
  errorMessage: string | null;
}): JSX.Element {
  const { t } = useTranslation("accounts");
  const promptInputId = useId();
  const referenceInputId = useId();
  return (
    <div className="space-y-2">
      <ResolvedModelCards tiers={resolvedTiers} />
      <label htmlFor={promptInputId} className="text-xs font-medium">
        {t("youtubeManagement.thumbnail.dialog.promptLabel", "Describe the thumbnail")}
      </label>
      <textarea
        id={promptInputId}
        value={prompt}
        disabled={disabled}
        onChange={(event) => onPromptChange(event.target.value)}
        className="min-h-20 w-full rounded-md border bg-background p-2 text-sm"
      />
      <label htmlFor={referenceInputId} className="text-xs font-medium">
        {t("youtubeManagement.thumbnail.dialog.referenceLabel", "Reference images (up to five)")}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={referenceInputId}
          type="file"
          accept="image/*"
          multiple
          disabled={disabled || references.length >= 5}
          onChange={(event) => onReferenceFiles(event.target.files)}
          className="text-xs"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || references.length >= 5}
          onClick={onOpenLibraryPicker}
        >
          {t("youtubeManagement.thumbnail.dialog.tabLibrary", "Media library")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || references.length >= 5}
          onClick={onOpenStockPicker}
        >
          {t("youtubeManagement.thumbnail.dialog.stockReference", "Stock")}
        </Button>
      </div>
      {references.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {references.map((reference, index) => (
            <div key={`${index}:${reference}`} className="relative">
              <img src={reference} alt="" className="h-9 w-16 rounded object-cover" />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={disabled}
                className="h-5 px-1 text-[10px]"
                onClick={() => onRemoveReference(index)}
              >
                ×
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      {libraryCandidates.length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs font-medium">
            {t("youtubeManagement.thumbnail.dialog.libraryReferenceLabel", "Or use one of your own images")}
          </p>
          <div className="flex flex-wrap gap-2">
            {libraryCandidates.map((candidate) => (
              <Button
                key={candidate.id}
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled || !candidate.preview_url || references.length >= 5}
                onClick={() => candidate.preview_url && onUseLibraryReference(candidate.preview_url)}
              >
                {candidate.file_name}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
      <Button type="button" size="sm" disabled={disabled || !canGenerate} onClick={onGenerate}>
        {t("youtubeManagement.thumbnail.dialog.generate", "Generate")}
      </Button>
      {generatedImageUrl ? (
        <div className="space-y-2">
          <img src={generatedImageUrl} alt="" className="w-full rounded border" />
          <Button type="button" size="sm" disabled={disabled} onClick={onUseGeneratedImage}>
            {t("youtubeManagement.thumbnail.dialog.useAiImage", "Use this AI thumbnail")}
          </Button>
        </div>
      ) : null}
      {errorMessage ? <p className="text-xs text-muted-foreground">{errorMessage}</p> : null}
    </div>
  );
}

/**
 * Replaces the thumbnail of a published video from the creator's own media.
 *
 * The flow is deliberately two steps: a pick, then an explicit confirmation,
 * because the thumbnail is what viewers see on YouTube. The write happens
 * exactly once per confirmed choice, and every outcome is stated in words
 * instead of leaving the creator guessing.
 */
export function YouTubeThumbnailChange({
  capability,
  candidates,
  candidatesLoading,
  candidatesError,
  onRetryCandidates,
  onSetThumbnail,
  currentThumbnailUrl,
  onUploadImage,
  onGenerateAiImage,
  prepareAiImageBlob = prepareGeneratedThumbnail,
  resolvedImageTiers = [],
}: YouTubeThumbnailChangeProps): JSX.Element {
  const { t, i18n } = useTranslation("accounts");
  const resolvedTiers = [...resolvedImageTiers];
  const [dialogOpen, setDialogOpen] = useState(false);
  const [tab, setTab] = useState("library");
  const [chosen, setChosen] = useState<YouTubeThumbnailCandidate | null>(null);
  const [appliedCandidate, setAppliedCandidate] = useState<YouTubeThumbnailCandidate | null>(null);
  const [outcome, setOutcome] = useState<YouTubeThumbnailOutcome | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiImageUrl, setAiImageUrl] = useState<string | null>(null);
  const [aiPrompt, setAiPrompt] = useState("");
  const [references, setReferences] = useState<string[]>([]);
  const [libraryPickerOpen, setLibraryPickerOpen] = useState(false);
  const [stockPickerOpen, setStockPickerOpen] = useState(false);

  const available = capability?.state === "available";
  // Only JPEG and PNG can be sent to `thumbnails.set`; everything else the
  // library holds is filtered out here and named in the notice below.
  const eligible = candidates.filter(isDirectThumbnailCandidate);
  const excludedCount = candidates.length - eligible.length;
  const unavailableReason = capability?.state === "unavailable" ? capability.reason : null;

  const openPicker = () => {
    if (submitting) return;
    setDialogOpen(true);
    setChosen(null);
    setOutcome(null);
    setUploadError(null);
    setAiError(null);
    setAiImageUrl(null);
    setAiPrompt("");
    setReferences([]);
  };

  const selectImage = (id: string) => {
    if (submitting) return;
    setChosen(eligible.find((candidate) => candidate.id === id) ?? null);
  };

  const confirm = async () => {
    if (!chosen || !onSetThumbnail || submitting) return;
    setSubmitting(true);
    try {
      const result = await onSetThumbnail(chosen.id);
      setOutcome(result);
      if (result === "applied") {
        setAppliedCandidate(chosen);
        setDialogOpen(false);
        setChosen(null);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpload = async (file: File | undefined) => {
    if (!file || !onUploadImage) return;
    setUploadError(null);
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const check = checkThumbnailFile({ declaredType: file.type, size: file.size, head });
    if (isThumbnailFileFailure(check)) {
      // The file is refused before it leaves the page: nothing is stored and
      // no request is made.
      setUploadError(check.reason);
      return;
    }
    setSubmitting(true);
    try {
      const candidate = await onUploadImage({ blob: file, fileName: file.name, mimeType: check.mimeType });
      setChosen(candidate);
    } catch {
      setUploadError("failed");
    } finally {
      setSubmitting(false);
    }
  };

  const handleGenerate = async () => {
    if (!onGenerateAiImage) return;
    setAiError(null);
    setSubmitting(true);
    try {
      const result = await onGenerateAiImage({
        prompt: aiPrompt,
        referenceImage: references[0],
      });
      setAiImageUrl(result.imageUrl);
    } catch (error) {
      setAiError("failed");
      handleAIError(error, "YouTube AI thumbnail");
    } finally {
      setSubmitting(false);
    }
  };

  const handleUseGeneratedImage = async () => {
    if (!aiImageUrl || !onUploadImage) return;
    setAiError(null);
    setSubmitting(true);
    try {
      const prepared = await prepareAiImageBlob(aiImageUrl);
      const head = new Uint8Array(await prepared.blob.slice(0, 16).arrayBuffer());
      const check = checkThumbnailFile({ declaredType: prepared.mimeType, size: prepared.blob.size, head });
      if (isThumbnailFileFailure(check)) throw new Error(check.reason);
      const candidate = await onUploadImage({
        blob: prepared.blob,
        fileName: "ai-thumbnail.jpg",
        mimeType: check.mimeType,
      });
      setChosen(candidate);
    } catch {
      // Nothing is stored and nothing is sent when the generated image cannot
      // become a thumbnail.
      setAiError("not_prepared");
    } finally {
      setSubmitting(false);
    }
  };

  const handleReferenceFiles = async (files: FileList | null) => {
    if (!files) return;
    const room = 5 - references.length;
    const picked = Array.from(files).slice(0, Math.max(room, 0));
    const dataUrls = await Promise.all(picked.map((file) => readAsDataUrl(file)));
    setReferences((current) => [...current, ...dataUrls].slice(0, 5));
  };

  const uploadErrorMessage = uploadError === "too_large"
    ? t("youtubeManagement.thumbnail.dialog.tooLarge", "That image is larger than 2 MB. Choose a smaller one.")
    : uploadError === "type_mismatch"
      ? t("youtubeManagement.thumbnail.dialog.typeMismatch", "That file is not the format it says it is. Choose a JPEG or a PNG.")
      : uploadError === "not_jpeg_png"
        ? t("youtubeManagement.thumbnail.dialog.notJpegPng", "YouTube accepts JPEG and PNG images only.")
        : uploadError === "failed"
          ? t("youtubeManagement.thumbnail.dialog.uploadFailed", "Postora could not store that image. Nothing was changed.")
          : null;

  const aiErrorMessage = aiError === "not_prepared"
    ? t("youtubeManagement.thumbnail.dialog.notPrepared", "This image could not be prepared as a thumbnail")
    : aiError === "failed"
      ? t("youtubeManagement.thumbnail.dialog.generateFailed", "The image could not be generated. Nothing was changed.")
      : null;

  const previewUrl = appliedCandidate?.preview_url ?? currentThumbnailUrl ?? null;
  const previewNote = appliedCandidate
    ? t("youtubeManagement.thumbnail.dialog.appliedNote", "YouTube may take a few minutes to show the new thumbnail")
    : null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex flex-col gap-2">
          <Button type="button" size="sm" variant="outline" disabled={!available || !onSetThumbnail || submitting} onClick={openPicker}>
            {t("youtubeManagement.thumbnail.change", "Change thumbnail")}
          </Button>
          {!available || !onSetThumbnail ? <ThumbnailUnavailableReason reason={unavailableReason} /> : null}
        </div>
        <ThumbnailPreview url={previewUrl} note={previewNote} />
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent dir={i18n.language?.startsWith("ar") ? "rtl" : "ltr"} className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("youtubeManagement.thumbnail.pickerTitle", "Choose a thumbnail image")}</DialogTitle>
            <DialogDescription>
              {t("youtubeManagement.thumbnail.pickerHint", "YouTube accepts JPEG and PNG images only.")}
            </DialogDescription>
          </DialogHeader>

          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="upload">
                {t("youtubeManagement.thumbnail.dialog.tabUpload", "Upload file")}
              </TabsTrigger>
              <TabsTrigger value="library">
                {t("youtubeManagement.thumbnail.dialog.tabLibrary", "Media library")}
              </TabsTrigger>
              <TabsTrigger value="ai">
                {t("youtubeManagement.thumbnail.dialog.tabAi", "Generate with AI")}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="upload" className="space-y-2">
              <UploadFileTab
                disabled={submitting || !onUploadImage}
                errorMessage={uploadErrorMessage}
                onFile={(file) => void handleUpload(file)}
              />
            </TabsContent>

            <TabsContent value="library" className="space-y-3">
              <ThumbnailPickerBody
                candidates={eligible}
                loading={candidatesLoading}
                error={candidatesError}
                onRetry={onRetryCandidates}
                selectedId={chosen?.id ?? ""}
                disabled={submitting}
                onSelect={selectImage}
              />
              {excludedCount > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t(
                    "youtubeManagement.thumbnail.excluded",
                    "Some images in your library were excluded because YouTube accepts JPEG and PNG only.",
                  )}
                </p>
              ) : null}
            </TabsContent>

            <TabsContent value="ai" className="space-y-2">
              <GenerateWithAiTab
                disabled={submitting}
                canGenerate={onGenerateAiImage !== undefined && aiPrompt.trim().length > 0}
                resolvedTiers={resolvedTiers}
                prompt={aiPrompt}
                onPromptChange={setAiPrompt}
                references={references}
                onReferenceFiles={(files) => void handleReferenceFiles(files)}
                onRemoveReference={(index) => setReferences((current) => current.filter((_, idx) => idx !== index))}
                libraryCandidates={eligible}
                onUseLibraryReference={(previewUrl) => setReferences((current) =>
                  current.length < 5 ? [...current, previewUrl] : current)}
                onOpenLibraryPicker={() => setLibraryPickerOpen(true)}
                onOpenStockPicker={() => setStockPickerOpen(true)}
                onGenerate={() => void handleGenerate()}
                generatedImageUrl={aiImageUrl}
                onUseGeneratedImage={() => void handleUseGeneratedImage()}
                errorMessage={aiErrorMessage}
              />
            </TabsContent>
          </Tabs>

          {chosen ? (
            <ThumbnailConfirmation
              candidate={chosen}
              busy={submitting}
              onConfirm={() => void confirm()}
              onCancel={() => setChosen(null)}
            />
          ) : null}
          {outcome ? <ThumbnailOutcomeMessage outcome={outcome} /> : null}
        </DialogContent>
      </Dialog>

      {libraryPickerOpen ? (
        <MediaLibraryPicker
          open={libraryPickerOpen}
          onOpenChange={setLibraryPickerOpen}
          imagesOnly
          maxFiles={5}
          currentFileCount={references.length}
          onSelect={(files: UploadedFile[]) => {
            const urls = files
              .map((file) => file.previewUrl || file.cloudinaryUrl || "")
              .filter((url) => url.length > 0);
            setReferences((current) => [...current, ...urls].slice(0, 5));
            setLibraryPickerOpen(false);
          }}
        />
      ) : null}

      {stockPickerOpen ? (
        <StockMediaPicker
          open={stockPickerOpen}
          onOpenChange={setStockPickerOpen}
          onSelect={(media: SelectedMedia) => {
            const url = media.thumbnailUrl || media.url;
            if (url) {
              setReferences((current) => (current.length < 5 ? [...current, url] : current));
            }
            setStockPickerOpen(false);
          }}
        />
      ) : null}

      {!dialogOpen && outcome ? <ThumbnailOutcomeMessage outcome={outcome} /> : null}
    </div>
  );
}

/** Reads a picked reference image as a data URL the generator can take. */
async function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("The reference image could not be read"));
    reader.readAsDataURL(file);
  });
}
