import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Reveal, GradientRingCard } from "@/components/fx";
import { Button } from "@/components/ui/button";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Platform } from "@/lib/types";
import { formatDistanceToNow } from "date-fns";
import {
  Plus,
  ArrowUpRight,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
} from "lucide-react";

interface Post {
  id: string;
  caption: string | null;
  platforms: string[];
  status: string | null;
  created_at: string;
}

interface RecentPostsProps {
  posts: Post[];
  isLoading?: boolean;
}

export function RecentPosts({ posts, isLoading }: RecentPostsProps) {
  const { t } = useTranslation("dashboard");

  return (
    <Reveal className="lg:col-span-2" delay={120}>
    <GradientRingCard variant="sky" innerClassName="p-0 overflow-hidden" hoverLift={false}>
      <div className="p-5 border-b border-border/60 flex items-center justify-between">
        <h2 className="font-semibold">{t("recentPosts.title", "Recent Posts")}</h2>
        <Link to="/history">
          <Button variant="ghost" size="sm">
            {t("recentPosts.viewAll", "View All")}
            <ArrowUpRight className="w-4 h-4 ms-1" />
          </Button>
        </Link>
      </div>
      <div className="divide-y divide-border/60">
        {isLoading ? (
          <div className="p-8 flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : posts.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-muted-foreground">{t("recentPosts.noPosts", "No posts yet. Create your first post!")}</p>
            <Link to="/post">
              <Button variant="outline" className="mt-4">
                <Plus className="w-4 h-4 me-2" />
                {t("common:createPost", "Create Post")}
              </Button>
            </Link>
          </div>
        ) : (
          posts.map((post) => (
            <div key={post.id} className="p-5 hover:bg-secondary/30 transition-colors">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate mb-2">
                    {post.caption || t("common:noCaption", "No caption")}
                  </p>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1.5">
                      {post.platforms.map((platform) => (
                        <PlatformIcon
                          key={platform}
                          platform={platform as Platform}
                          size="sm"
                        />
                      ))}
                    </div>
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {formatDistanceToNow(new Date(post.created_at), { addSuffix: true })}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {post.status === "completed" ? (
                    <span className="flex items-center gap-1 text-xs text-emerald-400">
                      <CheckCircle2 className="w-4 h-4" />
                      {t("common:status.success", "Success")}
                    </span>
                  ) : post.status === "failed" ? (
                    <span className="flex items-center gap-1 text-xs text-destructive">
                      <XCircle className="w-4 h-4" />
                      {t("common:status.failed", "Failed")}
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-xs text-amber-400">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      {post.status}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </GradientRingCard>
    </Reveal>
  );
}
