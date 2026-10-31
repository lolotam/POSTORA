import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";

export interface AdminNotification {
  id: string;
  title: string;
  message: string;
  created_at: string;
  created_by: string | null;
  is_read?: boolean;
}

export interface BlogPost {
  id: string;
  title: string;
  content: string;
  excerpt: string | null;
  cover_image_url: string | null;
  status: "draft" | "published" | "scheduled";
  scheduled_at?: string | null;
  author_id: string | null;
  created_at: string;
  updated_at: string;
  is_read?: boolean;
}

export function useAdminNotifications() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["admin_notifications", user?.id],
    queryFn: async () => {
      if (!user) return [];

      // Fetch all notifications
      const { data: notifications, error: notifError } = await supabase
        .from("admin_notifications")
        .select("*")
        .order("created_at", { ascending: false });

      if (notifError) throw notifError;

      // Fetch user's read status
      const { data: reads } = await supabase
        .from("user_notification_reads")
        .select("notification_id")
        .eq("user_id", user.id);

      const readIds = new Set((reads || []).map((r) => r.notification_id));

      return (notifications || []).map((n) => ({
        ...n,
        is_read: readIds.has(n.id),
      })) as AdminNotification[];
    },
    enabled: !!user,
  });
}

export function useUnreadNotificationCount() {
  const { data: notifications = [] } = useAdminNotifications();
  return notifications.filter((n) => !n.is_read).length;
}

export function useMarkNotificationRead() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (notificationId: string) => {
      if (!user) throw new Error("Not authenticated");

      const { error } = await supabase
        .from("user_notification_reads")
        .insert({ user_id: user.id, notification_id: notificationId });

      // Ignore unique constraint violation (already read)
      if (error && !error.message.includes("duplicate")) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin_notifications"] });
    },
  });
}

export function useMarkAllNotificationsRead() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: notifications = [] } = useAdminNotifications();

  return useMutation({
    mutationFn: async () => {
      if (!user) throw new Error("Not authenticated");

      const unreadIds = notifications.filter((n) => !n.is_read).map((n) => n.id);
      if (unreadIds.length === 0) return;

      const inserts = unreadIds.map((notificationId) => ({
        user_id: user.id,
        notification_id: notificationId,
      }));

      const { error } = await supabase
        .from("user_notification_reads")
        .insert(inserts);

      // Ignore unique constraint violations
      if (error && !error.message.includes("duplicate")) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin_notifications"] });
    },
  });
}

export function useBlogPosts(publishedOnly = true) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["blog_posts", publishedOnly, user?.id],
    queryFn: async () => {
      let query = supabase
        .from("blog_posts")
        .select("*")
        .order("created_at", { ascending: false });

      if (publishedOnly) {
        // Show published posts OR scheduled posts whose time has passed
        query = query.or(`status.eq.published,and(status.eq.scheduled,scheduled_at.lte.${new Date().toISOString()})`);
      }

      const { data: posts, error } = await query;
      if (error) throw error;
      if (!posts) return [];

      // If user is logged in, fetch which posts they've read
      if (user) {
        const { data: reads } = await supabase
          .from("user_blog_post_reads")
          .select("blog_post_id")
          .eq("user_id", user.id);

        const readIds = new Set((reads || []).map((r) => r.blog_post_id));

        return posts.map((p) => ({
          ...p,
          is_read: readIds.has(p.id),
        })) as BlogPost[];
      }

      return posts as BlogPost[];
    },
  });
}

// Fetch scheduled posts for admin preview
export function useScheduledBlogPosts() {
  return useQuery({
    queryKey: ["scheduled_blog_posts"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("blog_posts")
        .select("*")
        .eq("status", "scheduled")
        .gt("scheduled_at", new Date().toISOString())
        .order("scheduled_at", { ascending: true });

      if (error) throw error;
      return (data || []) as BlogPost[];
    },
  });
}

export function useMarkBlogPostRead() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (blogPostId: string) => {
      if (!user) throw new Error("Not authenticated");

      const { error } = await supabase
        .from("user_blog_post_reads")
        .insert({ user_id: user.id, blog_post_id: blogPostId });

      // Ignore unique constraint violation (already read)
      if (error && !error.message.includes("duplicate")) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["blog_posts"] });
    },
  });
}

export function useUnreadBlogPostCount() {
  const { data: blogPosts = [] } = useBlogPosts(true);
  return blogPosts.filter((p) => !p.is_read).length;
}

export function useBlogPost(id: string | undefined) {
  return useQuery({
    queryKey: ["blog_post", id],
    queryFn: async () => {
      if (!id) return null;

      const { data, error } = await supabase
        .from("blog_posts")
        .select("*")
        .eq("id", id)
        .single();

      if (error) throw error;
      return data as BlogPost;
    },
    enabled: !!id,
  });
}

export function useCreateBlogPost() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (post: Omit<BlogPost, "id" | "created_at" | "updated_at" | "author_id">) => {
      const { is_read, ...insertData } = post;
      const { data, error } = await supabase
        .from("blog_posts")
        .insert({ ...insertData, author_id: user?.id })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["blog_posts"] });
    },
  });
}

export function useUpdateBlogPost() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...post }: Partial<BlogPost> & { id: string }) => {
      const { is_read, ...updateData } = post;
      const { data, error } = await supabase
        .from("blog_posts")
        .update(updateData)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["blog_posts"] });
    },
  });
}

export function useDeleteBlogPost() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("blog_posts").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["blog_posts"] });
    },
  });
}

export function useCreateAdminNotification() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (notification: { title: string; message: string }) => {
      const { data, error } = await supabase
        .from("admin_notifications")
        .insert({ ...notification, created_by: user?.id })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin_notifications"] });
    },
  });
}

export function useDeleteAdminNotification() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("admin_notifications").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin_notifications"] });
    },
  });
}
