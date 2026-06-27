import { useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useBrandSearchHistory } from "@/hooks/useBrandSearchHistory";
import { Clock, X as XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
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
import { Loader2, Search, AtSign, ExternalLink, Eye, MessageCircle, BarChart3, Calendar, Shield, Trash2, MessageSquarePlus, Send } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { mapThreadsReason, ThreadsErrorCard, type ThreadsErrorState } from "./ThreadsErrorCard";
import { useOwnedThreadsAccounts } from "@/hooks/useOwnedThreadsAccounts";
import { PostDetailDrawer } from "./PostDetailDrawer";
import type { BrandPost, MediaType } from "@/types/brand-intelligence";

interface ThreadsPost {
  id: string;
  mediaType: string;
  mediaUrl: string;
  thumbnailUrl: string;
  caption: string;
  timestamp: string;
  permalink: string;
  username: string;
  isQuotePost: boolean;
}

function toBrandPost(p: ThreadsPost): BrandPost {
  const allowed: MediaType[] = ["IMAGE", "VIDEO", "REEL", "CAROUSEL", "TEXT"];
  const mt = (allowed as string[]).includes(p.mediaType) ? (p.mediaType as MediaType) : "TEXT";
  return {
    id: p.id,
    mediaType: mt,
    thumbnailUrl: p.thumbnailUrl || p.mediaUrl || "",
    mediaUrl: p.mediaUrl,
    caption: p.caption || "",
    likesCount: 0,
    commentsCount: 0,
    engagementScore: 0,
    timestamp: p.timestamp,
    permalink: p.permalink,
  };
}

interface ThreadsProfile {
  username: string;
  fullName: string;
  profilePicUrl: string;
  bio: string;
  postsCount: number;
  platform: string;
}

export function ThreadsDiscoveryPanel() {
  const [username, setUsername] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [profile, setProfile] = useState<ThreadsProfile | null>(null);
  const [posts, setPosts] = useState<ThreadsPost[]>([]);
  const [errorState, setErrorState] = useState<ThreadsErrorState | null>(null);
  const [commentForId, setCommentForId] = useState<string | null>(null);
  const [commentText, setCommentText] = useState("");
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [selectedPost, setSelectedPost] = useState<BrandPost | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const blurTimer = useRef<number | null>(null);
  const searchHistory = useBrandSearchHistory("threads", "discovery");
  const { ownsUsername } = useOwnedThreadsAccounts();
  const ownedAccountId = ownsUsername(profile?.username);

  const handleDeletePost = async (postId: string) => {
    if (!ownedAccountId) return;
    setActionLoadingId(postId);
    try {
      const { data, error } = await supabase.functions.invoke("threads-delete-post", {
        body: { thread_id: postId, social_account_id: ownedAccountId },
      });
      if (error) throw new Error(error.message || "Delete failed");
      if (data && data.ok === false) {
        toast.error(mapThreadsReason(data, "discovery").message || "Delete failed");
        return;
      }
      toast.success("Post deleted from Threads");
      setPosts((prev) => prev.filter((p) => p.id !== postId));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setActionLoadingId(null);
    }
  };

  const handlePostComment = async (postId: string) => {
    const text = commentText.trim();
    if (!text) {
      toast.error("Comment cannot be empty");
      return;
    }
    setActionLoadingId(postId);
    try {
      const { data, error } = await supabase.functions.invoke("threads-comment", {
        body: {
          thread_id: postId,
          text,
          ...(ownedAccountId ? { social_account_id: ownedAccountId } : {}),
        },
      });
      if (error) throw new Error(error.message || "Comment failed");
      if (data && data.ok === false) {
        toast.error(mapThreadsReason(data, "discovery").message || "Comment failed");
        return;
      }
      const permalink: string | undefined = data?.permalink;
      if (permalink) {
        toast.success("Comment posted on Threads", {
          action: { label: "View", onClick: () => window.open(permalink, "_blank") },
        });
      } else {
        toast.success("Comment posted on Threads");
      }
      setCommentText("");
      setCommentForId(null);
    } catch (err) {
      const msg = (err as Error).message || "Comment failed";
      const friendly = /Failed to send a request to the Edge Function/i.test(msg)
        ? "Comment service is temporarily unavailable. Please try again in a moment."
        : msg;
      toast.error(friendly);
    } finally {
      setActionLoadingId(null);
    }
  };


  const handleSearch = async () => {
    const clean = username.replace("@", "").trim();
    if (!clean) return;

    setIsLoading(true);
    setErrorState(null);
    setProfile(null);
    setPosts([]);

    try {
      const { data, error: fnError } = await supabase.functions.invoke("threads-discovery", {
        body: { username: clean },
      });

      // Edge function may set fnError for non-2xx (shouldn't happen now — we return 200), but parse anyway.
      let body: any = data;
      if (fnError && !data) {
        try {
          if (fnError.context && typeof fnError.context.json === "function") {
            body = await fnError.context.json();
          }
        } catch { /* ignore */ }
        if (!body) {
          setErrorState({ reason: "unknown", message: fnError.message || "Unknown error" });
          return;
        }
      }

      if (body && body.ok === false) {
        setErrorState(mapThreadsReason(body, "discovery"));
        return;
      }

      if (body?.error && body.ok !== true) {
        setErrorState({ reason: "unknown", message: body.error });
        return;
      }

      setProfile(body.profile);
      setPosts(body.posts || []);

      if ((body.posts || []).length === 0) {
        toast.info("No public posts found for this account");
      }
    } catch (err) {
      const msg = (err as Error).message;
      setErrorState({ reason: "unknown", message: msg });
      toast.error(msg);
    } finally {
      setIsLoading(false);
    }
  };

  const stats = posts.length > 0 ? computeStats(posts) : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <AtSign className="w-5 h-5 text-primary" />
            Threads Profile Discovery
          </h3>
          <p className="text-sm text-muted-foreground">
            Search public Threads profiles for competitor analysis
          </p>
        </div>
      </div>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <AtSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Enter a Threads username..."
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            className="pl-9"
          />
        </div>
        <Button onClick={handleSearch} disabled={isLoading || !username.trim()} className="gap-2">
          {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          Discover
        </Button>
      </div>

      {errorState && <ThreadsErrorCard state={errorState} />}

      {profile && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-3">
              <Avatar className="w-12 h-12">
                <AvatarImage
                  src={profile.profilePicUrl}
                  alt={`@${profile.username}`}
                  referrerPolicy="no-referrer"
                />
                <AvatarFallback className="bg-gradient-to-br from-violet-500 to-pink-500 text-white font-bold text-lg">
                  {profile.username[0]?.toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div>
                <CardTitle className="text-base">@{profile.username}</CardTitle>
                <p className="text-sm text-muted-foreground">{profile.postsCount} public posts discovered</p>
              </div>
            </div>
          </CardHeader>
        </Card>
      )}

      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card><CardContent className="p-4 text-center"><BarChart3 className="w-5 h-5 mx-auto mb-1 text-primary" /><p className="text-2xl font-bold">{stats.totalPosts}</p><p className="text-xs text-muted-foreground">Posts Discovered</p></CardContent></Card>
          <Card><CardContent className="p-4 text-center"><Calendar className="w-5 h-5 mx-auto mb-1 text-primary" /><p className="text-2xl font-bold">{stats.avgPostsPerWeek}</p><p className="text-xs text-muted-foreground">Avg Posts/Week</p></CardContent></Card>
          <Card><CardContent className="p-4 text-center"><MessageCircle className="w-5 h-5 mx-auto mb-1 text-primary" /><p className="text-2xl font-bold">{stats.textPosts}%</p><p className="text-xs text-muted-foreground">Text Posts</p></CardContent></Card>
          <Card><CardContent className="p-4 text-center"><Eye className="w-5 h-5 mx-auto mb-1 text-primary" /><p className="text-2xl font-bold">{stats.mediaPosts}%</p><p className="text-xs text-muted-foreground">Media Posts</p></CardContent></Card>
        </div>
      )}

      {posts.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-sm font-medium text-muted-foreground">Recent Public Posts</h4>
          {posts.map((post) => (
            <Card
              key={post.id}
              className="overflow-hidden cursor-pointer hover:bg-muted/30 transition-colors"
              onClick={() => setSelectedPost(toBrandPost(post))}
            >
              <CardContent className="p-4">
                <div className="flex gap-3">
                  {post.mediaUrl && post.mediaType !== "TEXT" && (
                    <img
                      src={post.thumbnailUrl || post.mediaUrl}
                      alt=""
                      className="w-16 h-16 rounded-lg object-cover flex-shrink-0"
                      referrerPolicy="no-referrer"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm line-clamp-2">{post.caption || "(No text)"}</p>
                    <div className="flex items-center gap-3 mt-2 flex-wrap">
                      <Badge variant="secondary" className="text-xs">{post.mediaType}</Badge>
                      {post.isQuotePost && <Badge variant="outline" className="text-xs">Quote Post</Badge>}
                      <span className="text-xs text-muted-foreground">
                        {post.timestamp ? format(new Date(post.timestamp), "MMM d, yyyy") : ""}
                      </span>
                      <div className="flex items-center gap-1.5 ml-auto">
                        {post.permalink && (
                          <a
                            href={post.permalink}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-xs text-primary hover:underline flex items-center gap-1"
                          >
                            <ExternalLink className="w-3 h-3" />View
                          </a>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs gap-1"
                          onClick={(e) => {
                            e.stopPropagation();
                            setCommentForId((cur) => (cur === post.id ? null : post.id));
                            setCommentText("");
                          }}
                        >
                          <MessageSquarePlus className="w-3.5 h-3.5" />
                          Comment
                        </Button>
                        {ownedAccountId && (
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs gap-1 text-destructive hover:text-destructive"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                                Delete
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent onClick={(e) => e.stopPropagation()}>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Delete this post from Threads?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  This removes the post from Meta. Your local history record stays so you can still see it here.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction onClick={() => handleDeletePost(post.id)} disabled={actionLoadingId === post.id}>
                                  {actionLoadingId === post.id ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                                  Delete
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        )}
                      </div>
                    </div>
                    {commentForId === post.id && (
                      <div className="mt-3 space-y-2 p-3 rounded-lg border bg-muted/30" onClick={(e) => e.stopPropagation()}>
                        <Textarea
                          placeholder="Write a reply…"
                          value={commentText}
                          onChange={(e) => setCommentText(e.target.value)}
                          maxLength={500}
                          rows={2}
                        />
                        <div className="flex items-center justify-between">
                          <p className="text-xs text-muted-foreground">{commentText.length}/500</p>
                          <Button size="sm" className="gap-1.5" onClick={() => handlePostComment(post.id)} disabled={actionLoadingId === post.id || !commentText.trim()}>
                            {actionLoadingId === post.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                            Post comment
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {profile && (
        <p className="text-xs text-center text-muted-foreground">
          Powered by Threads Profile Discovery API • Public data only
        </p>
      )}

      <PostDetailDrawer
        post={selectedPost}
        isOpen={!!selectedPost}
        onClose={() => setSelectedPost(null)}
        platformUsername={profile?.username}
        onDeleted={(id) => setPosts((prev) => prev.filter((p) => p.id !== id))}
      />
    </div>
  );
}

function computeStats(posts: ThreadsPost[]) {
  const totalPosts = posts.length;
  const textPosts = posts.filter((p) => p.mediaType === "TEXT").length;
  const mediaPosts = totalPosts - textPosts;
  const timestamps = posts.map((p) => new Date(p.timestamp).getTime()).filter((t) => !isNaN(t));
  let avgPostsPerWeek = "—";
  if (timestamps.length >= 2) {
    const earliest = Math.min(...timestamps);
    const latest = Math.max(...timestamps);
    const weeks = Math.max(1, (latest - earliest) / (7 * 24 * 60 * 60 * 1000));
    avgPostsPerWeek = (totalPosts / weeks).toFixed(1);
  }
  return {
    totalPosts,
    textPosts: totalPosts > 0 ? Math.round((textPosts / totalPosts) * 100) : 0,
    mediaPosts: totalPosts > 0 ? Math.round((mediaPosts / totalPosts) * 100) : 0,
    avgPostsPerWeek,
  };
}
