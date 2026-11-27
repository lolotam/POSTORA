import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { YouTubeCategorySelect } from "@/components/post/settings/YouTubeCategorySelect";
import type { YouTubeVideoDetails } from "../domain/types";
import { YouTubeVideoDetail } from "./YouTubeVideoDetail";
import { useYouTubeCategories } from "@/hooks/useYouTubeCategories";

export type EditSaveOutcome = "saved" | "edit_conflict" | "rate_limited" | "refused" | "outcome_unknown";

export interface EditSnapshotValues {
  title?: string;
  description?: string;
  tags?: string[];
  categoryId?: string | null;
}

export type EditSnapshotInput =
  | string
  | { revision: string; values?: EditSnapshotValues }
  | null;

/**
 * The result of one save. A bare outcome covers everything except a rate
 * limit (which carries retryAfterSeconds) or a saved write that also hands
 * back the fresh post-write revision so consecutive saves work.
 */
export type EditSaveResult =
  | EditSaveOutcome
  | { outcome: EditSaveOutcome; retryAfterSeconds?: number | null; revision?: string | null };

export interface YouTubeVideoEditCardProps {
  video: YouTubeVideoDetails;
  fetchedAt: string;
  /** Derived from the server capability; never from a client feature flag. */
  canEdit: boolean;
  disabledReason: string;
  /** Owner-bound account whose token reads the regional catalog. */
  accountId?: string | null;
  /** Effective channel region for the category catalog. */
  region?: string;
  /** Injected snapshot/save seam; the server's capability decides whether it runs. */
  onSnapshot?: (videoId: string) => Promise<EditSnapshotInput>;
  onSave?: (draft: {
    title: string;
    description: string;
    tags: string[];
    categoryId: string;
    baseRevision: string;
  }) => Promise<EditSaveResult>;
}

// The comma-separated tag field is one text control; a tag is a trimmed,
// non-empty piece of it.
function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

// YouTube refuses angle brackets in a title, a description and a tag, and the
// server refuses the same draft as `invalid_request`. The editor refuses it
// before the request leaves the page.
function containsAngleBrackets(value: string): boolean {
  return /[<>]/.test(value);
}

/**
 * Published-video detail with the edit surface beside "Open on YouTube".
 *
 * The edited values are an in-memory draft: no local replica of the video is
 * written and no save is offered while the write capability is disabled. The
 * category dropdown is the same numbered control Create Post uses, so a
 * creator sees identical labels and disabled entries in both editors.
 */
