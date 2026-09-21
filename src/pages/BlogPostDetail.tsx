import { useParams, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { useBlogPost, useBlogPosts, useMarkBlogPostRead } from "@/hooks/useNotifications";
import { format, formatDistanceToNow } from "date-fns";
import { ArrowLeft, ArrowRight, Calendar, Clock, Loader2, Share2, Newspaper, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useEffect, useMemo } from "react";
import { useToast } from "@/hooks/use-toast";

export default function BlogPostDetail() {
  const { t } = useTranslation("billing");
  const { id } = useParams<{ id: string }>();
  const { data: post, isLoading, error } = useBlogPost(id);
  const { data: allPosts = [] } = useBlogPosts(true);
  const markRead = useMarkBlogPostRead();
  const { toast } = useToast();

  // Mark as read when viewing
  useEffect(() => {
    if (post && !post.is_read && id) {
      markRead.mutate(id);
    }
  }, [post, id]);

  // Find previous and next posts
  const { prevPost, nextPost } = useMemo(() => {
    if (!allPosts.length || !id) return { prevPost: null, nextPost: null };
    const currentIndex = allPosts.findIndex(p => p.id === id);
    return {
      prevPost: currentIndex > 0 ? allPosts[currentIndex - 1] : null,
      nextPost: currentIndex < allPosts.length - 1 ? allPosts[currentIndex + 1] : null,
    };
  }, [allPosts, id]);

  // Related posts (exclude current)
  const relatedPosts = useMemo(() => {
    return allPosts.filter(p => p.id !== id).slice(0, 3);
  }, [allPosts, id]);

  const handleShare = async () => {
    const url = window.location.href;
    if (navigator.share) {
      try {
        await navigator.share({
          title: post?.title,
          text: post?.excerpt || post?.title,
          url,
        });
      } catch (e) {
        // User cancelled
      }
    } else {
      await navigator.clipboard.writeText(url);
      toast({ title: t("blog.toast.linkCopied", "Link copied!"), description: t("blog.toast.linkCopiedDesc", "Post link copied to clipboard") });
    }
  };

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    );
  }

  if (error || !post) {
    return (
      <DashboardLayout>
        <div className="max-w-3xl mx-auto text-center py-16">
          <div className="w-16 h-16 rounded-full bg-muted mx-auto flex items-center justify-center mb-4">
            <Newspaper className="w-8 h-8 text-muted-foreground" />
          </div>
          <h1 className="text-2xl font-bold mb-4">{t("blog.empty.notFound", "Post not found")}</h1>
          <p className="text-muted-foreground mb-6">
            {t("blog.empty.notFoundDesc", "The post you're looking for doesn't exist or has been removed.")}
          </p>
          <Button asChild>
            <Link to="/whats-new">
              <ArrowLeft className="w-4 h-4 mr-2" />
              {t("blog.actions.backToWhatsNew", "Back to What's New")}
            </Link>
          </Button>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="max-w-4xl mx-auto">
        {/* Breadcrumb & Actions */}
        <div className="flex items-center justify-between mb-6">
          <Link
            to="/whats-new"
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            {t("blog.actions.backToWhatsNew", "Back to What's New")}
          </Link>
          <Button variant="outline" size="sm" onClick={handleShare}>
            <Share2 className="w-4 h-4 mr-2" />
            {t("common:share", "Share")}
          </Button>
        </div>

        <article>
          {/* Cover Image */}
          {post.cover_image_url && (
            <div className="aspect-video w-full rounded-xl overflow-hidden bg-muted mb-8">
              <img
                src={post.cover_image_url}
                alt={post.title}
                className="w-full h-full object-cover"
              />
            </div>
          )}

          {/* Header */}
          <header className="mb-8">
            <Badge variant="secondary" className="mb-4">
              {t("blog.badge.update", "Update")}
            </Badge>
            <h1 className="text-3xl sm:text-4xl font-bold mb-4">{post.title}</h1>
            <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Calendar className="w-4 h-4" />
                {format(new Date(post.created_at), "MMMM d, yyyy")}
              </span>
              <span className="flex items-center gap-1.5">
                <Clock className="w-4 h-4" />
                {formatDistanceToNow(new Date(post.created_at), { addSuffix: true })}
              </span>
            </div>
            {post.excerpt && (
              <p className="text-lg text-muted-foreground mt-4 leading-relaxed">
                {post.excerpt}
              </p>
            )}
          </header>

          <Separator className="my-8" />

          {/* Content */}
          <div className="prose prose-neutral dark:prose-invert max-w-none">
            {post.content.split("\n\n").map((paragraph, idx) => {
              // Handle markdown-style headers
              if (paragraph.startsWith("## ")) {
                return <h2 key={idx} className="text-2xl font-bold mt-8 mb-4">{paragraph.replace("## ", "")}</h2>;
              }
              if (paragraph.startsWith("### ")) {
                return <h3 key={idx} className="text-xl font-semibold mt-6 mb-3">{paragraph.replace("### ", "")}</h3>;
              }
              // Handle bullet points
              if (paragraph.includes("\n- ")) {
                const lines = paragraph.split("\n");
                return (
                  <div key={idx}>
                    {lines[0] && !lines[0].startsWith("- ") && <p className="mb-2">{lines[0]}</p>}
                    <ul className="list-disc list-inside space-y-1">
                      {lines.filter(l => l.startsWith("- ")).map((line, i) => (
                        <li key={i}>{line.replace("- ", "")}</li>
                      ))}
                    </ul>
                  </div>
                );
              }
              return paragraph.trim() ? <p key={idx} className="mb-4 leading-relaxed">{paragraph}</p> : null;
            })}
          </div>
        </article>

        {/* Navigation */}
        {(prevPost || nextPost) && (
          <>
            <Separator className="my-12" />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {prevPost ? (
                <Link
                  to={`/whats-new/${prevPost.id}`}
                  className="group p-4 rounded-xl border border-border hover:border-primary/50 hover:bg-muted/50 transition-all"
                >
                  <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
                    <ChevronLeft className="w-4 h-4" />
                    {t("common:previous", "Previous")}
                  </div>
                  <p className="font-medium group-hover:text-primary transition-colors line-clamp-1">
                    {prevPost.title}
                  </p>
                </Link>
              ) : <div />}
              {nextPost && (
                <Link
                  to={`/whats-new/${nextPost.id}`}
                  className="group p-4 rounded-xl border border-border hover:border-primary/50 hover:bg-muted/50 transition-all text-right"
                >
                  <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground mb-2">
                    {t("common:next", "Next")}
                    <ChevronRight className="w-4 h-4" />
                  </div>
                  <p className="font-medium group-hover:text-primary transition-colors line-clamp-1">
                    {nextPost.title}
                  </p>
                </Link>
              )}
            </div>
          </>
        )}

        {/* Related Posts */}
        {relatedPosts.length > 0 && (
          <>
            <Separator className="my-12" />
            <section>
              <h2 className="text-2xl font-bold mb-6">{t("blog.header.moreUpdates", "More Updates")}</h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {relatedPosts.map((relatedPost) => (
                  <Link
                    key={relatedPost.id}
                    to={`/whats-new/${relatedPost.id}`}
                    className="group rounded-xl border border-border bg-card overflow-hidden hover:shadow-lg transition-shadow"
                  >
                    {relatedPost.cover_image_url && (
                      <div className="aspect-video w-full overflow-hidden bg-muted">
                        <img
                          src={relatedPost.cover_image_url}
                          alt={relatedPost.title}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        />
                      </div>
                    )}
                    <div className="p-4">
                      <h3 className="font-medium line-clamp-2 group-hover:text-primary transition-colors">
                        {relatedPost.title}
                      </h3>
                      <p className="text-xs text-muted-foreground mt-2">
                        {format(new Date(relatedPost.created_at), "MMM d, yyyy")}
                      </p>
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
