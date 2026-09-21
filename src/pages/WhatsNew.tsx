import { useTranslation } from "react-i18next";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { useBlogPosts, useScheduledBlogPosts } from "@/hooks/useNotifications";
import { format, formatDistanceToNow } from "date-fns";
import { Link } from "react-router-dom";
import { Loader2, Newspaper, Sparkles, Calendar, ArrowRight, Clock, Eye } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useUserRole } from "@/hooks/useUserRole";

export default function WhatsNew() {
  const { t } = useTranslation("billing");
  const { data: posts = [], isLoading } = useBlogPosts(true);
  const { data: scheduledPosts = [], isLoading: isLoadingScheduled } = useScheduledBlogPosts();
  const { isAdmin } = useUserRole();

  // Get the latest post for featured section
  const featuredPost = posts[0];
  const otherPosts = posts.slice(1);

  return (
    <DashboardLayout>
      <div className="max-w-5xl mx-auto space-y-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="w-5 h-5 text-primary" />
              <Badge variant="secondary">{t("whatsNew.badge.updates", "Updates")}</Badge>
            </div>
            <h1 className="text-3xl font-bold">{t("whatsNew.header.title", "What's New")}</h1>
            <p className="text-muted-foreground mt-1">
              {t("whatsNew.header.subtitle", "Latest updates, features, and improvements to Postora")}
            </p>
          </div>
          {posts.length > 0 && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Calendar className="w-4 h-4" />
              <span>{t("whatsNew.lastUpdated", "Last updated {{time}}", { time: formatDistanceToNow(new Date(posts[0].created_at), { addSuffix: true }) })}</span>
            </div>
          )}
        </div>

        {/* Admin Preview: Scheduled Posts */}
        {isAdmin && scheduledPosts.length > 0 && (
          <div className="rounded-xl border-2 border-dashed border-primary/30 bg-primary/5 p-6">
            <div className="flex items-center gap-2 mb-4">
              <Clock className="w-5 h-5 text-primary" />
              <h3 className="font-semibold text-primary">{t("whatsNew.scheduled.title", "Scheduled Posts (Admin Preview)")}</h3>
              <Badge variant="outline" className="text-xs">
                {t("whatsNew.scheduled.count", "{{count}} scheduled", { count: scheduledPosts.length })}
              </Badge>
            </div>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {scheduledPosts.map((post) => (
                <div
                  key={post.id}
                  className="rounded-lg border border-border bg-card p-4 opacity-80"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <Eye className="w-3 h-3 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">{t("whatsNew.scheduled.previewOnly", "Preview only")}</span>
                  </div>
                  <h4 className="font-medium text-sm line-clamp-2 mb-2">{post.title}</h4>
                  {post.excerpt && (
                    <p className="text-xs text-muted-foreground line-clamp-2 mb-3">
                      {post.excerpt}
                    </p>
                  )}
                  <div className="flex items-center gap-1 text-xs text-primary">
                    <Clock className="w-3 h-3" />
                    <span>
                      {t("whatsNew.scheduled.for", "Scheduled for {{time}}", {
                        time: post.scheduled_at
                          ? format(new Date(post.scheduled_at), "MMM d, yyyy 'at' h:mm a")
                          : t("common:unknown", "Unknown"),
                      })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        ) : posts.length === 0 ? (
          <div className="text-center py-16">
            <div className="w-16 h-16 rounded-full bg-secondary mx-auto flex items-center justify-center mb-4">
              <Newspaper className="w-8 h-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium mb-2">{t("whatsNew.empty.title", "No updates yet")}</h3>
            <p className="text-muted-foreground">
              {t("whatsNew.empty.desc", "Check back later for the latest news and updates")}
            </p>
          </div>
        ) : (
          <div className="space-y-8">
            {/* Featured Post (Latest) */}
            {featuredPost && (
              <Link
                to={`/whats-new/${featuredPost.id}`}
                className="group block rounded-2xl border border-border bg-card overflow-hidden hover:shadow-xl transition-all hover:border-primary/30"
              >
                <div className="grid md:grid-cols-2 gap-0">
                  {featuredPost.cover_image_url && (
                    <div className="aspect-video md:aspect-auto md:h-full overflow-hidden bg-muted">
                      <img
                        src={featuredPost.cover_image_url}
                        alt={featuredPost.title}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                      />
                    </div>
                  )}
                  <div className={cn(
                    "p-6 sm:p-8 flex flex-col justify-center",
                    !featuredPost.cover_image_url && "md:col-span-2"
                  )}>
                    <div className="flex items-center gap-2 mb-4">
                      <Badge variant="default" className="bg-primary">{t("whatsNew.badge.latest", "Latest")}</Badge>
                      {!featuredPost.is_read && (
                        <Badge variant="destructive" className="text-xs">{t("whatsNew.badge.new", "New")}</Badge>
                      )}
                    </div>
                    <h2 className="text-2xl sm:text-3xl font-bold mb-3 group-hover:text-primary transition-colors">
                      {featuredPost.title}
                    </h2>
                    {featuredPost.excerpt && (
                      <p className="text-muted-foreground mb-4 line-clamp-3">
                        {featuredPost.excerpt}
                      </p>
                    )}
                    <div className="flex items-center justify-between mt-auto pt-4">
                      <p className="text-sm text-muted-foreground">
                        {format(new Date(featuredPost.created_at), "MMMM d, yyyy")}
                      </p>
                      <span className="text-primary font-medium text-sm flex items-center gap-1 group-hover:gap-2 transition-all">
                        {t("whatsNew.actions.readMore", "Read more")} <ArrowRight className="w-4 h-4" />
                      </span>
                    </div>
                  </div>
                </div>
              </Link>
            )}

            {/* Other Posts Grid */}
            {otherPosts.length > 0 && (
              <div>
                <h3 className="text-lg font-semibold mb-4">{t("whatsNew.previousUpdates", "Previous Updates")}</h3>
                <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
                  {otherPosts.map((post) => (
                    <Link
                      key={post.id}
                      to={`/whats-new/${post.id}`}
                      className="group rounded-xl border border-border bg-card overflow-hidden hover:shadow-lg transition-all hover:border-primary/30"
                    >
                      {post.cover_image_url && (
                        <div className="aspect-video w-full overflow-hidden bg-muted">
                          <img
                            src={post.cover_image_url}
                            alt={post.title}
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                          />
                        </div>
                      )}
                      <div className="p-5">
                        <div className="flex items-center gap-2 mb-2">
                          {!post.is_read && (
                            <span className="h-2 w-2 rounded-full bg-destructive" />
                          )}
                          <p className="text-xs text-muted-foreground">
                            {format(new Date(post.created_at), "MMM d, yyyy")}
                          </p>
                        </div>
                        <h2 className="font-semibold text-lg line-clamp-2 group-hover:text-primary transition-colors">
                          {post.title}
                        </h2>
                        {post.excerpt && (
                          <p className="text-sm text-muted-foreground mt-2 line-clamp-2">
                            {post.excerpt}
                          </p>
                        )}
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