export function YouTubeVideoEditCard({
  video,
  fetchedAt,
  canEdit,
  disabledReason,
  accountId,
  region,
  onSnapshot,
  onSave,
}: YouTubeVideoEditCardProps): JSX.Element {
  const { t, i18n } = useTranslation("accounts");
  const [editing, setEditing] = useState(false);
  const [draftCategory, setDraftCategory] = useState(video.category_id ?? "");
  const [draftTitle, setDraftTitle] = useState(video.title);
  const [draftDescription, setDraftDescription] = useState(video.description ?? "");
  const [draftTags, setDraftTags] = useState((video.tags ?? []).join(", "));
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<{ outcome: EditSaveOutcome; retryAfterSeconds: number | null } | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const locale: "en" | "ar" = i18n.language?.startsWith("ar") ? "ar" : "en";
  const categoryCatalog = useYouTubeCategories(locale, accountId, region);

  // Another video is another edit: the editor closes and the outcome of the
  // previous one stops being shown.
  useEffect(() => {
    setEditing(false);
    setOutcome(null);
  }, [video.id]);

  // The draft follows the video the server last confirmed, so a save that was
  // verified on YouTube leaves the verified values in the editor.
  useEffect(() => {
    setDraftCategory(video.category_id ?? "");
    setDraftTitle(video.title);
    setDraftDescription(video.description ?? "");
    setDraftTags((video.tags ?? []).join(", "));
  }, [video.id, video.category_id, video.title, video.description, video.tags]);

  const openEditor = async () => {
    setEditing(true);
    setOutcome(null);
    if (!onSnapshot) return;
    const snap = await onSnapshot(video.id);
    if (snap === null) {
      setRevision(null);
      setOutcome({ outcome: "outcome_unknown", retryAfterSeconds: null });
      return;
    }
    if (typeof snap === "string") {
      setRevision(snap);
      return;
    }
    setRevision(snap.revision);
    if (snap.values) {
      if (typeof snap.values.title === "string") setDraftTitle(snap.values.title);
      if (typeof snap.values.description === "string") setDraftDescription(snap.values.description);
      if (Array.isArray(snap.values.tags)) setDraftTags(snap.values.tags.join(", "));
      if (snap.values.categoryId !== undefined) setDraftCategory(snap.values.categoryId ?? "");
    }
  };

  const parsedTags = parseTags(draftTags);
  const draftIsRefused =
    draftTitle.trim().length === 0
    || containsAngleBrackets(draftTitle)
    || containsAngleBrackets(draftDescription)
    || parsedTags.some(containsAngleBrackets);

  const save = async () => {
    if (!onSave || saving || revision === null) return;
    setSaving(true);
    setOutcome(null);
    try {
      const result = await onSave({
        title: draftTitle,
        description: draftDescription,
        tags: parsedTags,
        categoryId: draftCategory,
        baseRevision: revision,
      });
      if (typeof result === "string") {
        setOutcome({ outcome: result, retryAfterSeconds: null });
      } else {
        if (typeof result.revision === "string" && result.revision.length > 0) {
          setRevision(result.revision);
        }
        setOutcome({ outcome: result.outcome, retryAfterSeconds: result.retryAfterSeconds ?? null });
      }
    } finally {
      setSaving(false);
    }
  };

  const outcomeMessage = (): string | null => {
    if (outcome === null) return null;
    const seconds = outcome.retryAfterSeconds;
    if (outcome.outcome === "saved") {
      return t("youtubeManagement.detail.saved", "Current details match your changes.");
    }
    if (outcome.outcome === "edit_conflict") {
      return t("youtubeManagement.detail.conflict", "YouTube changed since this was opened. Review the latest details.");
    }
    if (outcome.outcome === "rate_limited") {
      return seconds !== null && seconds > 0
        ? t("youtubeManagement.detail.rateLimitedWithWait", "Edit rate limit reached. Try again in {{seconds}} seconds.", { seconds })
        : t("youtubeManagement.detail.rateLimited", "Edit rate limit reached. Try again later.");
    }
    if (outcome.outcome === "refused") {
      return t("youtubeManagement.detail.refused", "Video details could not be updated. Nothing was changed on YouTube.");
    }
    return t("youtubeManagement.detail.unknown", "YouTube may have saved this change. Check current details.");
  };

  const outcomeText = outcomeMessage();

  return (
    <div className="space-y-2">
      <YouTubeVideoDetail
        video={video}
        fetchedAt={fetchedAt}
        accountId={accountId}
        categoryLabel={categoryCatalog.categories.find((category) => category.id === video.category_id)?.label ?? video.category_id}
        showUpdated={false}
        showHeading={false}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!canEdit}
          onClick={openEditor}
        >
          {t("youtubeManagement.detail.edit", "Edit video details")}
        </Button>
        {!canEdit && <p className="text-xs text-muted-foreground">{disabledReason}</p>}
      </div>
      {canEdit && editing ? (
        <div className="space-y-3 rounded-lg border p-3">
          <h3 className="text-sm font-semibold">{t("youtubeManagement.detail.edit", "Edit video details")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("youtubeManagement.detail.sameVideo", "This changes the details of the same video.")}
          </p>
          <div className="space-y-2">
            <Label htmlFor="edit-video-title">{t("youtubeManagement.detail.title", "Title")}</Label>
            <Input
              id="edit-video-title"
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              maxLength={100}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-video-description">
              {t("youtubeManagement.detail.descriptionLabel", "Description")}
            </Label>
            <Textarea
              id="edit-video-description"
              value={draftDescription}
              onChange={(event) => setDraftDescription(event.target.value)}
              maxLength={5000}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-video-tags">
              {t("youtubeManagement.detail.tagsLabel", "Tags (comma-separated)")}
            </Label>
            <Input
              id="edit-video-tags"
              value={draftTags}
              onChange={(event) => setDraftTags(event.target.value)}
            />
          </div>
          <YouTubeCategorySelect
            id="edit-video-category"
            value={draftCategory}
            onValueChange={setDraftCategory}
            locale={locale}
            options={categoryCatalog.categories}
            catalogUnavailable={categoryCatalog.unavailable}
            onRetry={categoryCatalog.retry}
            label={t("youtubeManagement.detail.category", "Category")}
            unavailableText={t("youtubeManagement.detail.categoryUnavailable", "Currently unavailable")}
          />
          <Button
            type="button"
            size="sm"
            disabled={!onSave || saving || revision === null || draftIsRefused}
            onClick={save}
          >
            {saving
              ? t("youtubeManagement.detail.saving", "Saving…")
              : t("youtubeManagement.detail.save", "Save")}
          </Button>
          {outcomeText ? (
            <p role="status" className="text-xs text-muted-foreground">
              {outcomeText}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
