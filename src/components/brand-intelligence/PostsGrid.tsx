import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/ui/skeleton";
import { AspectRatio } from "@/components/ui/aspect-ratio";
import { Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PostCard } from "./PostCard";
import type { BrandPost } from "@/types/brand-intelligence";

interface PostsGridProps {
  posts: BrandPost[];
  isLoading: boolean;
  onPostClick: (post: BrandPost) => void;
  contentPostIds?: Set<string>;
  canDelete?: boolean;
  deletingPostId?: string | null;
  onPostDelete?: (post: BrandPost) => void;
}

export function PostsGrid({ posts, isLoading, onPostClick, contentPostIds, canDelete, deletingPostId, onPostDelete }: PostsGridProps) {
  const { t } = useTranslation("analytics");
  if (isLoading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i}>
            <AspectRatio ratio={1}>
              <Skeleton className="w-full h-full rounded-lg" />
            </AspectRatio>
          </div>
        ))}
      </div>
    );
  }

  if (posts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <Filter className="w-12 h-12 text-muted-foreground/30 mb-3" />
        <p className="text-muted-foreground font-medium">{t("empty.noFilterMatch", "No posts match your filters")}</p>
        <p className="text-sm text-muted-foreground/60">{t("empty.adjustFilters", "Try adjusting your filter criteria")}</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
      {posts.map((post, index) => (
        <PostCard
          key={post.id}
          post={post}
          index={index}
          onClick={onPostClick}
          hasContent={contentPostIds?.has(post.id)}
          canDelete={canDelete}
          isDeleting={deletingPostId === post.id}
          onDelete={onPostDelete}
        />
      ))}
    </div>
  );
}
