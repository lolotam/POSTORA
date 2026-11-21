import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { YouTubeCategorySelect } from "@/components/post/settings/YouTubeCategorySelect";
import type { YouTubeVideoDetails } from "../domain/types";
import { YouTubeVideoDetail } from "./YouTubeVideoDetail";

export interface YouTubeVideoEditCardProps {
  video: YouTubeVideoDetails;
  fetchedAt: string;
  /** Derived from the server capability; never from a client feature flag. */
  canEdit: boolean;
  disabledReason: string;
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
}: YouTubeVideoEditCardProps): JSX.Element {
  const { t, i18n } = useTranslation("accounts");
  const [editing, setEditing] = useState(false);
  const [draftCategory, setDraftCategory] = useState(video.category_id ?? "");
  const locale: "en" | "ar" = i18n.language?.startsWith("ar") ? "ar" : "en";

  useEffect(() => {
    setEditing(false);
    setDraftCategory(video.category_id ?? "");
  }, [video.id, video.category_id]);

  return (
    <div className="space-y-2">
      <YouTubeVideoDetail video={video} fetchedAt={fetchedAt} />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!canEdit}
          onClick={() => setEditing(true)}
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
            <Input id="edit-video-title" defaultValue={video.title} maxLength={100} />
          </div>
          <YouTubeCategorySelect
            id="edit-video-category"
            value={draftCategory}
            onValueChange={setDraftCategory}
            locale={locale}
            label={t("youtubeManagement.detail.category", "Category")}
            unavailableText={t("youtubeManagement.detail.categoryUnavailable", "Currently unavailable")}
          />
          <Button type="button" size="sm" disabled>
            {t("youtubeManagement.detail.save", "Save")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
