import { useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Calendar } from "@/components/ui/calendar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  useBlogPosts,
  useCreateBlogPost,
  useUpdateBlogPost,
  useDeleteBlogPost,
  BlogPost,
} from "@/hooks/useNotifications";
import { useToast } from "@/hooks/use-toast";
import { format, isBefore, startOfDay } from "date-fns";
import { Plus, Pencil, Trash2, Loader2, Newspaper, CalendarIcon, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

export default function AdminBlogPosts() {
  const { data: posts = [], isLoading } = useBlogPosts(false);
  const createPost = useCreateBlogPost();
  const updatePost = useUpdateBlogPost();
  const deletePost = useDeleteBlogPost();
  const { toast } = useToast();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedPost, setSelectedPost] = useState<BlogPost | null>(null);
  const [formData, setFormData] = useState({
    title: "",
    content: "",
    excerpt: "",
    cover_image_url: "",
    status: "draft" as "draft" | "published" | "scheduled",
    scheduled_at: null as Date | null,
    scheduled_time: "09:00",
  });

  const resetForm = () => {
    setFormData({
      title: "",
      content: "",
      excerpt: "",
      cover_image_url: "",
      status: "draft",
      scheduled_at: null,
      scheduled_time: "09:00",
    });
    setSelectedPost(null);
  };

  const openCreateDialog = () => {
    resetForm();
    setDialogOpen(true);
  };

  const openEditDialog = (post: BlogPost) => {
    setSelectedPost(post);
    const scheduledDate = (post as any).scheduled_at ? new Date((post as any).scheduled_at) : null;
    setFormData({
      title: post.title,
      content: post.content,
      excerpt: post.excerpt || "",
      cover_image_url: post.cover_image_url || "",
      status: post.status as "draft" | "published" | "scheduled",
      scheduled_at: scheduledDate,
      scheduled_time: scheduledDate ? format(scheduledDate, "HH:mm") : "09:00",
    });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!formData.title.trim() || !formData.content.trim()) {
      toast({
        title: "Validation error",
        description: "Title and content are required",
        variant: "destructive",
      });
      return;
    }

    if (formData.status === "scheduled" && !formData.scheduled_at) {
      toast({
        title: "Validation error",
        description: "Please select a date for scheduled publishing",
        variant: "destructive",
      });
      return;
    }

    // Build scheduled_at timestamp from date and time
    let scheduledAt: string | null = null;
    if (formData.status === "scheduled" && formData.scheduled_at) {
      const [hours, minutes] = formData.scheduled_time.split(":").map(Number);
      const scheduledDate = new Date(formData.scheduled_at);
      scheduledDate.setHours(hours, minutes, 0, 0);
      scheduledAt = scheduledDate.toISOString();
    }

    try {
      const postData: Partial<BlogPost> = {
        title: formData.title,
        content: formData.content,
        excerpt: formData.excerpt || null,
        cover_image_url: formData.cover_image_url || null,
        status: formData.status as "draft" | "published" | "scheduled",
        scheduled_at: scheduledAt,
      };

      if (selectedPost) {
        await updatePost.mutateAsync({
          id: selectedPost.id,
          ...postData,
        });
        toast({ title: "Post updated successfully" });
      } else {
        await createPost.mutateAsync(postData as any);
        toast({ title: "Post created successfully" });
      }
      setDialogOpen(false);
      resetForm();
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to save post",
        variant: "destructive",
      });
    }
  };

  const handleDelete = async () => {
    if (!selectedPost) return;

    try {
      await deletePost.mutateAsync(selectedPost.id);
      toast({ title: "Post deleted successfully" });
      setDeleteDialogOpen(false);
      setSelectedPost(null);
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to delete post",
        variant: "destructive",
      });
    }
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Blog Posts</h1>
            <p className="text-muted-foreground">
              Manage your "What's New" blog posts
            </p>
          </div>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button onClick={openCreateDialog}>
                <Plus className="w-4 h-4 me-2" />
                New Post
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>
                  {selectedPost ? "Edit Post" : "Create New Post"}
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="title">Title *</Label>
                  <Input
                    id="title"
                    value={formData.title}
                    onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                    placeholder="Enter post title"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="excerpt">Excerpt</Label>
                  <Input
                    id="excerpt"
                    value={formData.excerpt}
                    onChange={(e) => setFormData({ ...formData, excerpt: e.target.value })}
                    placeholder="Short description for preview"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="cover">Cover Image URL</Label>
                  <Input
                    id="cover"
                    value={formData.cover_image_url}
                    onChange={(e) => setFormData({ ...formData, cover_image_url: e.target.value })}
                    placeholder="https://example.com/image.jpg"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="content">Content *</Label>
                  <Textarea
                    id="content"
                    value={formData.content}
                    onChange={(e) => setFormData({ ...formData, content: e.target.value })}
                    placeholder="Write your blog post content..."
                    className="min-h-[200px]"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="status">Status</Label>
                  <Select
                    value={formData.status}
                    onValueChange={(value: "draft" | "published" | "scheduled") =>
                      setFormData({ ...formData, status: value })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="draft">Draft</SelectItem>
                      <SelectItem value="published">Published</SelectItem>
                      <SelectItem value="scheduled">Scheduled</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Scheduled Date Picker */}
                {formData.status === "scheduled" && (
                  <div className="space-y-2 p-4 bg-muted/50 rounded-lg border">
                    <Label className="flex items-center gap-2">
                      <CalendarIcon className="w-4 h-4" />
                      Schedule Publication
                    </Label>
                    <div className="flex gap-3">
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button
                            variant="outline"
                            className={cn(
                              "flex-1 justify-start text-start font-normal",
                              !formData.scheduled_at && "text-muted-foreground"
                            )}
                          >
                            <CalendarIcon className="me-2 h-4 w-4" />
                            {formData.scheduled_at ? (
                              format(formData.scheduled_at, "PPP")
                            ) : (
                              <span>Pick a date</span>
                            )}
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0" align="start">
                          <Calendar
                            mode="single"
                            selected={formData.scheduled_at || undefined}
                            onSelect={(date) =>
                              setFormData({ ...formData, scheduled_at: date || null })
                            }
                            disabled={(date) =>
                              isBefore(date, startOfDay(new Date()))
                            }
                            initialFocus
                          />
                        </PopoverContent>
                      </Popover>
                      <div className="flex items-center gap-2">
                        <Clock className="w-4 h-4 text-muted-foreground" />
                        <Input
                          type="time"
                          value={formData.scheduled_time}
                          onChange={(e) =>
                            setFormData({ ...formData, scheduled_time: e.target.value })
                          }
                          className="w-[120px]"
                        />
                      </div>
                    </div>
                    {formData.scheduled_at && (
                      <p className="text-xs text-muted-foreground">
                        Will be published on{" "}
                        {format(formData.scheduled_at, "PPPP")} at {formData.scheduled_time}
                      </p>
                    )}
                  </div>
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={handleSave}
                  disabled={createPost.isPending || updatePost.isPending}
                >
                  {(createPost.isPending || updatePost.isPending) && (
                    <Loader2 className="w-4 h-4 me-2 animate-spin" />
                  )}
                  {selectedPost ? "Update" : "Create"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        ) : posts.length === 0 ? (
          <div className="text-center py-16 border border-dashed rounded-xl">
            <Newspaper className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">No blog posts yet</h3>
            <p className="text-muted-foreground mb-4">
              Create your first post to share updates with users
            </p>
            <Button onClick={openCreateDialog}>
              <Plus className="w-4 h-4 me-2" />
              Create Post
            </Button>
          </div>
        ) : (
          <div className="border rounded-xl overflow-hidden">
            <table className="w-full">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-start px-4 py-3 text-sm font-medium">Title</th>
                  <th className="text-start px-4 py-3 text-sm font-medium">Status</th>
                  <th className="text-start px-4 py-3 text-sm font-medium">Date</th>
                  <th className="text-end px-4 py-3 text-sm font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {posts.map((post) => (
                  <tr key={post.id} className="hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {post.cover_image_url && (
                          <img
                            src={post.cover_image_url}
                            alt=""
                            className="w-10 h-10 rounded object-cover"
                          />
                        )}
                        <span className="font-medium">{post.title}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-1">
                        <Badge
                          variant={
                            post.status === "published" 
                              ? "default" 
                              : post.status === "scheduled" 
                                ? "outline" 
                                : "secondary"
                          }
                          className={cn(
                            post.status === "scheduled" && "border-amber-500 text-amber-600"
                          )}
                        >
                          {post.status}
                        </Badge>
                        {post.status === "scheduled" && (post as any).scheduled_at && (
                          <span className="text-xs text-muted-foreground">
                            {format(new Date((post as any).scheduled_at), "MMM d, h:mm a")}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {format(new Date(post.created_at), "MMM d, yyyy")}
                    </td>
                    <td className="px-4 py-3 text-end">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => openEditDialog(post)}
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            setSelectedPost(post);
                            setDeleteDialogOpen(true);
                          }}
                        >
                          <Trash2 className="w-4 h-4 text-destructive" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Blog Post</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete "{selectedPost?.title}"? This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDelete}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {deletePost.isPending && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </AdminLayout>
  );
}
