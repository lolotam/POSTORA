import { useTranslation } from "react-i18next";
import "@/i18n";
import { Button } from "@/components/ui/button";
import { Reply, EyeOff, Eye, Trash2 } from "lucide-react";
import { useHideComment, useDeleteComment, type Comment } from "@/hooks/useCommentInbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

interface CommentActionsProps {
  comment: Comment;
  socialAccountId: string;
  replyCount: number;
  onReply: () => void;
}

/** Reply, hide, and delete for one comment in a thread. */
export function CommentActions({ comment, socialAccountId, replyCount, onReply }: CommentActionsProps) {
  const { t } = useTranslation("automation");
  const hideMutation = useHideComment();
  const deleteMutation = useDeleteComment();
  // YouTube's comments.delete works only on the channel's own comments; anyone else's can be
  // hidden (moderation status "rejected") but never removed. Meta lets a page delete any comment
  // on its posts.
  const canDelete = comment.platform !== "youtube" || comment.is_own === true;

  const deleteDescription = (() => {
    if (comment.platform === "youtube") {
      return t("dialog.deleteYoutube", "This removes your comment from YouTube. This action cannot be undone.");
    }
    if (replyCount === 1) {
      return t("dialog.deleteWithReply", "This will permanently delete this comment. This action cannot be undone. Its reply will go with it.");
    }
    if (replyCount > 1) {
      return t("dialog.deleteWithReplies", "This will permanently delete this comment. This action cannot be undone. Its {{count}} replies will go with it.", { count: replyCount });
    }
    return t("dialog.deleteMeta", "This will permanently delete this comment. This action cannot be undone.");
  })();

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        aria-label={t("actions.replyTo", "Reply to {{name}}", { name: comment.author_name })}
        onClick={onReply}
      >
        <Reply className="h-4 w-4" />
      </Button>

      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        aria-label={comment.is_hidden ? t("actions.unhideComment", "Unhide comment") : t("actions.hideComment", "Hide comment")}
        disabled={hideMutation.isPending}
        onClick={() =>
          hideMutation.mutate({
            commentId: comment.id,
            socialAccountId,
            isHidden: !comment.is_hidden,
          })
        }
      >
        {comment.is_hidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
      </Button>

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("actions.deleteComment", "Delete comment")}
            className="h-8 w-8 text-destructive hover:text-destructive"
            disabled={!canDelete}
            title={canDelete ? undefined : t("actions.youtubeDeleteHint", "YouTube only lets you delete your own comments — hide it instead.")}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dialog.deleteCommentTitle", "Delete comment?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteDescription}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel", "Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate({ commentId: comment.id, socialAccountId })}
            >
              {t("common:delete", "Delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
