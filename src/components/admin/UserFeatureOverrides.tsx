import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, Plus, Search, Trash2, UserCog, Upload, Calendar, AlertCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { FLAG_KEYS } from "@/hooks/useFeatureFlags";
import { format, isPast, parseISO } from "date-fns";

interface UserOverride {
  id: string;
  user_id: string;
  feature_key: string;
  enabled: boolean;
  created_at: string;
  expires_at: string | null;
  user_email?: string;
  user_name?: string;
}

interface UserProfile {
  id: string;
  email: string;
  full_name: string | null;
}

const FEATURE_LABELS: Record<string, string> = {
  feature_video_compress: "Video Compression",
  feature_tiktok_transcode: "TikTok Transcode",
  feature_tiktok_precheck: "TikTok Pre-Check",
  feature_image_crop: "Image Cropping",
  feature_ai_caption: "AI Caption",
  feature_ai_hashtags: "AI Hashtags",
  feature_ai_thumbnails: "AI Thumbnails",
  feature_ai_image: "AI Image Generation",
  feature_stock_upload: "Stock Upload",
  feature_canvas: "Canvas",
  feature_title_required: "Title Required",
  feature_media_counter: "Media Counter",
};

export function UserFeatureOverrides() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedFeature, setSelectedFeature] = useState("");
  const [featureEnabled, setFeatureEnabled] = useState(true);
  const [expiresAt, setExpiresAt] = useState("");
  const [bulkInput, setBulkInput] = useState("");
  const [bulkFeature, setBulkFeature] = useState("");
  const [bulkEnabled, setBulkEnabled] = useState(true);
  const [bulkExpiresAt, setBulkExpiresAt] = useState("");

  // Fetch all user overrides
  const { data: overrides = [], isLoading: loadingOverrides } = useQuery({
    queryKey: ["admin-user-feature-overrides"],
    queryFn: async (): Promise<UserOverride[]> => {
      const { data: overridesData, error } = await supabase
        .from("user_feature_overrides")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) throw error;

      // Fetch user info for each override
      const userIds = [...new Set(overridesData?.map((o) => o.user_id) || [])];
      if (userIds.length === 0) return [];

      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, email, full_name")
        .in("id", userIds);

      const profileMap = new Map(profiles?.map((p) => [p.id, p]));

      return (overridesData || []).map((override) => ({
        ...override,
        user_email: profileMap.get(override.user_id)?.email,
        user_name: profileMap.get(override.user_id)?.full_name || undefined,
      }));
    },
  });

  // Fetch users for dropdown
  const { data: users = [], isLoading: loadingUsers } = useQuery({
    queryKey: ["admin-users-for-overrides", searchTerm],
    queryFn: async (): Promise<UserProfile[]> => {
      let query = supabase
        .from("profiles")
        .select("id, email, full_name")
        .order("email")
        .limit(20);

      if (searchTerm) {
        query = query.or(`email.ilike.%${searchTerm}%,full_name.ilike.%${searchTerm}%`);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
    enabled: dialogOpen,
  });

  // Add override mutation
  const addOverrideMutation = useMutation({
    mutationFn: async () => {
      if (!selectedUserId || !selectedFeature) {
        throw new Error("Please select a user and feature");
      }

      const { error } = await supabase.from("user_feature_overrides").upsert(
        {
          user_id: selectedUserId,
          feature_key: selectedFeature,
          enabled: featureEnabled,
          expires_at: expiresAt || null,
        },
        { onConflict: "user_id,feature_key" }
      );

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-user-feature-overrides"] });
      queryClient.invalidateQueries({ queryKey: ["feature-flags"] });
      toast({ title: "Override added" });
      setDialogOpen(false);
      resetForm();
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to add override",
        variant: "destructive",
      });
    },
  });

  // Bulk import mutation
  const bulkImportMutation = useMutation({
    mutationFn: async () => {
      if (!bulkFeature) {
        throw new Error("Please select a feature");
      }

      const emails = bulkInput
        .split(/[\n,;]+/)
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.length > 0);

      if (emails.length === 0) {
        throw new Error("Please enter at least one email");
      }

      // Find user IDs by email
      const { data: profiles, error: profilesError } = await supabase
        .from("profiles")
        .select("id, email")
        .in("email", emails);

      if (profilesError) throw profilesError;

      if (!profiles || profiles.length === 0) {
        throw new Error("No matching users found");
      }

      const foundEmails = profiles.map((p) => p.email.toLowerCase());
      const missingEmails = emails.filter((e) => !foundEmails.includes(e));

      // Insert overrides for found users
      const overridesToInsert = profiles.map((profile) => ({
        user_id: profile.id,
        feature_key: bulkFeature,
        enabled: bulkEnabled,
        expires_at: bulkExpiresAt || null,
      }));

      const { error: insertError } = await supabase
        .from("user_feature_overrides")
        .upsert(overridesToInsert, { onConflict: "user_id,feature_key" });

      if (insertError) throw insertError;

      return {
        added: profiles.length,
        missing: missingEmails,
      };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["admin-user-feature-overrides"] });
      queryClient.invalidateQueries({ queryKey: ["feature-flags"] });
      
      let message = `Added ${result.added} override(s)`;
      if (result.missing.length > 0) {
        message += `. ${result.missing.length} email(s) not found: ${result.missing.slice(0, 3).join(", ")}${result.missing.length > 3 ? "..." : ""}`;
      }
      
      toast({ title: "Bulk import complete", description: message });
      setDialogOpen(false);
      resetForm();
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to import overrides",
        variant: "destructive",
      });
    },
  });

  // Delete override mutation
  const deleteOverrideMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("user_feature_overrides").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-user-feature-overrides"] });
      queryClient.invalidateQueries({ queryKey: ["feature-flags"] });
      toast({ title: "Override removed" });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to remove override",
        variant: "destructive",
      });
    },
  });

  // Toggle override mutation
  const toggleOverrideMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const { error } = await supabase
        .from("user_feature_overrides")
        .update({ enabled })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-user-feature-overrides"] });
      queryClient.invalidateQueries({ queryKey: ["feature-flags"] });
      toast({ title: "Override updated" });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to update override",
        variant: "destructive",
      });
    },
  });

  const resetForm = () => {
    setSelectedUserId("");
    setSelectedFeature("");
    setFeatureEnabled(true);
    setExpiresAt("");
    setBulkInput("");
    setBulkFeature("");
    setBulkEnabled(true);
    setBulkExpiresAt("");
  };

  const isExpired = (expiresAt: string | null) => {
    if (!expiresAt) return false;
    return isPast(parseISO(expiresAt));
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <UserCog className="w-5 h-5" />
              User Feature Overrides
            </CardTitle>
            <CardDescription>
              Grant or revoke specific features for individual users
            </CardDescription>
          </div>
          <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="w-4 h-4 me-2" />
                Add Override
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>Add User Feature Override</DialogTitle>
                <DialogDescription>
                  Override the global feature flag for specific users
                </DialogDescription>
              </DialogHeader>
              <Tabs defaultValue="single" className="pt-2">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="single">Single User</TabsTrigger>
                  <TabsTrigger value="bulk">Bulk Import</TabsTrigger>
                </TabsList>

                <TabsContent value="single" className="space-y-4 pt-4">
                  {/* User Search */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Search User</label>
                    <div className="relative">
                      <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input
                        placeholder="Search by email or name..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="ps-9"
                      />
                    </div>
                  </div>

                  {/* User Selection */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Select User</label>
                    <Select value={selectedUserId} onValueChange={setSelectedUserId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Choose a user" />
                      </SelectTrigger>
                      <SelectContent>
                        {loadingUsers ? (
                          <div className="flex items-center justify-center p-4">
                            <Loader2 className="w-4 h-4 animate-spin" />
                          </div>
                        ) : (
                          users.map((user) => (
                            <SelectItem key={user.id} value={user.id}>
                              <div className="flex flex-col">
                                <span>{user.email}</span>
                                {user.full_name && (
                                  <span className="text-xs text-muted-foreground">
                                    {user.full_name}
                                  </span>
                                )}
                              </div>
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Feature Selection */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Select Feature</label>
                    <Select value={selectedFeature} onValueChange={setSelectedFeature}>
                      <SelectTrigger>
                        <SelectValue placeholder="Choose a feature" />
                      </SelectTrigger>
                      <SelectContent>
                        {FLAG_KEYS.map((key) => (
                          <SelectItem key={key} value={key}>
                            {FEATURE_LABELS[key] || key}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Expiration Date */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium flex items-center gap-2">
                      <Calendar className="w-4 h-4" />
                      Expiration Date (Optional)
                    </label>
                    <Input
                      type="datetime-local"
                      value={expiresAt}
                      onChange={(e) => setExpiresAt(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Leave empty for no expiration
                    </p>
                  </div>

                  {/* Enable/Disable */}
                  <div className="flex items-center justify-between p-3 rounded-lg border">
                    <span className="text-sm font-medium">Feature Enabled</span>
                    <Switch checked={featureEnabled} onCheckedChange={setFeatureEnabled} />
                  </div>

                  <Button
                    onClick={() => addOverrideMutation.mutate()}
                    disabled={addOverrideMutation.isPending || !selectedUserId || !selectedFeature}
                    className="w-full"
                  >
                    {addOverrideMutation.isPending ? (
                      <Loader2 className="w-4 h-4 me-2 animate-spin" />
                    ) : (
                      <Plus className="w-4 h-4 me-2" />
                    )}
                    Add Override
                  </Button>
                </TabsContent>

                <TabsContent value="bulk" className="space-y-4 pt-4">
                  {/* Bulk Email Input */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium flex items-center gap-2">
                      <Upload className="w-4 h-4" />
                      User Emails
                    </label>
                    <Textarea
                      placeholder="Enter emails (one per line, or comma/semicolon separated)&#10;example1@email.com&#10;example2@email.com"
                      value={bulkInput}
                      onChange={(e) => setBulkInput(e.target.value)}
                      rows={5}
                    />
                    <p className="text-xs text-muted-foreground">
                      Users must already exist in the system
                    </p>
                  </div>

                  {/* Feature Selection */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Select Feature</label>
                    <Select value={bulkFeature} onValueChange={setBulkFeature}>
                      <SelectTrigger>
                        <SelectValue placeholder="Choose a feature" />
                      </SelectTrigger>
                      <SelectContent>
                        {FLAG_KEYS.map((key) => (
                          <SelectItem key={key} value={key}>
                            {FEATURE_LABELS[key] || key}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Expiration Date */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium flex items-center gap-2">
                      <Calendar className="w-4 h-4" />
                      Expiration Date (Optional)
                    </label>
                    <Input
                      type="datetime-local"
                      value={bulkExpiresAt}
                      onChange={(e) => setBulkExpiresAt(e.target.value)}
                    />
                  </div>

                  {/* Enable/Disable */}
                  <div className="flex items-center justify-between p-3 rounded-lg border">
                    <span className="text-sm font-medium">Feature Enabled</span>
                    <Switch checked={bulkEnabled} onCheckedChange={setBulkEnabled} />
                  </div>

                  <Button
                    onClick={() => bulkImportMutation.mutate()}
                    disabled={bulkImportMutation.isPending || !bulkInput.trim() || !bulkFeature}
                    className="w-full"
                  >
                    {bulkImportMutation.isPending ? (
                      <Loader2 className="w-4 h-4 me-2 animate-spin" />
                    ) : (
                      <Upload className="w-4 h-4 me-2" />
                    )}
                    Import Overrides
                  </Button>
                </TabsContent>
              </Tabs>
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>
      <CardContent>
        {loadingOverrides ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : overrides.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <UserCog className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p>No user overrides configured</p>
            <p className="text-sm">Add an override to grant or revoke features for specific users</p>
          </div>
        ) : (
          <div className="space-y-3">
            {overrides.map((override) => {
              const expired = isExpired(override.expires_at);
              return (
                <div
                  key={override.id}
                  className={`flex items-center justify-between p-3 rounded-lg border bg-card ${expired ? "opacity-60" : ""}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium truncate">{override.user_email}</p>
                      <Badge variant={override.enabled && !expired ? "default" : "secondary"}>
                        {FEATURE_LABELS[override.feature_key] || override.feature_key}
                      </Badge>
                      {expired && (
                        <Badge variant="destructive" className="text-xs">
                          <AlertCircle className="w-3 h-3 me-1" />
                          Expired
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      {override.user_name && (
                        <p className="text-sm text-muted-foreground truncate">{override.user_name}</p>
                      )}
                      {override.expires_at && !expired && (
                        <p className="text-xs text-muted-foreground flex items-center gap-1">
                          <Calendar className="w-3 h-3" />
                          Expires: {format(parseISO(override.expires_at), "MMM d, yyyy h:mm a")}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 ms-4">
                    <Switch
                      checked={override.enabled}
                      onCheckedChange={(checked) =>
                        toggleOverrideMutation.mutate({ id: override.id, enabled: checked })
                      }
                      disabled={toggleOverrideMutation.isPending || expired}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => deleteOverrideMutation.mutate(override.id)}
                      disabled={deleteOverrideMutation.isPending}
                    >
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
