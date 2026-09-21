import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n";
import { Comment, useReplyComment } from "@/hooks/useCommentInbox";
import { buildCommentThreads } from "@/components/comments/commentTree";
import { CommentThreadCard } from "@/components/comments/CommentThreadCard";

interface CommentListProps {
  comments: Comment[];
  socialAccountId: string;
  hiddenFilter: string;
}

export function CommentList({ comments, socialAccountId, hiddenFilter }: CommentListProps) {
  const { t } = useTranslation("automation");
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const replyMutation = useReplyComment();

  // Filtering before threading, not after: a hidden parent whose replies are visible
  // still has to show those replies, and buildCommentThreads promotes them to roots for
  // exactly that reason. Filtering the built tree instead would drop them with it.
  const threads = useMemo(() => {
    const visible = comments.filter((c) => {
      if (hiddenFilter === "visible") return !c.is_hidden;
      if (hiddenFilter === "hidden") return c.is_hidden;
      return true;
    });
    return buildCommentThreads(visible);
  }, [comments, hiddenFilter]);

  const composer = {
    activeId: replyingTo,
    text: replyText,
    isPending: replyMutation.isPending,
    onToggle: (commentId: string) => {
      setReplyingTo((current) => (current === commentId ? null : commentId));
      setReplyText("");
    },
    onChange: setReplyText,
    onSubmit: (commentId: string) => {
      if (!replyText.trim()) return;
      replyMutation.mutate(
        { commentId, message: replyText, socialAccountId },
        { onSuccess: () => { setReplyingTo(null); setReplyText(""); } },
      );
    },
  };

  if (threads.length === 0) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        <p className="text-lg font-medium">{t("empty.noComments", "No comments found")}</p>
        <p className="mt-1 text-sm">{t("empty.noCommentsHint", "Comments will appear here when they are available.")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {threads.map((thread) => (
        <CommentThreadCard
          key={thread.root.id}
          thread={thread}
          socialAccountId={socialAccountId}
          composer={composer}
        />
      ))}
    </div>
  );
}
