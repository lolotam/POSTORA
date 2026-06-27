import { useState, useEffect } from "react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PlatformIcon, getPlatformName } from "@/components/PlatformIcon";
import { usePosts, Post } from "@/hooks/usePosts";
import { useSocialAccounts } from "@/hooks/useSocialAccounts";
import { useSocialProfiles } from "@/hooks/useSocialProfiles";
import { Platform } from "@/lib/types";
import { formatDistanceToNow, format, isFuture, differenceInSeconds } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { Textarea } from "@/components/ui/textarea";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Search,
  Clock,
  Calendar as CalendarIcon,
  
  MoreHorizontal,
  Loader2,
  Edit,
  XCircle,
  Send,
  AlertTriangle,
  RefreshCw,
  User,
  Zap,
  FolderOpen,
  Filter,
  CheckSquare,
  CalendarClock,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { GradientHeading, GradientRingCard, Icon3D, Reveal, GradientDivider } from "@/components/fx";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { ScheduledPostMedia, type ScheduledMediaItem } from "@/components/scheduled/ScheduledPostMedia";
import { MediaLightboxDialog } from "@/components/scheduled/MediaLightboxDialog";
import { AccountAvatar } from "@/components/AccountAvatar";
import { PlatformAccountMultiSelect } from "@/components/post/PlatformAccountMultiSelect";

