import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { MessageSquare } from "lucide-react";
import { CommentRow, type ReplyComposer } from "@/components/comments/CommentRow";
import type { CommentThread } from "@/components/comments/commentTree";

interface CommentThreadCardProps {
  thread: CommentThread;
  socialAccountId: string;
  composer: ReplyComposer;
}

/**
 * One conversation in one frame: the comment somebody left, and every reply beneath it.
 *
 * The frame is the point. Rendered flat, a reply and the comment it answers are two
 * unrelated rows that happen to sit near each other, and on a busy post they do not even
 * do that -- the sort puts them minutes apart. The card boundary says "this is one
 * exchange"; the depth colour inside says who is answering whom.
 */
export function CommentThreadCard({ thread, socialAccountId, composer }: CommentThreadCardProps) {
  const { root, nodes, replyCount } = thread;

  return (
    <Card className={root.is_hidden ? "border-dashed" : undefined}>
      <CardContent className="space-y-1 p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-2 pb-1">
          <Badge variant="outline" className="text-xs capitalize">
            {root.platform}
          </Badge>
          {replyCount > 0 && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <MessageSquare className="h-3 w-3" />
              {replyCount === 1 ? "1 reply" : `${replyCount} replies`}
            </span>
          )}
          {root.post_message && (
            <span className="ms-auto max-w-full truncate text-xs text-muted-foreground">
              On: {root.post_message}
            </span>
          )}
        </div>

        {nodes.map((node) => (
          <CommentRow
            key={node.entry.id}
            node={node}
            socialAccountId={socialAccountId}
            composer={composer}
          />
        ))}
      </CardContent>
    </Card>
  );
}
