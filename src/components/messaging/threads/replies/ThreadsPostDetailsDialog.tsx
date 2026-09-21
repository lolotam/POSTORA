import { useTranslation } from "react-i18next";
import { format } from "date-fns";
import { ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { useThreadPost } from "@/hooks/useThreadsReplies";

interface Props {
  accountId: string | null;
  postId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ThreadsPostDetailsDialog({ accountId, postId, open, onOpenChange }: Props) {
  const { t } = useTranslation("threads");
  const { data, isLoading, error, refetch } = useThreadPost(
    open ? accountId : null,
    open ? postId : null,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("dialog.postDetails", "Post details")}</DialogTitle>
          <DialogDescription className="break-all">
            {postId ? <span className="font-mono text-xs">{t("dialog.postId", "ID: {{id}}", { id: postId })}</span> : null}
          </DialogDescription>
        </DialogHeader>

        {isLoading && (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            {t("dialog.loadingPost", "Loading post…")}
          </div>
        )}

        {!isLoading && error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <p className="font-medium text-destructive">{t("errors.failedLoadPost", "Failed to load post")}</p>
            <p className="text-xs text-muted-foreground mt-1">
              {(error as Error)?.message || t("errors.unknown", "Unknown error")}
            </p>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => refetch()}>
              {t("common:retry", "Retry")}
            </Button>
          </div>
        )}

        {!isLoading && !error && data && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {data.username && <Badge variant="secondary">@{data.username}</Badge>}
              {data.media_type && <Badge variant="outline">{data.media_type}</Badge>}
              {data.timestamp && (
                <span>{format(new Date(data.timestamp), "PPpp")}</span>
              )}
            </div>

            {(data.media_url || data.thumbnail_url) && (
              <div className="rounded-md overflow-hidden border bg-muted">
                <img
                  src={data.thumbnail_url || data.media_url || ""}
                  alt={t("dialog.postMediaAlt", "Post media")}
                  loading="lazy"
                  className="w-full max-h-72 object-contain"
                />
              </div>
            )}

            {data.text ? (
              <div className="rounded-md border bg-muted/30 p-3 text-sm whitespace-pre-wrap">
                {data.text}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground italic">{t("dialog.noText", "No text content.")}</p>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          {data?.permalink && (
            <Button asChild variant="outline" size="sm">
              <a href={data.permalink} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                {t("actions.openOnThreads", "Open on Threads")}
              </a>
            </Button>
          )}
          <Button size="sm" onClick={() => onOpenChange(false)}>
            {t("common:close", "Close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