// Countdown timer component
function CountdownTimer({ scheduledAt }: { scheduledAt: string }) {
  const [timeLeft, setTimeLeft] = useState("");
  const [isOverdue, setIsOverdue] = useState(false);

  useEffect(() => {
    const updateTimer = () => {
      const now = new Date();
      const scheduled = new Date(scheduledAt);
      const diffSeconds = differenceInSeconds(scheduled, now);

      if (diffSeconds <= 0) {
        setIsOverdue(true);
        const overdueDiff = Math.abs(diffSeconds);
        const hours = Math.floor(overdueDiff / 3600);
        const minutes = Math.floor((overdueDiff % 3600) / 60);
        const seconds = overdueDiff % 60;
        setTimeLeft(`-${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`);
      } else {
        setIsOverdue(false);
        const hours = Math.floor(diffSeconds / 3600);
        const minutes = Math.floor((diffSeconds % 3600) / 60);
        const seconds = diffSeconds % 60;
        setTimeLeft(`${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`);
      }
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [scheduledAt]);

  return (
    <div
      className={cn(
        "font-mono text-xs px-2.5 py-1 rounded-full inline-flex items-center gap-1 border tabular-nums",
        isOverdue
          ? "bg-gradient-to-r from-rose-500/15 to-pink-500/10 text-rose-600 dark:text-rose-300 border-rose-400/40"
          : "bg-gradient-to-r from-emerald-500/15 to-cyan-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-400/40"
      )}
    >
      <Clock className="w-3 h-3" />
      {timeLeft}
    </div>
  );
}

export default function ScheduledPosts() {
  const [search, setSearch] = useState("");
  const [editPost, setEditPost] = useState<Post | null>(null);
  const [cancelPost, setCancelPost] = useState<Post | null>(null);
  const [editCaption, setEditCaption] = useState("");
  const [editScheduledDate, setEditScheduledDate] = useState<Date | undefined>();
  const [editScheduledTime, setEditScheduledTime] = useState("");
  const [editPlatforms, setEditPlatforms] = useState<Platform[]>([]);
  const [editAccountIds, setEditAccountIds] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [publishingPostId, setPublishingPostId] = useState<string | null>(null);
  const { data: posts = [], isLoading, refetch, isFetching } = usePosts();
  const { data: socialAccounts = [] } = useSocialAccounts();
  const { data: socialProfiles = [] } = useSocialProfiles();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Bulk selection state
  const [selectedPostIds, setSelectedPostIds] = useState<Set<string>>(new Set());
  const [isBulkCancelling, setIsBulkCancelling] = useState(false);
  const [showBulkCancelDialog, setShowBulkCancelDialog] = useState(false);
  const [showBulkRescheduleDialog, setShowBulkRescheduleDialog] = useState(false);
  const [bulkScheduledDate, setBulkScheduledDate] = useState<Date | undefined>();
  const [bulkScheduledTime, setBulkScheduledTime] = useState("");
  const [isBulkRescheduling, setIsBulkRescheduling] = useState(false);

  // Media lightbox state
  const [lightbox, setLightbox] = useState<{ items: ScheduledMediaItem[]; index: number } | null>(null);

  // Filter state
  const [platformFilter, setPlatformFilter] = useState<Platform | "all">("all");
  const [profileFilter, setProfileFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "overdue">("all");

  // Create lookup maps for accounts and profiles
  const accountsMap = new Map(socialAccounts.map(acc => [acc.id, acc]));
  const profilesMap = new Map(socialProfiles.map(p => [p.id, p]));

  // Helper to get account details for a post
  const getPostAccounts = (post: Post) => {
    const accountIds = post.metadata?.selected_account_ids || [];
    return accountIds
      .map(id => accountsMap.get(id))
      .filter(Boolean);
  };

  // Helper to get unique profiles for a post
  const getPostProfiles = (post: Post) => {
    const accounts = getPostAccounts(post);
    const profileIds = [...new Set(accounts.map(acc => acc?.social_profile_id).filter(Boolean))];
    return profileIds.map(id => profilesMap.get(id as string)).filter(Boolean);
  };

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      refetch();
    }, 30000);
    return () => clearInterval(interval);
  }, [refetch]);

  // Get all platforms used in scheduled posts
  const allPlatformsInPosts = [...new Set(posts.flatMap(p => p.platforms || []))];

  // Filter for scheduled posts (pending with scheduled_at date - includes past dates awaiting processing)
  const scheduledPosts = posts
    .filter((post) => {
      const isScheduled = (post.status === "pending" || post.status === "scheduled") && post.scheduled_at;
      const matchesSearch = (post.caption || "").toLowerCase().includes(search.toLowerCase());
      
      // Platform filter
      const matchesPlatform = platformFilter === "all" || post.platforms.includes(platformFilter);
      
      // Profile filter
      const postProfiles = getPostProfiles(post);
      const matchesProfile = profileFilter === "all" || postProfiles.some((p: any) => p?.id === profileFilter);
      
      // Status filter
      const isOverdue = !isFuture(new Date(post.scheduled_at!));
      const matchesStatus = statusFilter === "all" || 
        (statusFilter === "pending" && !isOverdue) ||
        (statusFilter === "overdue" && isOverdue);
      
      return isScheduled && matchesSearch && matchesPlatform && matchesProfile && matchesStatus;
    })
    .sort((a, b) => {
      // Sort: future posts first (by scheduled time), then past posts
      const dateA = new Date(a.scheduled_at!);
      const dateB = new Date(b.scheduled_at!);
      const now = new Date();
      const aIsFuture = dateA > now;
      const bIsFuture = dateB > now;
      
      if (aIsFuture && !bIsFuture) return -1;
      if (!aIsFuture && bIsFuture) return 1;
      return dateA.getTime() - dateB.getTime();
    });

  // Bulk selection handlers
  const togglePostSelection = (postId: string) => {
    setSelectedPostIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(postId)) {
        newSet.delete(postId);
      } else {
        newSet.add(postId);
      }
      return newSet;
    });
  };

  const selectAllPosts = () => {
    if (selectedPostIds.size === scheduledPosts.length) {
      setSelectedPostIds(new Set());
    } else {
      setSelectedPostIds(new Set(scheduledPosts.map(p => p.id)));
    }
  };

  const clearSelection = () => {
    setSelectedPostIds(new Set());
  };

  // Bulk cancel handler
  const handleBulkCancel = async () => {
    if (selectedPostIds.size === 0) return;
    setIsBulkCancelling(true);

    try {
      const { error } = await supabase
        .from("posts")
        .delete()
        .in("id", Array.from(selectedPostIds));

      if (error) throw error;

      toast({
        title: "Posts cancelled",
        description: `${selectedPostIds.size} scheduled post(s) have been cancelled.`,
      });

      queryClient.invalidateQueries({ queryKey: ["posts"] });
      setSelectedPostIds(new Set());
      setShowBulkCancelDialog(false);
    } catch (error) {
      console.error("Bulk cancel error:", error);
      toast({
        title: "Cancel failed",
        description: error instanceof Error ? error.message : "Failed to cancel posts",
        variant: "destructive",
      });
    } finally {
      setIsBulkCancelling(false);
    }
  };

  // Bulk reschedule handler
  const handleBulkReschedule = async () => {
    if (selectedPostIds.size === 0 || !bulkScheduledDate || !bulkScheduledTime) return;
    setIsBulkRescheduling(true);

    try {
      const [hours, minutes] = bulkScheduledTime.split(":").map(Number);
      const scheduledAt = new Date(bulkScheduledDate);
      scheduledAt.setHours(hours, minutes, 0, 0);

      if (!isFuture(scheduledAt)) {
        toast({
          title: "Invalid date",
          description: "Scheduled time must be in the future.",
          variant: "destructive",
        });
        setIsBulkRescheduling(false);
        return;
      }

      const { error } = await supabase
        .from("posts")
        .update({ scheduled_at: scheduledAt.toISOString() })
        .in("id", Array.from(selectedPostIds));

      if (error) throw error;

      toast({
        title: "Posts rescheduled",
        description: `${selectedPostIds.size} post(s) rescheduled to ${format(scheduledAt, "PPP 'at' p")}.`,
      });

      queryClient.invalidateQueries({ queryKey: ["posts"] });
      setSelectedPostIds(new Set());
      setShowBulkRescheduleDialog(false);
      setBulkScheduledDate(undefined);
      setBulkScheduledTime("");
    } catch (error) {
      console.error("Bulk reschedule error:", error);
      toast({
        title: "Reschedule failed",
        description: error instanceof Error ? error.message : "Failed to reschedule posts",
        variant: "destructive",
      });
    } finally {
      setIsBulkRescheduling(false);
    }
  };

  const handleEditClick = (post: Post) => {
    setEditPost(post);
    setEditCaption(post.caption || "");
    if (post.scheduled_at) {
      const date = new Date(post.scheduled_at);
      setEditScheduledDate(date);
      setEditScheduledTime(format(date, "HH:mm"));
    }
  };

  const handleSaveEdit = async () => {
    if (!editPost || !editScheduledDate || !editScheduledTime) return;

    setIsSaving(true);

    try {
      const [hours, minutes] = editScheduledTime.split(":").map(Number);
      const scheduledAt = new Date(editScheduledDate);
      scheduledAt.setHours(hours, minutes, 0, 0);

      if (!isFuture(scheduledAt)) {
        toast({
          title: "Invalid date",
          description: "Scheduled time must be in the future.",
          variant: "destructive",
        });
        setIsSaving(false);
        return;
      }

      const { error } = await supabase
        .from("posts")
        .update({
          caption: editCaption,
          scheduled_at: scheduledAt.toISOString(),
        })
        .eq("id", editPost.id);

      if (error) throw error;

      toast({
        title: "Post updated",
        description: "Your scheduled post has been updated.",
      });

      queryClient.invalidateQueries({ queryKey: ["posts"] });
      setEditPost(null);
    } catch (error) {
      console.error("Update error:", error);
      toast({
        title: "Update failed",
        description: error instanceof Error ? error.message : "Failed to update post",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancelPost = async () => {
    if (!cancelPost) return;

    setIsCancelling(true);

    try {
      const { error } = await supabase
        .from("posts")
        .delete()
        .eq("id", cancelPost.id);

      if (error) throw error;

      toast({
        title: "Post cancelled",
        description: "The scheduled post has been cancelled and removed.",
      });

      queryClient.invalidateQueries({ queryKey: ["posts"] });
      queryClient.invalidateQueries({ queryKey: ["post_stats"] });
      setCancelPost(null);
    } catch (error) {
      console.error("Cancel error:", error);
      toast({
        title: "Cancel failed",
        description: error instanceof Error ? error.message : "Failed to cancel post",
        variant: "destructive",
      });
    } finally {
      setIsCancelling(false);
    }
  };

  const handlePublishNow = async (post: Post) => {
    setPublishingPostId(post.id);

    try {
      // Update the scheduled_at to now and trigger processing
      const { error: updateError } = await supabase
        .from("posts")
        .update({ scheduled_at: new Date().toISOString() })
        .eq("id", post.id);

      if (updateError) throw updateError;

      // Trigger the process-post function
      const { error } = await supabase.functions.invoke("process-post", {
        body: { post_id: post.id },
      });

      if (error) throw error;

      toast({
        title: "Publishing started",
        description: "Your post is now being published.",
      });

      queryClient.invalidateQueries({ queryKey: ["posts"] });
    } catch (error) {
      console.error("Publish error:", error);
      toast({
        title: "Publish failed",
        description: error instanceof Error ? error.message : "Failed to publish post",
        variant: "destructive",
      });
    } finally {
      setPublishingPostId(null);
    }
  };

  // Count overdue posts
  const overdueCount = scheduledPosts.filter(p => !isFuture(new Date(p.scheduled_at!))).length;

  return (
    <DashboardLayout>
      <div className="space-y-8">
        {/* Header */}
        <Reveal>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 group">
            <div className="flex items-center gap-4">
              <Icon3D icon={Clock} variant="amber" size="md" />
              <div>
                <GradientHeading as="h1" preset="amber-rose-violet" size="xl">
                  Scheduled Posts
                </GradientHeading>
                <p className="text-muted-foreground mt-1">
                  Manage your upcoming scheduled posts.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => refetch()}
                disabled={isFetching}
                className="gap-2 rounded-full border border-border/60 bg-card/60 backdrop-blur-md hover:bg-amber-500/10 hover:text-amber-600"
              >
                <RefreshCw className={cn("w-4 h-4", isFetching && "animate-spin")} />
                Refresh
              </Button>
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border border-amber-400/40 bg-gradient-to-r from-amber-500/15 to-orange-500/10 text-amber-700 dark:text-amber-300 tabular-nums">
                <CalendarClock className="w-3.5 h-3.5" />
                {scheduledPosts.length} scheduled
              </span>
              {overdueCount > 0 && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border border-rose-400/40 bg-gradient-to-r from-rose-500/15 to-pink-500/10 text-rose-600 dark:text-rose-300 tabular-nums">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {overdueCount} overdue
                </span>
              )}
            </div>
          </div>
        </Reveal>

        <GradientDivider tone="rose" />

        {/* Search and Filters */}
        <Reveal delay={80}>
          <GradientRingCard variant="cyan" hoverLift={false} ringIntensity="subtle" innerClassName="p-4 md:p-5">
            <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center group">
              <div className="hidden md:flex">
                <Icon3D icon={Filter} variant="cyan" size="sm" />
              </div>
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-cyan-500/80" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search scheduled posts..."
                  className="pl-10 rounded-full bg-background/60 backdrop-blur border-border/60 focus-visible:ring-cyan-500/40"
                />
              </div>
          
          {/* Platform Filter */}
          <Select value={platformFilter} onValueChange={(v) => setPlatformFilter(v as Platform | "all")}>
            <SelectTrigger className="w-[160px] rounded-full bg-background/60 backdrop-blur border-border/60">
              <SelectValue placeholder="Platform" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Platforms</SelectItem>
              {allPlatformsInPosts.map((platform) => (
                <SelectItem key={platform} value={platform}>
                  <div className="flex items-center gap-2">
                    <PlatformIcon platform={platform as Platform} size="xs" />
                    {getPlatformName(platform as Platform)}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Profile Filter */}
          <Select value={profileFilter} onValueChange={setProfileFilter}>
            <SelectTrigger className="w-[160px] rounded-full bg-background/60 backdrop-blur border-border/60">
              <SelectValue placeholder="Profile" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Profiles</SelectItem>
              {socialProfiles.map((profile) => (
                <SelectItem key={profile.id} value={profile.id}>
                  {profile.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Status Filter */}
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as "all" | "pending" | "overdue")}>
            <SelectTrigger className="w-[140px] rounded-full bg-background/60 backdrop-blur border-border/60">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="overdue">Overdue</SelectItem>
            </SelectContent>
          </Select>
            </div>
          </GradientRingCard>
        </Reveal>

        {/* Bulk Actions Bar */}
        {selectedPostIds.size > 0 && (
          <GradientRingCard variant="violet" hoverLift={false} active innerClassName="p-3 md:p-4">
            <div className="flex flex-wrap items-center gap-3 group">
              <Icon3D icon={CheckSquare} variant="violet" size="sm" />
              <div className="flex items-center gap-2">
                <Checkbox
                  checked={selectedPostIds.size === scheduledPosts.length}
                  onCheckedChange={selectAllPosts}
                />
                <span className="text-sm font-medium">
                  {selectedPostIds.size} selected
                </span>
              </div>
              <div className="flex-1" />
              <Button
                size="sm"
                onClick={() => setShowBulkRescheduleDialog(true)}
                className="gap-2 rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 hover:from-violet-600 hover:to-fuchsia-600 text-white shadow-md shadow-violet-500/30"
              >
                <CalendarIcon className="w-4 h-4" />
                Reschedule
              </Button>
              <Button
                size="sm"
                onClick={() => setShowBulkCancelDialog(true)}
                className="gap-2 rounded-full bg-gradient-to-r from-rose-500 to-pink-500 hover:from-rose-600 hover:to-pink-600 text-white shadow-md shadow-rose-500/30"
              >
                <XCircle className="w-4 h-4" />
                Cancel Selected
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={clearSelection}
                className="rounded-full"
              >
                Clear
              </Button>
            </div>
          </GradientRingCard>
        )}

        {/* Posts Grid */}
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-8 h-8 animate-spin text-amber-500" />
          </div>
        ) : scheduledPosts.length === 0 ? (
          <Reveal delay={120}>
            <GradientRingCard variant="sky" hoverLift={false} innerClassName="py-16 text-center">
              <div className="group inline-flex flex-col items-center gap-4">
                <Icon3D icon={CalendarClock} variant="sky" size="lg" />
                <h3 className="text-lg font-semibold">No scheduled posts</h3>
                <p className="text-muted-foreground max-w-md">
                  {search ? "No posts match your search" : "You don't have any upcoming scheduled posts."}
                </p>
              </div>
            </GradientRingCard>
          </Reveal>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {scheduledPosts.map((post) => {
              const isPublishing = publishingPostId === post.id;
              const isOverdue = !isFuture(new Date(post.scheduled_at!));
              const postAccounts = getPostAccounts(post);
              const postProfiles = getPostProfiles(post);
              const postType = post.source === "api" ? "API" : "Manual";
              const index = scheduledPosts.indexOf(post);

              return (
                <Reveal key={post.id} delay={Math.min(index * 40, 320)}>
                  <GradientRingCard
                    variant={isOverdue ? "rose" : "emerald"}
                    hoverLift
                    ringIntensity="normal"
                    innerClassName="p-0 overflow-hidden"
                  >
                  <CardHeader className="pb-3 pt-5 px-5">
                    {/* Header: Checkbox + Status badges + Actions */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          checked={selectedPostIds.has(post.id)}
                          onCheckedChange={() => togglePostSelection(post.id)}
                          className="mt-0.5"
                        />
                        <div className="flex flex-wrap items-center gap-1.5">
                          {/* Status Badge */}
                          {isOverdue ? (
                            <Badge variant="destructive" className="gap-1 text-xs">
                              <AlertTriangle className="w-3 h-3" />
                              Overdue
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="gap-1 text-xs">
                              <Clock className="w-3 h-3" />
                              Pending
                            </Badge>
                          )}
                          {/* Type Badge */}
                          <Badge variant="outline" className="gap-1 text-xs">
                            {postType === "API" ? <Zap className="w-3 h-3" /> : <User className="w-3 h-3" />}
                            {postType}
                          </Badge>
                        </div>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label="View more options">
                            <MoreHorizontal className="w-4 h-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => handleEditClick(post)} className="gap-2">
                            <Edit className="w-4 h-4" />
                            Quick Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => window.location.href = `/post?edit=${post.id}`} className="gap-2">
                            <FolderOpen className="w-4 h-4" />
                            Edit in Composer
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handlePublishNow(post)}
                            disabled={isPublishing}
                            className="gap-2"
                          >
                            {isPublishing ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Send className="w-4 h-4" />
                            )}
                            Publish Now
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => setCancelPost(post)}
                            className="text-destructive gap-2"
                          >
                            <XCircle className="w-4 h-4" />
                            Cancel Post
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </CardHeader>

                  <CardContent className="space-y-4 px-5 pb-5">
                    {/* Caption */}
                    <div>
                      <HoverCard openDelay={200} closeDelay={100}>
                        <HoverCardTrigger asChild>
                          <p className="text-sm line-clamp-3 text-foreground cursor-pointer hover:text-primary transition-colors">
                            {post.caption || <span className="text-muted-foreground italic">No caption</span>}
                          </p>
                        </HoverCardTrigger>
                        {post.caption && (
                          <HoverCardContent className="max-w-md w-[28rem] max-h-[60vh] overflow-y-auto">
                            <p className="text-sm whitespace-pre-wrap text-foreground">{post.caption}</p>
                          </HoverCardContent>
                        )}
                      </HoverCard>
                    </div>

                    {/* Media thumbnails */}
                    {post.media_file_ids && post.media_file_ids.length > 0 && (
                      <ScheduledPostMedia
                        mediaFileIds={post.media_file_ids}
                        onOpen={(items, index) => setLightbox({ items, index })}
                      />
                    )}


                    {/* Profiles */}
                    {postProfiles.length > 0 && (
                      <div className="flex items-center gap-2">
                        <FolderOpen className="w-4 h-4 text-muted-foreground shrink-0" />
                        <div className="flex flex-wrap gap-1">
                          {postProfiles.map((profile: any) => (
                            <Badge key={profile.id} variant="secondary" className="text-xs">
                              {profile.name}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Accounts */}
                    <div className="flex flex-wrap items-start gap-4">
                      {postAccounts.slice(0, 4).map((account: any) => (
                        <div key={account.id} className="flex flex-col items-center gap-1" title={`@${account.platform_username} (${getPlatformName(account.platform)})`}>
                          <Avatar className="w-8 h-8 border-2 border-background">
                            <AvatarImage src={account.avatar_url || undefined} />
                            <AvatarFallback className="text-xs">
                              {account.platform_username?.[0]?.toUpperCase() || "?"}
                            </AvatarFallback>
                          </Avatar>
                          <PlatformIcon platform={account.platform} size="xs" />
                        </div>
                      ))}
                      {postAccounts.length > 4 && (
                        <div className="flex flex-col items-center gap-1">
                          <div className="w-8 h-8 rounded-full bg-muted border-2 border-background flex items-center justify-center text-xs text-muted-foreground">
                            +{postAccounts.length - 4}
                          </div>
                          <span className="text-[10px] text-muted-foreground">more</span>
                        </div>
                      )}
                      {postAccounts.length === 0 && (
                        <span className="text-xs text-muted-foreground">No accounts</span>
                      )}
                    </div>

                    {/* Platforms */}
                    <div className="flex flex-wrap items-center gap-2">
                      {post.platforms.map((platform) => (
                        <div key={platform} className="flex items-center gap-1 text-xs text-muted-foreground">
                          <PlatformIcon platform={platform as Platform} size="sm" />
                        </div>
                      ))}
                    </div>

                    {/* Schedule Info */}
                    <div className={cn(
                      "rounded-xl p-3 space-y-2 border",
                      isOverdue
                        ? "bg-gradient-to-br from-rose-500/10 to-pink-500/5 border-rose-400/30"
                        : "bg-gradient-to-br from-emerald-500/10 to-cyan-500/5 border-emerald-400/30"
                    )}>
                      <div className="flex items-center justify-between">
                        <div className={cn(
                          "flex items-center gap-1.5 text-sm font-medium",
                          isOverdue ? "text-rose-600 dark:text-rose-300" : "text-emerald-700 dark:text-emerald-300"
                        )}>
                          <CalendarIcon className="w-4 h-4" />
                          {format(new Date(post.scheduled_at!), "MMM d, yyyy")}
                        </div>
                        <span className="text-sm text-muted-foreground tabular-nums">
                          {format(new Date(post.scheduled_at!), "h:mm a")}
                        </span>
                      </div>
                      <CountdownTimer scheduledAt={post.scheduled_at!} />
                    </div>
                  </CardContent>
                  </GradientRingCard>
                </Reveal>
              );
            })}
          </div>
        )}
      </div>

      {/* Edit Dialog */}
      <Dialog open={!!editPost} onOpenChange={(open) => !open && setEditPost(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Scheduled Post</DialogTitle>
            <DialogDescription>
              Update the caption or reschedule this post.
            </DialogDescription>
          </DialogHeader>

          {editPost && (
            <div className="space-y-4">
              {/* Platforms */}
              <div>
                <label className="text-sm font-medium text-muted-foreground mb-2 block">
                  Platforms
                </label>
                <div className="flex gap-2">
                  {editPost.platforms.map((platform) => (
                    <div
                      key={platform}
                      className="flex items-center gap-2 bg-muted/50 px-3 py-1.5 rounded-lg"
                    >
                      <PlatformIcon platform={platform as Platform} size="sm" />
                      <span className="text-sm">{getPlatformName(platform as Platform)}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Caption */}
              <div>
                <label className="text-sm font-medium text-muted-foreground mb-2 block">
                  Caption
                </label>
                <Textarea
                  value={editCaption}
                  onChange={(e) => setEditCaption(e.target.value)}
                  placeholder="Write your caption..."
                  rows={4}
                />
              </div>

              {/* Schedule */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium text-muted-foreground mb-2 block">
                    Date
                  </label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        className={cn(
                          "w-full justify-start text-left font-normal",
                          !editScheduledDate && "text-muted-foreground"
                        )}
                      >
                        <CalendarIcon className="mr-2 h-4 w-4" />
                        {editScheduledDate ? format(editScheduledDate, "PPP") : "Pick a date"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={editScheduledDate}
                        onSelect={setEditScheduledDate}
                        disabled={(date) => date < new Date()}
                        initialFocus
                      />
                    </PopoverContent>
                  </Popover>
                </div>
                <div>
                  <label className="text-sm font-medium text-muted-foreground mb-2 block">
                    Time
                  </label>
                  <Input
                    type="time"
                    value={editScheduledTime}
                    onChange={(e) => setEditScheduledTime(e.target.value)}
                  />
                </div>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditPost(null)}>
              Cancel
            </Button>
            <Button onClick={handleSaveEdit} disabled={isSaving}>
              {isSaving ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Saving...
                </>
              ) : (
                "Save Changes"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel Confirmation Dialog */}
      <AlertDialog open={!!cancelPost} onOpenChange={(open) => !open && setCancelPost(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel Scheduled Post</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to cancel this scheduled post? This action cannot be undone.
              The post will be permanently removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isCancelling}>Keep Post</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCancelPost}
              disabled={isCancelling}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isCancelling ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Cancelling...
                </>
              ) : (
                "Cancel Post"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* Bulk Cancel Confirmation Dialog */}
      <AlertDialog open={showBulkCancelDialog} onOpenChange={setShowBulkCancelDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel {selectedPostIds.size} Scheduled Posts</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to cancel {selectedPostIds.size} scheduled post(s)? This action cannot be undone.
              All selected posts will be permanently removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isBulkCancelling}>Keep Posts</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkCancel}
              disabled={isBulkCancelling}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isBulkCancelling ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Cancelling...
                </>
              ) : (
                `Cancel ${selectedPostIds.size} Posts`
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk Reschedule Dialog */}
      <Dialog open={showBulkRescheduleDialog} onOpenChange={setShowBulkRescheduleDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reschedule {selectedPostIds.size} Posts</DialogTitle>
            <DialogDescription>
              Set a new date and time for all selected posts.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-muted-foreground mb-2 block">
                  Date
                </label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={cn(
                        "w-full justify-start text-left font-normal",
                        !bulkScheduledDate && "text-muted-foreground"
                      )}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {bulkScheduledDate ? format(bulkScheduledDate, "PPP") : "Pick a date"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={bulkScheduledDate}
                      onSelect={setBulkScheduledDate}
                      disabled={(date) => date < new Date()}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>
              <div>
                <label className="text-sm font-medium text-muted-foreground mb-2 block">
                  Time
                </label>
                <Input
                  type="time"
                  value={bulkScheduledTime}
                  onChange={(e) => setBulkScheduledTime(e.target.value)}
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBulkRescheduleDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleBulkReschedule}
              disabled={isBulkRescheduling || !bulkScheduledDate || !bulkScheduledTime}
            >
              {isBulkRescheduling ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Rescheduling...
                </>
              ) : (
                `Reschedule ${selectedPostIds.size} Posts`
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Media Lightbox */}
      <MediaLightboxDialog
        open={lightbox !== null}
        onOpenChange={(o) => !o && setLightbox(null)}
        items={lightbox?.items ?? []}
        initialIndex={lightbox?.index ?? 0}
      />
    </DashboardLayout>
  );
}
