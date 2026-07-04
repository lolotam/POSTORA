import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Reply, EyeOff, Eye, Trash2, Send, Loader2, Heart } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Comment, useReplyComment, useHideComment, useDeleteComment } from "@/hooks/useCommentInbox";
import { formatDistanceToNow } from "date-fns";
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

interface CommentListProps {
  comments: Comment[];
  socialAccountId: string;
  hiddenFilter: string;
}

export function CommentList({ comments, socialAccountId, hiddenFilter }: CommentListProps) {
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");

  const replyMutation = useReplyComment();
  const hideMutation = useHideComment();
  const deleteMutation = useDeleteComment();

  const filtered = comments.filter((c) => {
    if (hiddenFilter === "visible") return !c.is_hidden;
    if (hiddenFilter === "hidden") return c.is_hidden;
    return true;
  });

  const handleReply = (commentId: string) => {
    if (!replyText.trim()) return;
    replyMutation.mutate(
      { commentId, message: replyText, socialAccountId },
      { onSuccess: () => { setReplyingTo(null); setReplyText(""); } }
    );
  };

  if (filtered.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <p className="text-lg font-medium">No comments found</p>
        <p className="text-sm mt-1">Comments will appear here when they are available.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {filtered.map((comment) => (
        <Card key={comment.id} className={comment.is_hidden ? "opacity-60 border-dashed" : ""}>
          <CardContent className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3 flex-1 min-w-0">
                <Avatar className="h-9 w-9 shrink-0">
                  <AvatarImage src={comment.author_avatar || undefined} alt={comment.author_name} />
                  <AvatarFallback className="bg-primary/10 text-primary text-xs font-semibold">
                    {comment.author_name?.charAt(0)?.toUpperCase() || "?"}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-sm">{comment.author_name}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(comment.created_time), { addSuffix: true })}
                    </span>
                    {comment.is_hidden && (
                      <Badge variant="secondary" className="text-xs">Hidden</Badge>
                    )}
                    <Badge variant="outline" className="text-xs capitalize">
                      {comment.platform}
                    </Badge>
                    {comment.like_count != null && (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <Heart className="h-3 w-3" />
                        {comment.like_count}
                      </span>
                    )}
                  </div>
                  <p className="text-sm">{comment.message}</p>
                  {comment.post_message && (
                    <p className="text-xs text-muted-foreground mt-1 truncate">
                      On: {comment.post_message}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setReplyingTo(replyingTo === comment.id ? null : comment.id)}
                >
                  <Reply className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
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
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete comment?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This will permanently delete this comment. This action cannot be undone.
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
            </div>

            {replyingTo === comment.id && (
              <div className="mt-3 flex gap-2">
                <Textarea
                  placeholder="Write a reply..."
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  className="min-h-[60px] text-sm"
                />
                <Button
                  size="icon"
                  className="shrink-0"
                  disabled={!replyText.trim() || replyMutation.isPending}
                  onClick={() => handleReply(comment.id)}
                >
                  {replyMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
