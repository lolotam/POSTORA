import { useState, useEffect, useMemo } from "react";
import { Bell, BellRing, Mail, MessageSquare, History, CheckCircle2, AlertCircle, Info, Zap, Trash2, MessageCircle, Facebook, Camera } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { formatDistanceToNow } from "date-fns";
import { Link, useNavigate } from "react-router-dom";
import {
  useAdminNotifications,
  useMarkNotificationRead,
  useMarkAllNotificationsRead,
  useBlogPosts,
  useMarkBlogPostRead,
} from "@/hooks/useNotifications";
import { usePushNotifications, useNewPostNotifications } from "@/hooks/usePushNotifications";
import { useAdminEmailNotifications } from "@/hooks/useAdminEmailNotifications";
import { useSupportMessageNotifications } from "@/hooks/useSupportMessageNotifications";
import { useUserRole } from "@/hooks/useUserRole";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useNotificationHistoryStore, ActivityNotification } from "@/stores/notificationHistoryStore";
import { useMessagingAccounts, useConversations, useMarkConversationRead } from "@/hooks/useMessaging";

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { data: notifications = [], isLoading: notifLoading } = useAdminNotifications();
  const { data: blogPosts = [], isLoading: blogLoading } = useBlogPosts(true);
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();
  const markBlogPostRead = useMarkBlogPostRead();
  const { toast } = useToast();
  const { isAdmin } = useUserRole();
  
  // Admin email notifications
  const { 
    emails: adminEmails = [], 
    unreadCount: unreadEmailCount, 
    isLoading: emailsLoading,
    markAsRead: markEmailAsRead 
  } = useAdminEmailNotifications();

  // Support message notifications
  const {
    messages: supportMessages = [],
    openCount: openSupportCount,
    isLoading: supportLoading,
    markAsInProgress: markSupportAsInProgress,
  } = useSupportMessageNotifications();

  // Activity history store
  const {
    notifications: activityNotifications,
    markAsRead: markActivityRead,
    markAllAsRead: markAllActivityRead,
    clearAll: clearActivityHistory,
  } = useNotificationHistoryStore();
  
  
  // Messaging accounts & unread count
  const { accounts: messagingAccounts } = useMessagingAccounts();
  const firstFbAccount = messagingAccounts.find((a) => a.platform === "facebook");
  const firstIgAccount = messagingAccounts.find((a) => a.platform === "instagram");
  const firstWaAccount = messagingAccounts.find((a) => a.platform === "whatsapp");
  const { data: fbConversations = [] } = useConversations(firstFbAccount?.id || null, "MESSENGER", { silent: true });
  const { data: igConversations = [] } = useConversations(firstIgAccount?.id || null, "INSTAGRAM", { silent: true });
  const { data: waConversations = [] } = useConversations(firstWaAccount?.id || null, "WHATSAPP", { silent: true });
  const unreadMessagesCount = [...fbConversations, ...igConversations, ...waConversations].reduce((sum, c) => sum + (c.unread_count || 0), 0);

  // Push notifications
  const { isSupported, isEnabled, permission, requestPermission, disableNotifications } = usePushNotifications();
  const { notifyNewPost } = useNewPostNotifications();
  const [lastBlogPostCount, setLastBlogPostCount] = useState<number | null>(null);

  // Watch for new blog posts and send push notification
  useEffect(() => {
    if (!isEnabled || blogLoading) return;
    
    const currentCount = blogPosts.length;
    
    // Only notify if we have a previous count and there's a new post
    if (lastBlogPostCount !== null && currentCount > lastBlogPostCount) {
      const newestPost = blogPosts[0];
      if (newestPost && !newestPost.is_read) {
        notifyNewPost({
          id: newestPost.id,
          title: newestPost.title,
          excerpt: newestPost.excerpt,
        });
      }
    }
    
    setLastBlogPostCount(currentCount);
  }, [blogPosts, blogLoading, isEnabled, lastBlogPostCount, notifyNewPost]);

  const unreadNotifCount = notifications.filter((n) => !n.is_read).length;
  const unreadBlogCount = blogPosts.filter((p) => !p.is_read).length;

  // Filter feature-flag entries from the Activity list for non-admins (strict type match).
  // Admins see the full list.
  const visibleActivity = useMemo(
    () =>
      isAdmin
        ? activityNotifications
        : activityNotifications.filter((n) => n.type !== "feature_flag"),
    [activityNotifications, isAdmin]
  );

  const unreadActivityCount = useMemo(
    () => visibleActivity.filter((n) => !n.read).length,
    [visibleActivity]
  );

  // Hide Activity tab only when a non-admin has nothing to show.
  const showActivityTab = isAdmin || visibleActivity.length > 0;

  const totalUnreadCount =
    unreadNotifCount +
    unreadBlogCount +
    (showActivityTab ? unreadActivityCount : 0) +
    unreadMessagesCount +
    (isAdmin ? unreadEmailCount + openSupportCount : 0);

  const markConversationRead = useMarkConversationRead();

  const handleMessagingClick = (platform: "facebook" | "instagram" | "whatsapp", conv?: { id: string; unread_count: number }) => {
    // Mark WhatsApp conversations as read when clicking
    if (platform === "whatsapp" && conv && conv.unread_count > 0 && firstWaAccount) {
      markConversationRead.mutate({
        socialAccountId: firstWaAccount.id,
        conversationId: conv.id,
      });
    }
    setOpen(false);
    navigate(`/messaging/${platform}`);
  };
  const handleSupportMessageClick = (messageId: string) => {
    markSupportAsInProgress(messageId);
    setOpen(false);
    navigate("/admin/messages");
  };
  

  const handleNotificationClick = (notificationId: string, isRead: boolean) => {
    if (!isRead) {
      markRead.mutate(notificationId);
    }
  };

  const handleEmailClick = (emailId: string, isRead: boolean) => {
    if (!isRead) {
      markEmailAsRead(emailId);
    }
    setOpen(false);
    navigate("/admin/inbox");
  };

  const handleTogglePushNotifications = async () => {
    if (isEnabled) {
      disableNotifications();
      toast({ title: "Push notifications disabled" });
    } else {
      const granted = await requestPermission();
      if (granted) {
        toast({ title: "Push notifications enabled", description: "You'll be notified when new updates are posted" });
      } else if (permission === "denied") {
        toast({ 
          title: "Notifications blocked", 
          description: "Please enable notifications in your browser settings",
          variant: "destructive" 
        });
      }
    }
  };

  const getActivityIcon = (notification: ActivityNotification) => {
    if (notification.type === 'feature_flag') {
      return notification.variant === 'success' ? (
        <CheckCircle2 className="h-4 w-4 text-green-500" />
      ) : (
        <AlertCircle className="h-4 w-4 text-destructive" />
      );
    }
    if (notification.type === 'system') {
      return <Info className="h-4 w-4 text-blue-500" />;
    }
    return <Zap className="h-4 w-4 text-primary" />;
  };

  // Determine grid columns based on which tabs are actually rendered.
  // Always-on: Inbox, Updates, DMs (3). Plus optional: Emails (admin), Support (admin), Activity (admin or has entries).
  const visibleTabCount =
    3 + (isAdmin ? 2 : 0) + (showActivityTab ? 1 : 0);
  const tabsGridClass =
    visibleTabCount === 6
      ? "grid-cols-6"
      : visibleTabCount === 5
      ? "grid-cols-5"
      : visibleTabCount === 4
      ? "grid-cols-4"
      : "grid-cols-3";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative h-9 w-9">
          <Bell className="h-5 w-5" />
          {totalUnreadCount > 0 && (
            <span className="absolute -top-0.5 -end-0.5 h-4 w-4 rounded-full bg-destructive text-[10px] font-semibold text-destructive-foreground flex items-center justify-center">
              {totalUnreadCount > 9 ? "9+" : totalUnreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[420px] p-0" align="end">
        <Tabs defaultValue={isAdmin && (unreadEmailCount > 0 || openSupportCount > 0) ? (unreadEmailCount > 0 ? "emails" : "support") : "inbox"} className="w-full">
          <TabsList className={cn("w-full grid h-12 rounded-none border-b", tabsGridClass)}>
            {isAdmin && (
              <TabsTrigger value="emails" className="rounded-none data-[state=active]:border-b-2 data-[state=active]:border-primary gap-1 text-xs px-2">
                <Mail className="h-3 w-3" />
                Emails
                {unreadEmailCount > 0 && (
                  <Badge variant="destructive" className="ms-0.5 h-4 px-1 text-[10px]">
                    {unreadEmailCount}
                  </Badge>
                )}
              </TabsTrigger>
            )}
            {isAdmin && (
              <TabsTrigger value="support" className="rounded-none data-[state=active]:border-b-2 data-[state=active]:border-primary gap-1 text-xs px-2">
                <MessageSquare className="h-3 w-3" />
                Support
                {openSupportCount > 0 && (
                  <Badge variant="destructive" className="ms-0.5 h-4 px-1 text-[10px]">
                    {openSupportCount}
                  </Badge>
                )}
              </TabsTrigger>
            )}
            <TabsTrigger value="inbox" className="rounded-none data-[state=active]:border-b-2 data-[state=active]:border-primary text-xs px-2">
              Inbox
              {unreadNotifCount > 0 && (
                <Badge variant="secondary" className="ms-1 h-4 px-1 text-[10px]">
                  {unreadNotifCount}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="whats-new" className="rounded-none data-[state=active]:border-b-2 data-[state=active]:border-primary text-xs px-2">
              Updates
              {unreadBlogCount > 0 && (
                <Badge variant="destructive" className="ms-1 h-4 px-1 text-[10px]">
                  {unreadBlogCount}
                </Badge>
              )}
            </TabsTrigger>
            {showActivityTab && (
              <TabsTrigger value="activity" className="rounded-none data-[state=active]:border-b-2 data-[state=active]:border-primary gap-1 text-xs px-2">
                <History className="h-3 w-3" />
                Activity
                {unreadActivityCount > 0 && (
                  <Badge variant="secondary" className="ms-0.5 h-4 px-1 text-[10px]">
                    {unreadActivityCount}
                  </Badge>
                )}
              </TabsTrigger>
            )}
            <TabsTrigger value="messages" className="rounded-none data-[state=active]:border-b-2 data-[state=active]:border-primary gap-1 text-xs px-2">
              <MessageCircle className="h-3 w-3" />
              DMs
              {unreadMessagesCount > 0 && (
                <Badge variant="destructive" className="ms-0.5 h-4 px-1 text-[10px]">
                  {unreadMessagesCount}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>

          {/* Admin Emails Tab */}
          {isAdmin && (
            <TabsContent value="emails" className="m-0">
              <ScrollArea className="h-[350px]">
                {emailsLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <div className="animate-spin h-5 w-5 border-2 border-primary border-t-transparent rounded-full" />
                  </div>
                ) : adminEmails.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                    <Mail className="h-8 w-8 mb-2 opacity-50" />
                    <p className="text-sm">No emails yet</p>
                  </div>
                ) : (
                  <div className="divide-y">
                    {adminEmails.map((email) => (
                      <div
                        key={email.id}
                        className={cn(
                          "px-4 py-3 hover:bg-muted/50 cursor-pointer transition-colors",
                          !email.is_read && "bg-primary/5"
                        )}
                        onClick={() => handleEmailClick(email.id, email.is_read)}
                      >
                        <div className="flex items-start gap-2">
                          {!email.is_read && (
                            <span className="mt-1.5 h-2 w-2 rounded-full bg-destructive flex-shrink-0" />
                          )}
                          <div className={cn("flex-1 min-w-0", email.is_read && "ms-4")}>
                            <p className="font-medium text-sm line-clamp-1">{email.from_email}</p>
                            <p className="text-sm text-foreground line-clamp-1 mt-0.5">
                              {email.subject || "(No subject)"}
                            </p>
                            {email.body && (
                              <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
                                {email.body.substring(0, 100)}
                              </p>
                            )}
                            <p className="text-xs text-muted-foreground mt-1">
                              {formatDistanceToNow(new Date(email.created_at), { addSuffix: true })}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </ScrollArea>
              <div className="px-4 py-3 border-t">
                <Link
                  to="/admin/inbox"
                  onClick={() => setOpen(false)}
                  className="text-sm text-primary hover:underline"
                >
                  Open full inbox →
                </Link>
              </div>
            </TabsContent>
          )}

          {/* Admin Support Messages Tab */}
          {isAdmin && (
            <TabsContent value="support" className="m-0">
              <ScrollArea className="h-[350px]">
                {supportLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <div className="animate-spin h-5 w-5 border-2 border-primary border-t-transparent rounded-full" />
                  </div>
                ) : supportMessages.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                    <MessageSquare className="h-8 w-8 mb-2 opacity-50" />
                    <p className="text-sm">No open support messages</p>
                  </div>
                ) : (
                  <div className="divide-y">
                    {supportMessages.map((msg) => (
                      <div
                        key={msg.id}
                        className="px-4 py-3 hover:bg-muted/50 cursor-pointer transition-colors bg-primary/5"
                        onClick={() => handleSupportMessageClick(msg.id)}
                      >
                        <div className="flex items-start gap-2">
                          <span className="mt-1.5 h-2 w-2 rounded-full bg-destructive flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-sm line-clamp-1">{msg.email || "Unknown"}</p>
                            <p className="text-sm text-foreground line-clamp-1 mt-0.5">
                              {msg.subject}
                            </p>
                            <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
                              {msg.message.substring(0, 100)}
                            </p>
                            <p className="text-xs text-muted-foreground mt-1">
                              {formatDistanceToNow(new Date(msg.created_at), { addSuffix: true })}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </ScrollArea>
              <div className="px-4 py-3 border-t">
                <Link
                  to="/admin/messages"
                  onClick={() => setOpen(false)}
                  className="text-sm text-primary hover:underline"
                >
                  View all support messages →
                </Link>
              </div>
            </TabsContent>
          )}

          <TabsContent value="inbox" className="m-0">
            {unreadNotifCount > 0 && (
              <div className="px-4 py-2 border-b">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => markAllRead.mutate()}
                  disabled={markAllRead.isPending}
                >
                  Mark all as read
                </Button>
              </div>
            )}
            <ScrollArea className="h-[350px]">
              {notifLoading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="animate-spin h-5 w-5 border-2 border-primary border-t-transparent rounded-full" />
                </div>
              ) : notifications.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <Bell className="h-8 w-8 mb-2 opacity-50" />
                  <p className="text-sm">No notifications yet</p>
                </div>
              ) : (
                <div className="divide-y">
                  {notifications.map((notification) => (
                    <div
                      key={notification.id}
                      className={cn(
                        "px-4 py-3 hover:bg-muted/50 cursor-pointer transition-colors",
                        !notification.is_read && "bg-primary/5"
                      )}
                      onClick={() => handleNotificationClick(notification.id, notification.is_read || false)}
                    >
                      <div className="flex items-start gap-2">
                        {!notification.is_read && (
                          <span className="mt-1.5 h-2 w-2 rounded-full bg-primary flex-shrink-0" />
                        )}
                        <div className={cn("flex-1 min-w-0", notification.is_read && "ms-4")}>
                          <p className="font-medium text-sm line-clamp-1">{notification.title}</p>
                          <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                            {notification.message}
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">
                            {formatDistanceToNow(new Date(notification.created_at), { addSuffix: true })}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </TabsContent>

          <TabsContent value="whats-new" className="m-0">
            <ScrollArea className="h-[350px]">
              {blogLoading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="animate-spin h-5 w-5 border-2 border-primary border-t-transparent rounded-full" />
                </div>
              ) : blogPosts.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <p className="text-sm">No updates yet</p>
                </div>
              ) : (
                <div className="divide-y">
                  {blogPosts.slice(0, 10).map((post) => (
                    <Link
                      key={post.id}
                      to={`/whats-new/${post.id}`}
                      onClick={() => {
                        if (!post.is_read) {
                          markBlogPostRead.mutate(post.id);
                        }
                        setOpen(false);
                      }}
                      className={cn(
                        "flex gap-3 px-4 py-3 hover:bg-muted/50 transition-colors",
                        !post.is_read && "bg-primary/5"
                      )}
                    >
                      {/* Unread indicator */}
                      {!post.is_read && (
                        <span className="mt-2 h-2 w-2 rounded-full bg-destructive flex-shrink-0" />
                      )}
                      {post.cover_image_url && (
                        <div className="w-16 h-16 rounded-lg overflow-hidden flex-shrink-0 bg-muted">
                          <img
                            src={post.cover_image_url}
                            alt={post.title}
                            className="w-full h-full object-cover"
                          />
                        </div>
                      )}
                      <div className={cn("flex-1 min-w-0", post.is_read && !post.cover_image_url && "ms-4")}>
                        <p className="font-medium text-sm line-clamp-2">{post.title}</p>
                        {post.excerpt && (
                          <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                            {post.excerpt}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground mt-1">
                          {formatDistanceToNow(new Date(post.created_at), { addSuffix: true })}
                        </p>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </ScrollArea>
            {/* Push Notification Toggle & View All */}
            <div className="px-4 py-3 border-t space-y-3">
              {isSupported && (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <BellRing className="w-4 h-4 text-muted-foreground" />
                    <Label htmlFor="push-notifications" className="text-sm cursor-pointer">
                      Push notifications
                    </Label>
                  </div>
                  <Switch
                    id="push-notifications"
                    checked={isEnabled}
                    onCheckedChange={handleTogglePushNotifications}
                  />
                </div>
              )}
              {blogPosts.length > 0 && (
                <Link
                  to="/whats-new"
                  onClick={() => setOpen(false)}
                  className="text-sm text-primary hover:underline block"
                >
                  View all updates →
                </Link>
              )}
            </div>
          </TabsContent>

          {/* Activity History Tab — hidden for non-admins with no entries */}
          {showActivityTab && (
          <TabsContent value="activity" className="m-0">
            {(unreadActivityCount > 0 || visibleActivity.length > 0) && (
              <div className="px-4 py-2 border-b flex items-center justify-between">
                {unreadActivityCount > 0 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs text-muted-foreground hover:text-foreground"
                    onClick={markAllActivityRead}
                  >
                    Mark all as read
                  </Button>
                ) : <span />}
                {visibleActivity.length > 0 && isAdmin && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs text-muted-foreground hover:text-destructive"
                    onClick={clearActivityHistory}
                  >
                    <Trash2 className="h-3 w-3 me-1" />
                    Clear
                  </Button>
                )}
              </div>
            )}
            <ScrollArea className="h-[350px]">
              {visibleActivity.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <History className="h-8 w-8 mb-2 opacity-50" />
                  <p className="text-sm">No activity yet</p>
                  {isAdmin && (
                    <p className="text-xs mt-1">Feature changes will appear here</p>
                  )}
                </div>
              ) : (
                <div className="divide-y">
                  {visibleActivity.map((notification) => (
                    <div
                      key={notification.id}
                      className={cn(
                        "px-4 py-3 hover:bg-muted/50 cursor-pointer transition-colors",
                        !notification.read && "bg-primary/5"
                      )}
                      onClick={() => markActivityRead(notification.id)}
                    >
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5">
                          {getActivityIcon(notification)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="font-medium text-sm">{notification.title}</p>
                            {!notification.read && (
                              <span className="h-2 w-2 rounded-full bg-primary flex-shrink-0" />
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {notification.description}
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">
                            {formatDistanceToNow(new Date(notification.timestamp), { addSuffix: true })}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </TabsContent>
          )}

          {/* Messages Tab */}
          <TabsContent value="messages" className="m-0">
            <ScrollArea className="h-[350px]">
              {[...fbConversations, ...igConversations, ...waConversations].length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <MessageCircle className="h-8 w-8 mb-2 opacity-50" />
                  <p className="text-sm">No messages yet</p>
                  <p className="text-xs mt-1">Connect Facebook, Instagram, or WhatsApp to see messages</p>
                </div>
              ) : (
                <div className="divide-y">
                  {fbConversations.filter((c) => c.unread_count > 0).map((conv) => (
                    <div
                      key={conv.id}
                      className="px-4 py-3 hover:bg-muted/50 cursor-pointer transition-colors bg-primary/5"
                      onClick={() => handleMessagingClick("facebook")}
                    >
                      <div className="flex items-start gap-2">
                        <span className="mt-1.5 h-2 w-2 rounded-full bg-destructive flex-shrink-0" />
                        <Facebook className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm line-clamp-1">{conv.participant_name}</p>
                          <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{conv.last_message}</p>
                          <p className="text-xs text-muted-foreground mt-1">
                            {conv.last_message_time ? formatDistanceToNow(new Date(conv.last_message_time), { addSuffix: true }) : ""}
                          </p>
                        </div>
                        <Badge variant="destructive" className="h-5 px-1.5 text-[10px] shrink-0">
                          {conv.unread_count}
                        </Badge>
                      </div>
                    </div>
                  ))}
                  {igConversations.filter((c) => c.unread_count > 0).map((conv) => (
                    <div
                      key={conv.id}
                      className="px-4 py-3 hover:bg-muted/50 cursor-pointer transition-colors bg-primary/5"
                      onClick={() => handleMessagingClick("instagram")}
                    >
                      <div className="flex items-start gap-2">
                        <span className="mt-1.5 h-2 w-2 rounded-full bg-destructive flex-shrink-0" />
                        <Camera className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm line-clamp-1">{conv.participant_name}</p>
                          <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{conv.last_message}</p>
                          <p className="text-xs text-muted-foreground mt-1">
                            {conv.last_message_time ? formatDistanceToNow(new Date(conv.last_message_time), { addSuffix: true }) : ""}
                          </p>
                        </div>
                        <Badge variant="destructive" className="h-5 px-1.5 text-[10px] shrink-0">
                          {conv.unread_count}
                        </Badge>
                      </div>
                    </div>
                  ))}
                  {waConversations.filter((c) => c.unread_count > 0).map((conv) => (
                    <div
                      key={conv.id}
                      className="px-4 py-3 hover:bg-muted/50 cursor-pointer transition-colors bg-primary/5"
                      onClick={() => handleMessagingClick("whatsapp", conv)}
                    >
                      <div className="flex items-start gap-2">
                        <span className="mt-1.5 h-2 w-2 rounded-full bg-green-500 flex-shrink-0" />
                        <MessageSquare className="h-4 w-4 mt-0.5 text-green-600 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm line-clamp-1">{conv.participant_name}</p>
                          <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{conv.last_message}</p>
                          <p className="text-xs text-muted-foreground mt-1">
                            {conv.last_message_time ? formatDistanceToNow(new Date(conv.last_message_time), { addSuffix: true }) : ""}
                          </p>
                        </div>
                        <Badge variant="destructive" className="h-5 px-1.5 text-[10px] shrink-0">
                          {conv.unread_count}
                        </Badge>
                      </div>
                    </div>
                  ))}
                  {/* Show read conversations too */}
                  {[...fbConversations, ...igConversations, ...waConversations].filter((c) => c.unread_count === 0).slice(0, 5).map((conv) => {
                    const isFb = fbConversations.some((f) => f.id === conv.id);
                    const isWa = waConversations.some((w) => w.id === conv.id);
                    const platform = isFb ? "facebook" : isWa ? "whatsapp" : "instagram";
                    return (
                      <div
                        key={conv.id}
                        className="px-4 py-3 hover:bg-muted/50 cursor-pointer transition-colors"
                        onClick={() => handleMessagingClick(platform)}
                      >
                        <div className="flex items-start gap-2 ms-4">
                          {isFb ? <Facebook className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" /> : isWa ? <MessageSquare className="h-4 w-4 mt-0.5 text-green-600 shrink-0" /> : <Camera className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />}
                          <div className="flex-1 min-w-0">
                            <p className="text-sm line-clamp-1">{conv.participant_name}</p>
                            <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{conv.last_message}</p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
            <div className="px-4 py-3 border-t">
              <button
                onClick={() => handleMessagingClick("facebook")}
                className="text-sm text-primary hover:underline"
              >
                Open full inbox →
              </button>
            </div>
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}
