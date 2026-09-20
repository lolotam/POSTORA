import { useState } from "react";
import { useTranslation } from "react-i18next";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { PlatformIcon, getPlatformName } from "@/components/PlatformIcon";
import { Platform } from "@/lib/types";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  FileText,
  Plus,
  Pencil,
  Trash2,
  Copy,
  Loader2,
  Search,
  Send,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { format } from "date-fns";

const platforms: Platform[] = ["instagram", "facebook", "tiktok", "twitter", "linkedin"];

interface Template {
  id: string;
  name: string;
  caption: string;
  platforms: string[];
  hashtags: string[];
  created_at: string;
  updated_at: string;
}

export default function Templates() {
  const { t } = useTranslation("assets");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);
  const [name, setName] = useState("");
  const [caption, setCaption] = useState("");
  const [selectedPlatforms, setSelectedPlatforms] = useState<Platform[]>([]);
  const [hashtagsInput, setHashtagsInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Fetch templates
  const { data: templates = [], isLoading } = useQuery({
    queryKey: ["templates", user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await supabase
        .from("post_templates")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as Template[];
    },
    enabled: !!user,
  });

  // Filter templates by search
  const filteredTemplates = templates.filter(
    (t) =>
      t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.caption.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const resetForm = () => {
    setName("");
    setCaption("");
    setSelectedPlatforms([]);
    setHashtagsInput("");
    setEditingTemplate(null);
  };

  const openCreateDialog = () => {
    resetForm();
    setDialogOpen(true);
  };

  const openEditDialog = (template: Template) => {
    setEditingTemplate(template);
    setName(template.name);
    setCaption(template.caption);
    setSelectedPlatforms(template.platforms as Platform[]);
    setHashtagsInput(template.hashtags.join(", "));
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!user || !name.trim() || !caption.trim()) {
      toast({
        title: t("toast.missingFields", "Missing fields"),
        description: t("toast.missingFieldsDesc", "Please fill in template name and caption."),
        variant: "destructive",
      });
      return;
    }

    setIsSaving(true);

    const hashtags = hashtagsInput
      .split(",")
      .map((h) => h.trim())
      .filter((h) => h.length > 0);

    try {
      if (editingTemplate) {
        // Update
        const { error } = await supabase
          .from("post_templates")
          .update({
            name,
            caption,
            platforms: selectedPlatforms,
            hashtags,
          })
          .eq("id", editingTemplate.id);
        if (error) throw error;
        toast({ title: t("toast.templateUpdated", "Template updated!") });
      } else {
        // Create
        const { error } = await supabase.from("post_templates").insert({
          user_id: user.id,
          name,
          caption,
          platforms: selectedPlatforms,
          hashtags,
        });
        if (error) throw error;
        toast({ title: t("toast.templateCreated", "Template created!") });
      }

      queryClient.invalidateQueries({ queryKey: ["templates"] });
      setDialogOpen(false);
      resetForm();
    } catch (error) {
      console.error("Save error:", error);
      toast({
        title: t("toast.templateSaveFailed", "Failed to save"),
        description: error instanceof Error ? error.message : t("errors.unknownError", "Unknown error"),
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const { error } = await supabase
        .from("post_templates")
        .delete()
        .eq("id", id);
      if (error) throw error;

      queryClient.invalidateQueries({ queryKey: ["templates"] });
      toast({ title: t("toast.templateDeleted", "Template deleted") });
    } catch (error) {
      toast({
        title: t("toast.deleteFailed", "Failed to delete"),
        description: error instanceof Error ? error.message : t("errors.unknownError", "Unknown error"),
        variant: "destructive",
      });
    }
  };

  const handleCopy = async (template: Template) => {
    await navigator.clipboard.writeText(template.caption);
    toast({ title: t("toast.captionCopied", "Caption copied to clipboard!") });
  };

  const togglePlatform = (platform: Platform) => {
    setSelectedPlatforms((prev) =>
      prev.includes(platform)
        ? prev.filter((p) => p !== platform)
        : [...prev, platform]
    );
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold">{t("templates.title", "Post Templates")}</h1>
            <p className="text-muted-foreground mt-1">
              {t("templates.subtitle", "Save and reuse your best captions")}
            </p>
          </div>

          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="gradient" onClick={openCreateDialog}>
                <Plus className="w-4 h-4 mr-2" />
                {t("templates.newTemplate", "New Template")}
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <FileText className="w-5 h-5 text-primary" />
                  {editingTemplate ? t("templates.editTitle", "Edit Template") : t("templates.createTitle", "Create Template")}
                </DialogTitle>
              </DialogHeader>

              <div className="space-y-4 pt-4">
                <div className="space-y-2">
                  <Label>{t("templates.name", "Template Name")}</Label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t("templates.namePlaceholder", "e.g., Product Launch, Weekly Quote...")}
                  />
                </div>

                <div className="space-y-2">
                  <Label>{t("templates.caption", "Caption")}</Label>
                  <Textarea
                    value={caption}
                    onChange={(e) => setCaption(e.target.value)}
                    placeholder={t("templates.captionPlaceholder", "Write your reusable caption here...")}
                    className="min-h-[120px]"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("templates.placeholderTip", "Tip: Use placeholders like {{product}} or {{date}} for dynamic content", { product: "{{product}}", date: "{{date}}" })}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>{t("templates.defaultPlatforms", "Default Platforms")}</Label>
                  <div className="flex flex-wrap gap-2">
                    {platforms.map((platform) => (
                      <label
                        key={platform}
                        className={cn(
                          "flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer border transition-colors",
                          selectedPlatforms.includes(platform)
                            ? "bg-primary/10 border-primary/30"
                            : "bg-secondary/50 border-transparent hover:bg-secondary"
                        )}
                      >
                        <Checkbox
                          checked={selectedPlatforms.includes(platform)}
                          onCheckedChange={() => togglePlatform(platform)}
                        />
                        <PlatformIcon platform={platform} size="sm" />
                        <span className="text-sm">{getPlatformName(platform)}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>{t("templates.defaultHashtags", "Default Hashtags")}</Label>
                  <Input
                    value={hashtagsInput}
                    onChange={(e) => setHashtagsInput(e.target.value)}
                    placeholder={t("templates.hashtagsPlaceholder", "#marketing, #socialmedia, #tips")}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("templates.hashtagsHint", "Separate hashtags with commas")}
                  </p>
                </div>

                <Button
                  onClick={handleSave}
                  disabled={isSaving}
                  className="w-full"
                >
                  {isSaving ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      {t("common:saving", "Saving...")}
                    </>
                  ) : editingTemplate ? (
                    t("templates.updateTemplate", "Update Template")
                  ) : (
                    t("templates.createTitle", "Create Template")
                  )}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {/* Search */}
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("form.searchTemplates", "Search templates...")}
            className="pl-10"
          />
        </div>

        {/* Templates Grid */}
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        ) : filteredTemplates.length === 0 ? (
          <div className="text-center py-16">
            <FileText className="w-16 h-16 mx-auto text-muted-foreground/50 mb-4" />
            <h3 className="text-lg font-semibold mb-2">
              {searchQuery ? t("empty.noTemplates", "No templates found") : t("empty.noTemplatesYet", "No templates yet")}
            </h3>
            <p className="text-muted-foreground mb-6">
              {searchQuery
                ? t("empty.tryDifferentSearch", "Try a different search term")
                : t("templates.createFirst", "Create your first template to get started")}
            </p>
            {!searchQuery && (
              <Button onClick={openCreateDialog}>
                <Plus className="w-4 h-4 mr-2" />
                {t("templates.createTitle", "Create Template")}
              </Button>
            )}
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredTemplates.map((template) => (
              <Card
                key={template.id}
                className="p-5 bg-card/50 border-border group hover:border-primary/30 transition-colors"
              >
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="font-semibold">{template.name}</h3>
                    <p className="text-xs text-muted-foreground">
                      {t("templates.updated", "Updated {{date}}", { date: format(new Date(template.updated_at), "MMM d, yyyy") })}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      aria-label={t("common:copy", "Copy")}
                      onClick={() => handleCopy(template)}
                    >
                      <Copy className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      aria-label={t("common:edit", "Edit")}
                      onClick={() => openEditDialog(template)}
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      aria-label={t("common:delete", "Delete")}
                      onClick={() => handleDelete(template.id)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>

                <p className="text-sm text-muted-foreground line-clamp-3 mb-3">
                  {template.caption}
                </p>

                {template.platforms.length > 0 && (
                  <div className="flex items-center gap-1 mb-3">
                    {template.platforms.map((p) => (
                      <div
                        key={p}
                        className="w-6 h-6 rounded bg-secondary flex items-center justify-center"
                      >
                        <PlatformIcon platform={p as Platform} size="xs" />
                      </div>
                    ))}
                  </div>
                )}

                {template.hashtags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {template.hashtags.slice(0, 5).map((hashtag) => (
                      <Badge key={hashtag} variant="secondary" className="text-xs">
                        {hashtag}
                      </Badge>
                    ))}
                    {template.hashtags.length > 5 && (
                      <Badge variant="outline" className="text-xs">
                        +{template.hashtags.length - 5}
                      </Badge>
                    )}
                  </div>
                )}

                <Link to={`/post?template=${template.id}`}>
                  <Button variant="outline" size="sm" className="w-full mt-4">
                    <Send className="w-4 h-4 mr-2" />
                    {t("actions.useTemplate", "Use Template")}
                  </Button>
                </Link>
              </Card>
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
