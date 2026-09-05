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
  const hideMutation = useHideComment();
  const deleteMutation = useDeleteComment();
  // YouTube's comments.delete works only on the channel's own comments; anyone else's can be
  // hidden (moderation status "rejected") but never removed. Meta lets a page delete any comment
  // on its posts.
  const canDelete = comment.platform !== "youtube" || comment.is_own === true;

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        aria-label={`Reply to ${comment.author_name}`}
        onClick={onReply}
      >
        <Reply className="h-4 w-4" />
      </Button>

      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        aria-label={comment.is_hidden ? "Unhide comment" : "Hide comment"}
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
            aria-label="Delete comment"
            className="h-8 w-8 text-destructive hover:text-destructive"
            disabled={!canDelete}
            title={canDelete ? undefined : "YouTube only lets you delete your own comments — hide it instead."}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete comment?</AlertDialogTitle>
            <AlertDialogDescription>
              {comment.platform === "youtube" ? (
                // YouTube deletes only the one comment; its replies stay.
                "This removes your comment from YouTube. This action cannot be undone."
              ) : (
                <>
                  This will permanently delete this comment. This action cannot be undone.
                  {/* Meta deletes a comment's replies with it, and the thread view is the first
                      place a user can see how many that is before they confirm. */}
                  {replyCount > 0 && ` Its ${replyCount === 1 ? "reply" : `${replyCount} replies`} will go with it.`}
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate({ commentId: comment.id, socialAccountId })}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
