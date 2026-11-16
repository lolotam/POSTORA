import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

export function PostSavedActions({ onCreateNewPost }: { onCreateNewPost: () => void }) {
  const { t } = useTranslation("post");
  return (
    <section className="rounded-lg border border-border bg-card p-5 flex flex-wrap items-center justify-between gap-4" aria-live="polite">
      <div>
        <p className="font-medium">{t("saved.title", "Post saved")}</p>
        <p className="text-sm text-muted-foreground">
          {t("saved.description", "Check History for publishing or scheduled status, or start another post.")}
        </p>
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
