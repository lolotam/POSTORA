import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PostSavedActionsProps {
  onCreateNewPost: () => void;
  postId: string;
  status: "scheduled" | "submitted" | "unconfirmed";
}

export function PostSavedActions({ onCreateNewPost, postId, status }: PostSavedActionsProps) {
  const { t } = useTranslation("post");
  const statusText = status === "scheduled"
    ? t("saved.scheduled", "Scheduled. Check History for the publishing time and status.")
    : status === "submitted"
      ? t("saved.submitted", "Submitted for publishing. Check History for the final result.")
      : t("saved.unconfirmed", "Saved, but publishing could not be confirmed. Check History before retrying.");
  return (
    <section className="rounded-lg border border-border bg-card p-5 flex flex-wrap items-center justify-between gap-4" aria-live="polite">
      <div>
        <p className="font-medium">{t("saved.title", "Post saved")}</p>
        <p className="text-sm text-muted-foreground">{statusText}</p>
        <p className="text-xs text-muted-foreground mt-1" data-testid="saved-post-id">{t("saved.identity", "Saved post ID: {{postId}}", { postId })}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline">
          <Link to="/history">{t("saved.history", "View History")}</Link>
        </Button>
        <Button type="button" onClick={onCreateNewPost} className="gap-2">
          <Plus className="h-4 w-4" />
          {t("saved.newPost", "Create new post")}
        </Button>
      </div>
    </section>
  );
}
