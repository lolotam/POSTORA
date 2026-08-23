import { useState, useEffect } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Settings, Users, Plus, Pencil, Trash2, Clock, Zap, Search, Crown, Star, Sparkles } from "lucide-react";
import { format } from "date-fns";

interface RateLimitSetting {
  id: string;
  endpoint: string;
  display_name: string;
  max_requests: number;
  window_minutes: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface TierRateLimit {
  id: string;
  plan_slug: string;
  endpoint: string;
  max_requests_per_hour: number;
  max_requests_per_day: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface UserRateLimit {
  id: string;
  user_id: string;
  endpoint: string;
  max_requests: number;
  window_minutes: number;
  reason: string | null;
  created_by: string | null;
  expires_at: string | null;
  created_at: string;
  user_email?: string;
}

interface UserProfile {
  id: string;
  email: string;
  full_name: string | null;
}

const PLAN_ICONS: Record<string, React.ReactNode> = {
  free: <Sparkles className="w-4 h-4" />,
  pro: <Star className="w-4 h-4" />,
  business: <Crown className="w-4 h-4" />,
};

const PLAN_COLORS: Record<string, string> = {
  free: "bg-muted text-muted-foreground",
  pro: "bg-primary/10 text-primary",
  business: "bg-amber-500/10 text-amber-600",
};

// One human-readable title per seeded endpoint (migration
// 20260823120000_unify_rate_limits.sql). Used wherever the raw endpoint key
// would otherwise be shown (tier tables, toasts, override dropdown labels).
export const ENDPOINT_LABELS: Record<string, string> = {
  "generate-caption": "AI Caption Generation",
  "generate-image": "AI Image Generation",
  "generate-hashtags": "AI Hashtag Generation",
  "post-create": "Web App Post Creation",
  "/api/v1/post": "n8n: Post Creation",
  "/api/v1/upload-media": "n8n: Media Upload",
  "/api/v1/webhooks": "n8n: Webhooks",
  "/api/v1/accounts": "n8n: List Accounts",
  "/api/v1/posts": "n8n: List Posts",
  "/api/v1/media": "n8n: Get Media by ID",
  "/api/v1/messages/reply": "n8n: Message Reply",
  "/api/v1/comments/reply": "n8n: Comment Reply",
  "/api/v1/comments/hide": "n8n: Comment Hide",
  "/api/v1/comments/delete": "n8n: Comment Delete",
};

// Category ordering for the Global Defaults table and the override endpoint
// dropdown. Anything not listed here lands in a trailing "Other" group so a
// future seeded endpoint still renders instead of disappearing.
export const ENDPOINT_CATEGORY_ORDER = [
  "AI Generation",
  "Postora Web App",
  "n8n / REST API",
] as const;

const ENDPOINT_CATEGORIES: Record<string, string> = {
  "generate-caption": "AI Generation",
  "generate-image": "AI Generation",
  "generate-hashtags": "AI Generation",
  "post-create": "Postora Web App",
  "/api/v1/post": "n8n / REST API",
  "/api/v1/upload-media": "n8n / REST API",
  "/api/v1/webhooks": "n8n / REST API",
  "/api/v1/accounts": "n8n / REST API",
  "/api/v1/posts": "n8n / REST API",
  "/api/v1/media": "n8n / REST API",
  "/api/v1/messages/reply": "n8n / REST API",
  "/api/v1/comments/reply": "n8n / REST API",
  "/api/v1/comments/hide": "n8n / REST API",
  "/api/v1/comments/delete": "n8n / REST API",
};

export interface EndpointCategoryGroup<T> {
  category: string;
  items: T[];
}

/** Buckets items by endpoint category, preserving the category order above
 *  (then a trailing "Other" group, only when non-empty). Items keep their
 *  original relative order inside a category. */
export function groupByEndpointCategory<T extends { endpoint: string }>(items: T[]): EndpointCategoryGroup<T>[] {
  const groups: EndpointCategoryGroup<T>[] = [...ENDPOINT_CATEGORY_ORDER, "Other"].map((category) => ({
    category,
    items: [] as T[],
  }));
  const groupByCategory = new Map(groups.map((group) => [group.category, group]));
  for (const item of items) {
    groupByCategory.get(ENDPOINT_CATEGORIES[item.endpoint] ?? "Other")?.items.push(item);
  }
  return groups.filter((group) => group.items.length > 0);
}

export default function AdminRateLimits() {
  const { toast } = useToast();
  const [globalSettings, setGlobalSettings] = useState<RateLimitSetting[]>([]);
  const [tierLimits, setTierLimits] = useState<TierRateLimit[]>([]);
  const [userOverrides, setUserOverrides] = useState<UserRateLimit[]>([]);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [editingGlobal, setEditingGlobal] = useState<RateLimitSetting | null>(null);
  const [editingTier, setEditingTier] = useState<TierRateLimit | null>(null);
  const [userOverrideDialog, setUserOverrideDialog] = useState(false);
  const [editingUserOverride, setEditingUserOverride] = useState<UserRateLimit | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Form state for user override
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedEndpoint, setSelectedEndpoint] = useState("");
  const [overrideMaxRequests, setOverrideMaxRequests] = useState(20);
  const [overrideWindowMinutes, setOverrideWindowMinutes] = useState(60);
  const [overrideReason, setOverrideReason] = useState("");
  const [overrideExpiresAt, setOverrideExpiresAt] = useState("");

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setIsLoading(true);
    try {
      // Fetch global settings
      const { data: settings, error: settingsError } = await supabase
        .from("rate_limit_settings")
        .select("*")
        .order("display_name");

      if (settingsError) throw settingsError;
      setGlobalSettings(settings || []);

      // Fetch tier-based limits
      const { data: tiers, error: tiersError } = await supabase
        .from("tier_rate_limits")
        .select("*")
        .order("plan_slug")
        .order("endpoint");

      if (tiersError) throw tiersError;
      setTierLimits(tiers || []);

      // Fetch user overrides with user info
      const { data: overrides, error: overridesError } = await supabase
        .from("user_rate_limits")
        .select("*")
        .order("created_at", { ascending: false });

      if (overridesError) throw overridesError;

      // Fetch user emails for the overrides
      if (overrides && overrides.length > 0) {
        const userIds = [...new Set(overrides.map((o) => o.user_id))];
        const { data: profiles } = await supabase
          .from("profiles")
          .select("id, email")
          .in("id", userIds);

        const profileMap = new Map(profiles?.map((p) => [p.id, p.email]));
        const enrichedOverrides = overrides.map((o) => ({
          ...o,
          user_email: profileMap.get(o.user_id) || "Unknown",
        }));
        setUserOverrides(enrichedOverrides);
      } else {
        setUserOverrides([]);
      }

      // Fetch all users for the dropdown
      const { data: allProfiles } = await supabase
        .from("profiles")
        .select("id, email, full_name")
        .order("email");

      setUsers(allProfiles || []);
    } catch (error) {
      console.error("Error fetching rate limit data:", error);
      toast({
        title: "Error",
        description: "Failed to load rate limit settings",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const updateGlobalSetting = async (setting: RateLimitSetting) => {
    setIsSaving(true);
    try {
      const { error } = await supabase
        .from("rate_limit_settings")
        .update({
          max_requests: setting.max_requests,
          window_minutes: setting.window_minutes,
          is_active: setting.is_active,
        })
        .eq("id", setting.id);

      if (error) throw error;

      toast({
        title: "Settings updated",
        description: `${setting.display_name} rate limit updated successfully.`,
      });

      setEditingGlobal(null);
      fetchData();
    } catch (error) {
      console.error("Error updating setting:", error);
      toast({
        title: "Error",
        description: "Failed to update rate limit setting",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const updateTierLimit = async (tier: TierRateLimit) => {
    setIsSaving(true);
    try {
      const { error } = await supabase
        .from("tier_rate_limits")
        .update({
          max_requests_per_hour: tier.max_requests_per_hour,
          max_requests_per_day: tier.max_requests_per_day,
          is_active: tier.is_active,
        })
        .eq("id", tier.id);

      if (error) throw error;

      toast({
        title: "Tier limit updated",
        description: `${tier.plan_slug.toUpperCase()} - ${ENDPOINT_LABELS[tier.endpoint] || tier.endpoint} limit updated successfully.`,
      });

      setEditingTier(null);
      fetchData();
    } catch (error) {
      console.error("Error updating tier limit:", error);
      toast({
        title: "Error",
        description: "Failed to update tier rate limit",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const saveUserOverride = async () => {
    if (!selectedUserId || !selectedEndpoint) {
      toast({
        title: "Missing fields",
        description: "Please select a user and endpoint",
        variant: "destructive",
      });
      return;
    }

    setIsSaving(true);
    try {
      const payload = {
        user_id: selectedUserId,
        endpoint: selectedEndpoint,
        max_requests: overrideMaxRequests,
        window_minutes: overrideWindowMinutes,
        reason: overrideReason || null,
        expires_at: overrideExpiresAt || null,
      };

      if (editingUserOverride) {
        const { error } = await supabase
          .from("user_rate_limits")
          .update(payload)
          .eq("id", editingUserOverride.id);

        if (error) throw error;
      } else {
        const { error } = await supabase.from("user_rate_limits").insert(payload);

        if (error) {
          if (error.code === "23505") {
            toast({
              title: "Override exists",
              description: "This user already has an override for this endpoint. Edit the existing one instead.",
              variant: "destructive",
            });
            return;
          }
          throw error;
        }
      }

      toast({
        title: editingUserOverride ? "Override updated" : "Override created",
        description: "User rate limit override saved successfully.",
      });

      resetUserOverrideForm();
      setUserOverrideDialog(false);
      fetchData();
    } catch (error) {
      console.error("Error saving user override:", error);
      toast({
        title: "Error",
        description: "Failed to save user override",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const deleteUserOverride = async (id: string) => {
    try {
      const { error } = await supabase.from("user_rate_limits").delete().eq("id", id);

      if (error) throw error;

      toast({
        title: "Override deleted",
        description: "User rate limit override removed.",
      });

      fetchData();
    } catch (error) {
      console.error("Error deleting override:", error);
      toast({
        title: "Error",
        description: "Failed to delete override",
        variant: "destructive",
      });
    }
  };

  const resetUserOverrideForm = () => {
    setSelectedUserId("");
    setSelectedEndpoint("");
    setOverrideMaxRequests(20);
    setOverrideWindowMinutes(60);
    setOverrideReason("");
    setOverrideExpiresAt("");
    setEditingUserOverride(null);
  };

  const openEditUserOverride = (override: UserRateLimit) => {
    setEditingUserOverride(override);
    setSelectedUserId(override.user_id);
    setSelectedEndpoint(override.endpoint);
    setOverrideMaxRequests(override.max_requests);
    setOverrideWindowMinutes(override.window_minutes);
    setOverrideReason(override.reason || "");
    setOverrideExpiresAt(override.expires_at ? override.expires_at.split("T")[0] : "");
    setUserOverrideDialog(true);
  };

  const filteredUsers = users.filter(
    (u) =>
      u.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (u.full_name && u.full_name.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  // Group tier limits by plan
  const tiersByPlan = tierLimits.reduce((acc, tier) => {
    if (!acc[tier.plan_slug]) {
      acc[tier.plan_slug] = [];
    }
    acc[tier.plan_slug].push(tier);
    return acc;
  }, {} as Record<string, TierRateLimit[]>);

  if (isLoading) {
    return (
      <AdminLayout>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold">Rate Limits</h1>
          <p className="text-muted-foreground">
            Configure tier-based, global, and per-user rate limits for API endpoints
          </p>
        </div>

        <Tabs defaultValue="tiers" className="space-y-6">
          <TabsList>
            <TabsTrigger value="tiers" className="gap-2">
              <Crown className="w-4 h-4" />
              Subscription Tiers
            </TabsTrigger>
            <TabsTrigger value="global" className="gap-2">
              <Settings className="w-4 h-4" />
              Global Defaults
            </TabsTrigger>
            <TabsTrigger value="users" className="gap-2">
              <Users className="w-4 h-4" />
              User Overrides
              {userOverrides.length > 0 && (
                <Badge variant="secondary" className="ml-1">
                  {userOverrides.length}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="tiers" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Subscription Tier Limits</CardTitle>
                <CardDescription>
                  Set different rate limits based on subscription plan (Free, Pro, Business). These automatically apply based on user's active subscription.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {["free", "pro", "business"].map((planSlug) => {
                  const planTiers = tiersByPlan[planSlug] || [];
                  return (
                    <div key={planSlug} className="space-y-3">
                      <div className="flex items-center gap-2">
                        <div className={`p-1.5 rounded ${PLAN_COLORS[planSlug]}`}>
                          {PLAN_ICONS[planSlug]}
                        </div>
                        <h3 className="font-semibold capitalize">{planSlug} Plan</h3>
                      </div>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Endpoint</TableHead>
                            <TableHead>Hourly Limit</TableHead>
                            <TableHead>Daily Limit</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="text-right">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {planTiers.map((tier) => (
                            <TableRow key={tier.id}>
                              <TableCell>
                                <p className="font-medium">{ENDPOINT_LABELS[tier.endpoint] || tier.endpoint}</p>
                                <p className="text-xs text-muted-foreground">{tier.endpoint}</p>
                              </TableCell>
                              <TableCell>
                                <div className="flex items-center gap-1">
                                  <Clock className="w-4 h-4 text-primary" />
                                  {tier.max_requests_per_hour}/hour
                                </div>
                              </TableCell>
                              <TableCell>
                                <div className="flex items-center gap-1">
                                  <Zap className="w-4 h-4 text-amber-500" />
                                  {tier.max_requests_per_day}/day
                                </div>
                              </TableCell>
                              <TableCell>
                                <Badge variant={tier.is_active ? "default" : "secondary"}>
                                  {tier.is_active ? "Active" : "Disabled"}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-right">
                                <Dialog
                                  open={editingTier?.id === tier.id}
                                  onOpenChange={(open) => {
                                    if (open) setEditingTier({ ...tier });
                                    else setEditingTier(null);
                                  }}
                                >
                                  <DialogTrigger asChild>
                                    <Button variant="ghost" size="sm">
                                      <Pencil className="w-4 h-4" />
                                    </Button>
                                  </DialogTrigger>
                                  <DialogContent>
                                    <DialogHeader>
                                      <DialogTitle>
                                        Edit {planSlug.toUpperCase()} - {ENDPOINT_LABELS[tier.endpoint]}
                                      </DialogTitle>
                                      <DialogDescription>
                                        Configure rate limits for this subscription tier
                                      </DialogDescription>
                                    </DialogHeader>
                                    {editingTier && (
                                      <div className="space-y-4 py-4">
                                        <div className="space-y-2">
                                          <Label>Hourly Limit</Label>
                                          <Input
                                            type="number"
                                            min={1}
                                            value={editingTier.max_requests_per_hour}
                                            onChange={(e) =>
                                              setEditingTier({
                                                ...editingTier,
                                                max_requests_per_hour: parseInt(e.target.value) || 1,
                                              })
                                            }
                                          />
                                          <p className="text-xs text-muted-foreground">
                                            Maximum requests allowed per hour
                                          </p>
                                        </div>
                                        <div className="space-y-2">
                                          <Label>Daily Limit</Label>
                                          <Input
                                            type="number"
                                            min={1}
                                            value={editingTier.max_requests_per_day}
                                            onChange={(e) =>
                                              setEditingTier({
                                                ...editingTier,
                                                max_requests_per_day: parseInt(e.target.value) || 1,
                                              })
                                            }
                                          />
                                          <p className="text-xs text-muted-foreground">
                                            Maximum requests allowed per day (24 hours)
                                          </p>
                                        </div>
                                        <div className="flex items-center justify-between">
                                          <div className="space-y-0.5">
                                            <Label>Active</Label>
                                            <p className="text-xs text-muted-foreground">
                                              Enable or disable tier-based limits
                                            </p>
                                          </div>
                                          <Switch
                                            checked={editingTier.is_active}
                                            onCheckedChange={(checked) =>
                                              setEditingTier({
                                                ...editingTier,
                                                is_active: checked,
                                              })
                                            }
                                          />
                                        </div>
                                      </div>
                                    )}
                                    <DialogFooter>
                                      <Button variant="outline" onClick={() => setEditingTier(null)}>
                                        Cancel
                                      </Button>
                                      <Button
                                        onClick={() => editingTier && updateTierLimit(editingTier)}
                                        disabled={isSaving}
                                      >
                                        {isSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                                        Save Changes
                                      </Button>
                                    </DialogFooter>
                                  </DialogContent>
                                </Dialog>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="global" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Global Rate Limits (Fallback)</CardTitle>
                <CardDescription>
                  These limits apply when tier-based limits are not configured or disabled
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {groupByEndpointCategory(globalSettings).map((group) => (
                  <div key={group.category} className="space-y-3">
                    <h3 className="font-semibold">{group.category}</h3>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Endpoint</TableHead>
                          <TableHead>Limit</TableHead>
                          <TableHead>Window</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {group.items.map((setting) => (
                          <TableRow key={setting.id}>
                            <TableCell>
                              <div>
                                <p className="font-medium">{setting.display_name}</p>
                                <p className="text-xs text-muted-foreground">{setting.endpoint}</p>
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1">
                                <Zap className="w-4 h-4 text-primary" />
                                {setting.max_requests} requests
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1">
                                <Clock className="w-4 h-4 text-muted-foreground" />
                                {setting.window_minutes} min
                              </div>
                            </TableCell>
                            <TableCell>
                              <Badge variant={setting.is_active ? "default" : "secondary"}>
                                {setting.is_active ? "Active" : "Disabled"}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right">
                              <Dialog
                                open={editingGlobal?.id === setting.id}
                                onOpenChange={(open) => {
                                  if (open) setEditingGlobal({ ...setting });
                                  else setEditingGlobal(null);
                                }}
                              >
                                <DialogTrigger asChild>
                                  <Button variant="ghost" size="sm">
                                    <Pencil className="w-4 h-4" />
                                  </Button>
                                </DialogTrigger>
                                <DialogContent>
                                  <DialogHeader>
                                    <DialogTitle>Edit {setting.display_name}</DialogTitle>
                                    <DialogDescription>
                                      Configure fallback rate limiting for this endpoint
                                    </DialogDescription>
                                  </DialogHeader>
                                  {editingGlobal && (
                                    <div className="space-y-4 py-4">
                                      <div className="space-y-2">
                                        <Label>Max Requests</Label>
                                        <Input
                                          type="number"
                                          min={1}
                                          value={editingGlobal.max_requests}
                                          onChange={(e) =>
                                            setEditingGlobal({
                                              ...editingGlobal,
                                              max_requests: parseInt(e.target.value) || 1,
                                            })
                                          }
                                        />
                                        <p className="text-xs text-muted-foreground">
                                          Maximum number of requests allowed per window
                                        </p>
                                      </div>
                                      <div className="space-y-2">
                                        <Label>Time Window (minutes)</Label>
                                        <Input
                                          type="number"
                                          min={1}
                                          value={editingGlobal.window_minutes}
                                          onChange={(e) =>
                                            setEditingGlobal({
                                              ...editingGlobal,
                                              window_minutes: parseInt(e.target.value) || 60,
                                            })
                                          }
                                        />
                                        <p className="text-xs text-muted-foreground">
                                          Time period in which requests are counted
                                        </p>
                                      </div>
                                      <div className="flex items-center justify-between">
                                        <div className="space-y-0.5">
                                          <Label>Active</Label>
                                          <p className="text-xs text-muted-foreground">
                                            Enable or disable rate limiting for this endpoint
                                          </p>
                                        </div>
                                        <Switch
                                          checked={editingGlobal.is_active}
                                          onCheckedChange={(checked) =>
                                            setEditingGlobal({
                                              ...editingGlobal,
                                              is_active: checked,
                                            })
                                          }
                                        />
                                      </div>
                                    </div>
                                  )}
                                  <DialogFooter>
                                    <Button variant="outline" onClick={() => setEditingGlobal(null)}>
                                      Cancel
                                    </Button>
                                    <Button
                                      onClick={() => editingGlobal && updateGlobalSetting(editingGlobal)}
                                      disabled={isSaving}
                                    >
                                      {isSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                                      Save Changes
                                    </Button>
                                  </DialogFooter>
                                </DialogContent>
                              </Dialog>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ))}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="users" className="space-y-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>User Rate Limit Overrides</CardTitle>
                  <CardDescription>
                    Set custom rate limits for specific users (overrides tier and global settings)
                  </CardDescription>
                </div>
                <Dialog
                  open={userOverrideDialog}
                  onOpenChange={(open) => {
                    setUserOverrideDialog(open);
                    if (!open) resetUserOverrideForm();
                  }}
                >
                  <DialogTrigger asChild>
                    <Button className="gap-2">
                      <Plus className="w-4 h-4" />
                      Add Override
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="max-w-md">
                    <DialogHeader>
                      <DialogTitle>
                        {editingUserOverride ? "Edit User Override" : "Add User Override"}
                      </DialogTitle>
                      <DialogDescription>
                        Set a custom rate limit for a specific user
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                      <div className="space-y-2">
                        <Label>User</Label>
                        <div className="space-y-2">
                          <div className="relative">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            <Input
                              placeholder="Search users..."
                              value={searchQuery}
                              onChange={(e) => setSearchQuery(e.target.value)}
                              className="pl-9"
                            />
                          </div>
                          <Select value={selectedUserId} onValueChange={setSelectedUserId}>
                            <SelectTrigger>
                              <SelectValue placeholder="Select a user" />
                            </SelectTrigger>
                            <SelectContent className="max-h-60">
                              {filteredUsers.map((user) => (
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
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label>Endpoint</Label>
                        <Select value={selectedEndpoint} onValueChange={setSelectedEndpoint}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select an endpoint" />
                          </SelectTrigger>
                          <SelectContent>
                            {groupByEndpointCategory(globalSettings).map((group) => (
                              <SelectGroup key={group.category}>
                                <SelectLabel>{group.category}</SelectLabel>
                                {group.items.map((setting) => (
                                  <SelectItem key={setting.endpoint} value={setting.endpoint}>
                                    {setting.display_name}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>Max Requests</Label>
                          <Input
                            type="number"
                            min={1}
                            value={overrideMaxRequests}
                            onChange={(e) => setOverrideMaxRequests(parseInt(e.target.value) || 1)}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Window (min)</Label>
                          <Input
                            type="number"
                            min={1}
                            value={overrideWindowMinutes}
                            onChange={(e) => setOverrideWindowMinutes(parseInt(e.target.value) || 60)}
                          />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label>Expires At (optional)</Label>
                        <Input
                          type="date"
                          value={overrideExpiresAt}
                          onChange={(e) => setOverrideExpiresAt(e.target.value)}
                        />
                        <p className="text-xs text-muted-foreground">
                          Leave empty for permanent override
                        </p>
                      </div>
                      <div className="space-y-2">
                        <Label>Reason (optional)</Label>
                        <Textarea
                          placeholder="Why is this override needed?"
                          value={overrideReason}
                          onChange={(e) => setOverrideReason(e.target.value)}
                        />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button
                        variant="outline"
                        onClick={() => {
                          setUserOverrideDialog(false);
                          resetUserOverrideForm();
                        }}
                      >
                        Cancel
                      </Button>
                      <Button onClick={saveUserOverride} disabled={isSaving}>
                        {isSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                        {editingUserOverride ? "Update Override" : "Create Override"}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </CardHeader>
              <CardContent>
                {userOverrides.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <Users className="w-12 h-12 mx-auto mb-4 opacity-50" />
                    <p>No user overrides configured</p>
                    <p className="text-sm">All users are using tier-based or global rate limits</p>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>User</TableHead>
                        <TableHead>Endpoint</TableHead>
                        <TableHead>Limit</TableHead>
                        <TableHead>Expires</TableHead>
                        <TableHead>Reason</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {userOverrides.map((override) => {
                        const setting = globalSettings.find((s) => s.endpoint === override.endpoint);
                        const isExpired =
                          override.expires_at && new Date(override.expires_at) < new Date();

                        return (
                          <TableRow key={override.id} className={isExpired ? "opacity-50" : ""}>
                            <TableCell>
                              <p className="font-medium">{override.user_email}</p>
                            </TableCell>
                            <TableCell>
                              <p>{setting?.display_name || override.endpoint}</p>
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline">
                                {override.max_requests} / {override.window_minutes}min
                              </Badge>
                            </TableCell>
                            <TableCell>
                              {override.expires_at ? (
                                <span className={isExpired ? "text-destructive" : ""}>
                                  {format(new Date(override.expires_at), "MMM d, yyyy")}
                                  {isExpired && " (expired)"}
                                </span>
                              ) : (
                                <span className="text-muted-foreground">Never</span>
                              )}
                            </TableCell>
                            <TableCell>
                              <p className="text-sm text-muted-foreground truncate max-w-[200px]">
                                {override.reason || "-"}
                              </p>
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex justify-end gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => openEditUserOverride(override)}
                                >
                                  <Pencil className="w-4 h-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => deleteUserOverride(override.id)}
                                  className="text-destructive hover:text-destructive"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </AdminLayout>
  );
}
