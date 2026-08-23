import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { PlatformIcon, getPlatformName } from "@/components/PlatformIcon";
import { Platform } from "@/lib/types";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Label } from "@/components/ui/label";
import { Loader2, Search, MoreHorizontal, Shield, User, Crown, Trash2, Filter, X, Settings2, FileText, Users, RefreshCw, Calendar, ImagePlus, Zap, Eye, Sparkles, ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { useAdminQuotas, UserQuota } from "@/hooks/useQuotas";

type AppRole = "user" | "admin" | "subscriber";
type PlanSlug = "free" | "pro" | "business";

interface SocialAccount {
  id: string;
  platform: string;
  platform_username: string | null;
  avatar_url: string | null;
  is_active: boolean;
}

interface UserSubscription {
  plan_id: string;
  status: string;
  subscription_plan?: {
    slug: string;
    name: string;
  };
}

interface UserWithRole {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  created_at: string;
  role?: AppRole;
  social_accounts?: SocialAccount[];
  quota?: UserQuota | null;
  profile_count?: number;
  post_count?: number;
  plan_slug?: PlanSlug;
  stripe_subscription_id?: string | null;
  ai_calls?: number;
}

const PLATFORMS = ["facebook", "instagram", "tiktok", "youtube", "pinterest", "twitter"] as const;

/**
 * Round-2 fix (final review C2): NULL in user_quotas.max_* means "inherit
 * from the plan" (see effective_user_quotas()), never zero and never a
 * hardcoded number. Renders it as the word "inherit" so it is never
 * confused with a real override value. Mirrors AdminPlanQuotas.tsx's
 * formatLimit(), which solved the identical problem for plan-level quotas.
 */
export function formatQuotaValue(value: number | null | undefined): string {
  if (value === null || value === undefined) return "inherit";
  return value === -1 ? "∞" : value.toString();
}

/**
 * An empty (or unparseable) field means "no override" — NULL, which falls
 * back to the plan through effective_user_quotas(). It must never be
 * coerced to a hardcoded number (the old `parseInt(e.target.value) || 1`
 * pattern), or an admin saving the form without touching a field would
 * silently overwrite that field to a fixed value instead of leaving it as
 * the number they actually saw. Mirrors AdminPlanQuotas.tsx's
 * parseQuotaInput().
 */
export function parseQuotaFieldInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

// Auth Status Debug Component
function AuthStatusDebug() {
  const [authStatus, setAuthStatus] = useState<{
    hasSession: boolean;
    hasAccessToken: boolean;
    userId?: string;
    expiresAt?: string;
  } | null>(null);
  const [isChecking, setIsChecking] = useState(false);

  const checkAuthStatus = async () => {
    setIsChecking(true);
    try {
      const { data: { session }, error } = await supabase.auth.getSession();
      if (error) throw error;
      
      setAuthStatus({
        hasSession: !!session,
        hasAccessToken: !!session?.access_token,
        userId: session?.user?.id,
        expiresAt: session?.expires_at 
          ? new Date(session.expires_at * 1000).toLocaleString() 
          : undefined,
      });
    } catch (error) {
      console.error("Auth check error:", error);
      setAuthStatus({ hasSession: false, hasAccessToken: false });
    } finally {
      setIsChecking(false);
    }
  };

  useEffect(() => {
    checkAuthStatus();
  }, []);

  return (
    <div className="p-3 rounded-lg border bg-muted/30 flex items-center gap-4 text-sm">
      <div className="flex items-center gap-2">
        <span className="font-medium">Auth Status:</span>
        {isChecking ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : authStatus?.hasSession ? (
          <Badge className="bg-green-500/10 text-green-600 border-green-500/30">
            <Shield className="w-3 h-3 mr-1" />
            Valid Session
          </Badge>
        ) : (
          <Badge variant="destructive">
            No Session
          </Badge>
        )}
      </div>
      {authStatus?.hasAccessToken && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <span>Token expires:</span>
          <span className="font-mono text-xs">{authStatus.expiresAt}</span>
        </div>
      )}
      {authStatus?.userId && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <span>User:</span>
          <span className="font-mono text-xs truncate max-w-[200px]">{authStatus.userId}</span>
        </div>
      )}
      <Button 
        variant="ghost" 
        size="sm" 
        onClick={checkAuthStatus}
        disabled={isChecking}
        className="ml-auto"
      >
        <RefreshCw className={`w-3 h-3 mr-1 ${isChecking ? 'animate-spin' : ''}`} />
        Refresh
      </Button>
    </div>
  );
}

// Individual User Sync Button Component
function SyncUserButton({ userId, email }: { userId: string; email: string }) {
  const [isSyncing, setIsSyncing] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const handleSync = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsSyncing(true);
    try {
      const response = await supabase.functions.invoke("sync-user-quotas", {
        body: { target_user_id: userId },
      });

      if (response.error) {
        throw new Error(response.error.message || "Sync failed");
      }

      toast({
        title: "Quotas synced",
        description: `Quotas synced for ${email}`,
      });

      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    } catch (error) {
      toast({
        title: "Sync failed",
        description: error instanceof Error ? error.message : "Failed to sync quotas",
        variant: "destructive",
      });
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleSync}
            disabled={isSyncing}
            className="h-7 w-7"
          >
            {isSyncing ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Zap className="w-3 h-3" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Sync quotas from Stripe
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// Sync Quotas Button Component
function SyncQuotasButton() {
  const [isOpen, setIsOpen] = useState(false);
  const [targetEmail, setTargetEmail] = useState("");
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncAll, setSyncAll] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        throw new Error("Not authenticated");
      }

      // If syncing a specific user, find their ID
      let targetUserId: string | undefined;
      if (!syncAll && targetEmail) {
        const { data: profile } = await supabase
          .from("profiles")
          .select("id")
          .eq("email", targetEmail)
          .single();
        
        if (!profile) {
          throw new Error("User not found with that email");
        }
        targetUserId = profile.id;
      }

      const response = await supabase.functions.invoke("sync-user-quotas", {
        body: syncAll ? { sync_all: true } : { target_user_id: targetUserId },
      });

      if (response.error) {
        throw new Error(response.error.message || "Sync failed");
      }

      toast({
        title: "Quotas synced",
        description: response.data?.message || "User quotas have been synced from Stripe.",
      });

      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      setIsOpen(false);
      setTargetEmail("");
      setSyncAll(false);
    } catch (error) {
      toast({
        title: "Sync failed",
        description: error instanceof Error ? error.message : "Failed to sync quotas",
        variant: "destructive",
      });
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Zap className="w-4 h-4" />
          Sync Quotas
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sync User Quotas from Stripe</DialogTitle>
          <DialogDescription>
            Sync user quotas based on their Stripe subscription. This is useful when webhooks are delayed or missed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="flex items-center space-x-2">
            <Checkbox
              id="sync-all"
              checked={syncAll}
              onCheckedChange={(checked) => setSyncAll(checked === true)}
            />
            <Label htmlFor="sync-all">Sync all users</Label>
          </div>
          {!syncAll && (
            <div className="space-y-2">
              <Label htmlFor="target-email">User Email</Label>
              <Input
                id="target-email"
                placeholder="user@example.com"
                value={targetEmail}
                onChange={(e) => setTargetEmail(e.target.value)}
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setIsOpen(false)}>
            Cancel
          </Button>
          <Button 
            onClick={handleSync} 
            disabled={isSyncing || (!syncAll && !targetEmail)}
            className="gap-2"
          >
            {isSyncing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Syncing...
              </>
            ) : (
              <>
                <Zap className="w-4 h-4" />
                Sync Quotas
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminUsers() {
  const [searchQuery, setSearchQuery] = useState("");
  const [platformFilter, setPlatformFilter] = useState<string>("all");
  const [planFilter, setPlanFilter] = useState<string>("all");
  type SortKey = "email" | "accounts" | "plan" | "role" | "usage" | "ai" | "joined";
  type SortDir = "asc" | "desc";
  const [sortKey, setSortKey] = useState<SortKey>("joined");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [deleteUser, setDeleteUser] = useState<UserWithRole | null>(null);
  const [editQuotaUser, setEditQuotaUser] = useState<UserWithRole | null>(null);
  
  // null = inherit from the plan (see formatQuotaValue/parseQuotaFieldInput
  // above). These used to default to hardcoded numbers, which meant saving
  // the dialog without touching a field silently pinned that field's value.
  const [quotaMaxProfiles, setQuotaMaxProfiles] = useState<number | null>(null);
  const [quotaMaxSocialAccounts, setQuotaMaxSocialAccounts] = useState<number | null>(null);
  const [quotaMaxPosts, setQuotaMaxPosts] = useState<number | null>(null);
  const [quotaMaxPostsPerDay, setQuotaMaxPostsPerDay] = useState<number | null>(null);
  const [quotaMaxMediaUploads, setQuotaMaxMediaUploads] = useState<number | null>(null);
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const [showBulkEditDialog, setShowBulkEditDialog] = useState(false);
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);
  
  // Plan selection dialog state for subscriber role change
  const [subscriberPlanUser, setSubscriberPlanUser] = useState<UserWithRole | null>(null);
  const [selectedSubscriberPlan, setSelectedSubscriberPlan] = useState<string>("pro");

  // Downgrade confirmation for users whose plan is paid through Stripe
  const [downgradeUser, setDowngradeUser] = useState<UserWithRole | null>(null);
  const [cancelStripeOnDowngrade, setCancelStripeOnDowngrade] = useState(true);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { updateQuota, isUpdating, bulkUpdateQuota, isBulkUpdating, bulkDeleteUsers, isBulkDeleting } = useAdminQuotas();

  // Fetch all users with their roles, social accounts, quotas, and subscriptions
  const { data: users = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ["admin-users"],
    queryFn: async (): Promise<UserWithRole[]> => {
      const { data: profiles, error: profilesError } = await supabase
        .from("profiles")
        .select("*")
        .order("created_at", { ascending: false });

      if (profilesError) throw profilesError;

      const { data: roles, error: rolesError } = await supabase
        .from("user_roles")
        .select("*");

      if (rolesError) throw rolesError;

      const { data: socialAccounts, error: socialError } = await supabase
        .from("social_accounts")
        .select("id, user_id, platform, platform_username, avatar_url, is_active")
        .eq("is_active", true);

      if (socialError) throw socialError;

      const { data: quotas, error: quotasError } = await supabase
        .from("user_quotas")
        .select("*");

      if (quotasError) throw quotasError;

      // Fetch user subscriptions with plan info
      const { data: subscriptions, error: subscriptionsError } = await supabase
        .from("user_subscriptions")
        .select(`
          user_id,
          status,
          plan_id,
          stripe_subscription_id,
          subscription_plans:plan_id (
            slug,
            name
          )
        `)
        // 'past_due' counts as subscribed alongside 'active' (C1, 2026-08-23
        // final review) - a dunning Pro/Business user must not show as
        // "free" here, matching effective_user_quotas(). 'trialing' never
        // actually reaches this column (subscriptionStatus.ts maps it to
        // 'active' before it's written; the status check constraint permits
        // only active|cancelled|expired|past_due), so it is dropped as dead.
        .in("status", ["active", "past_due"]);

      if (subscriptionsError) throw subscriptionsError;

      // Get post counts per user
      const { data: postCounts, error: postCountError } = await supabase
        .from("posts")
        .select("user_id");

      if (postCountError) throw postCountError;

      // Get AI call counts per user from api_logs
      const { data: aiCallLogs, error: aiCallError } = await supabase
        .from("api_logs")
        .select("user_id")
        .in("endpoint", ["generate-caption", "generate-hashtags", "generate-image"]);

      if (aiCallError) throw aiCallError;

      // Count posts per user
      const postCountMap: Record<string, number> = {};
      postCounts?.forEach((p) => {
        postCountMap[p.user_id] = (postCountMap[p.user_id] || 0) + 1;
      });

      // Count AI calls per user
      const aiCallCountMap: Record<string, number> = {};
      aiCallLogs?.forEach((l: any) => {
        if (l.user_id) {
          aiCallCountMap[l.user_id] = (aiCallCountMap[l.user_id] || 0) + 1;
        }
      });

      // Count social accounts per user
      const socialAccountCountMap: Record<string, number> = {};
      socialAccounts?.forEach((a) => {
        socialAccountCountMap[a.user_id] = (socialAccountCountMap[a.user_id] || 0) + 1;
      });

      // Map subscription plan slugs per user
      const userPlanMap: Record<string, PlanSlug> = {};
      const userStripeSubMap: Record<string, string> = {};
      subscriptions?.forEach((sub: any) => {
        const planSlug = sub.subscription_plans?.slug as PlanSlug;
        if (planSlug) {
          userPlanMap[sub.user_id] = planSlug;
        }
        if (sub.stripe_subscription_id) {
          userStripeSubMap[sub.user_id] = sub.stripe_subscription_id;
        }
      });

      return (profiles || []).map((profile) => {
        const userRole = roles?.find((r) => r.user_id === profile.id);
        const userSocialAccounts = socialAccounts?.filter((acc) => acc.user_id === profile.id) || [];
        const userQuota = quotas?.find((q) => q.user_id === profile.id) || null;
        
        // Determine plan: admin has special status, otherwise check subscription, then fallback to quotas
        let planSlug: PlanSlug = "free";
        if (userRole?.role === "admin") {
          planSlug = "business"; // Treat admins as business-tier for display
        } else if (userPlanMap[profile.id]) {
          planSlug = userPlanMap[profile.id];
        } else if (userRole?.role === "subscriber" && userQuota) {
          // Subscriber without subscription record — derive plan from quotas.
          //
          // Reviewed and documented (C2, 2026-08-23 final review), left
          // as-is: post-backfill, max_profiles is NULL on nearly every row,
          // which fails both comparisons below and falls through to the
          // "free" initialized above. That is the best available answer —
          // there is no subscription row here to read a real plan from, and
          // NULL no longer carries a "this was set to X" signal the way a
          // pre-backfill numeric override did. This heuristic now only
          // fires for the rare row still holding a genuine numeric
          // override that exceeds its plan.
          if ((userQuota as any).max_profiles === -1) planSlug = "business";
          else if ((userQuota as any).max_profiles >= 5) planSlug = "pro";
        }
        
        return {
          ...profile,
          role: (userRole?.role as AppRole) || "user",
          social_accounts: userSocialAccounts,
          quota: userQuota as UserQuota | null,
          
          post_count: postCountMap[profile.id] || 0,
          plan_slug: planSlug,
          stripe_subscription_id: userStripeSubMap[profile.id] || null,
          ai_calls: aiCallCountMap[profile.id] || 0,
        };
      });
    },
    refetchInterval: 60000, // Auto-refresh every 60 seconds
  });

  // Auto-refresh effect
  useEffect(() => {
    const interval = setInterval(() => {
      refetch();
    }, 60000);
    return () => clearInterval(interval);
  }, [refetch]);

  // Paid plans an admin can assign to a subscriber
  const { data: assignablePlans = [] } = useQuery({
    queryKey: ["admin-assignable-plans"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("subscription_plans")
        .select("id, name, slug, price_monthly, profile_limit")
        .eq("is_active", true)
        .neq("slug", "free")
        .order("sort_order");

      if (error) throw error;
      return data || [];
    },
  });

  const defaultPlanSlug = assignablePlans[0]?.slug || "pro";

  // Role-to-plan mapping for quota updates via DB function
  const roleToPlan: Record<AppRole, string> = {
    user: "free",
    subscriber: "pro",
    admin: "business",
  };

  const fetchPlanIdBySlug = async (planSlug: string) => {
    const { data: plan, error } = await supabase
      .from("subscription_plans")
      .select("id")
      .eq("slug", planSlug)
      .maybeSingle();
    if (error) throw error;
    if (!plan) throw new Error(`Plan "${planSlug}" was not found`);
    return plan.id;
  };

  const cancelSubscriptionsByIds = async (subscriptionIds: string[]) => {
    const { error } = await supabase
      .from("user_subscriptions")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .in("id", subscriptionIds);
    if (error) throw error;
  };

  // Point the user's single active subscription at the selected plan
  const applySubscriptionPlan = async (userId: string, planSlug: string) => {
    const planId = await fetchPlanIdBySlug(planSlug);

    const { data: activeSubs, error: activeError } = await supabase
      .from("user_subscriptions")
      .select("id")
      .eq("user_id", userId)
      .eq("status", "active")
      .order("created_at", { ascending: false });
    if (activeError) throw activeError;

    const [currentSub, ...duplicateSubs] = activeSubs || [];

    if (currentSub) {
      const { error } = await supabase
        .from("user_subscriptions")
        .update({
          plan_id: planId,
          cancel_at_period_end: false,
          updated_at: new Date().toISOString(),
        })
        .eq("id", currentSub.id);
      if (error) throw error;
    } else {
      const periodStart = new Date();
      const periodEnd = new Date(periodStart);
      periodEnd.setFullYear(periodEnd.getFullYear() + 1);

      const { error } = await supabase.from("user_subscriptions").insert({
        user_id: userId,
        plan_id: planId,
        status: "active",
        current_period_start: periodStart.toISOString(),
        current_period_end: periodEnd.toISOString(),
        cancel_at_period_end: false,
      });
      if (error) throw error;
    }

    // Subscription readers use maybeSingle() on the active row, so never leave more than one
    if (duplicateSubs.length > 0) {
      await cancelSubscriptionsByIds(duplicateSubs.map((sub) => sub.id));
    }
  };

  // Cancelling only the local row would leave Stripe billing the customer
  const cancelStripeSubscription = async (stripeSubscriptionId: string) => {
    const { data, error } = await supabase.functions.invoke("stripe-manage-subscription", {
      body: { action: "cancel_now", subscription_id: stripeSubscriptionId },
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
  };

  const cancelActiveSubscriptions = async (userId: string) => {
    const { error } = await supabase
      .from("user_subscriptions")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("status", "active");
    if (error) throw error;
  };

  // Change user role mutation
  const changeRoleMutation = useMutation({
    mutationFn: async ({
      userId,
      newRole,
      planSlug,
      stripeSubscriptionIdToCancel,
    }: {
      userId: string;
      newRole: AppRole;
      planSlug?: string;
      stripeSubscriptionIdToCancel?: string;
    }) => {
      await supabase.from("user_roles").delete().eq("user_id", userId);
      const { error } = await supabase.from("user_roles").insert({
        user_id: userId,
        role: newRole,
      });
      if (error) throw error;

      // Use provided planSlug or fall back to role mapping
      const plan = planSlug || roleToPlan[newRole];

      // Keep the subscription record in step with the role, otherwise the plan badge,
      // the user detail page and useSubscription() all keep reading the stale plan
      if (newRole === "subscriber") {
        await applySubscriptionPlan(userId, plan);
      } else if (newRole === "user") {
        // Stripe first: if it refuses, the user keeps their plan rather than losing
        // access while still being billed
        if (stripeSubscriptionIdToCancel) {
          await cancelStripeSubscription(stripeSubscriptionIdToCancel);
        }
        await cancelActiveSubscriptions(userId);
      }

      // Auto-update quotas via SECURITY DEFINER DB function (bypasses RLS).
      // Also covers re-assigning the same plan, where the plan_id trigger does not fire.
      const { error: quotaError } = await supabase.rpc("set_user_quotas_for_plan", {
        p_user_id: userId,
        p_plan_slug: plan,
      });
      if (quotaError) throw quotaError;
    },
    onSuccess: async () => {
      await queryClient.refetchQueries({ queryKey: ["admin-users"] });
      queryClient.invalidateQueries({ queryKey: ["admin-subscriptions"] });
      queryClient.invalidateQueries({ queryKey: ["admin-user-subscription"] });
      setSubscriberPlanUser(null);
      setDowngradeUser(null);
      toast({
        title: "Role updated",
        description: "User role and quotas have been updated successfully.",
      });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to update role",
        variant: "destructive",
      });
    },
  });

  // C2 fix: prefill with the raw override (null stays null = inherit),
  // never `|| <hardcoded default>` — that coerced NULL into a number the
  // admin never typed, so an untouched Save silently pinned it.
  const handleEditQuota = (user: UserWithRole) => {
    setEditQuotaUser(user);

    setQuotaMaxProfiles(user.quota?.max_profiles ?? null);
    setQuotaMaxSocialAccounts(user.quota?.max_social_accounts ?? null);
    setQuotaMaxPosts(user.quota?.max_posts_per_month ?? null);
    setQuotaMaxPostsPerDay(user.quota?.max_posts_per_day ?? null);
    setQuotaMaxMediaUploads(user.quota?.max_media_uploads_per_day ?? null);
  };

  // C2 fix: write exactly what the dialog shows the admin. maxProfiles used
  // to be `editQuotaUser.quota?.max_profiles || 1`, which rewrote it to 1
  // on every save regardless of the field's real value (there was no UI
  // control for it at all) — a Pro user's profile limit got permanently
  // capped near free tier the moment an admin opened and saved this dialog.
  const handleSaveQuota = () => {
    if (!editQuotaUser) return;
    updateQuota({
      userId: editQuotaUser.id,
      maxProfiles: quotaMaxProfiles,
      maxSocialAccounts: quotaMaxSocialAccounts,
      maxPostsPerMonth: quotaMaxPosts,
      maxPostsPerDay: quotaMaxPostsPerDay,
      maxMediaUploadsPerDay: quotaMaxMediaUploads,
    });
    setEditQuotaUser(null);
  };

  // Bulk edit opens with every field at "inherit" (null), not a hardcoded
  // number pinning every selected user to the same value unless the admin
  // explicitly types one.
  const handleBulkEditQuota = () => {
    setQuotaMaxProfiles(null);
    setQuotaMaxSocialAccounts(null);
    setQuotaMaxPosts(null);
    setQuotaMaxPostsPerDay(null);
    setQuotaMaxMediaUploads(null);
    setShowBulkEditDialog(true);
  };

  const handleSaveBulkQuota = () => {
    bulkUpdateQuota({
      userIds: selectedUsers,
      maxProfiles: quotaMaxProfiles,
      maxSocialAccounts: quotaMaxSocialAccounts,
      maxPostsPerMonth: quotaMaxPosts,
      maxPostsPerDay: quotaMaxPostsPerDay,
      maxMediaUploadsPerDay: quotaMaxMediaUploads,
    });
    setShowBulkEditDialog(false);
    setSelectedUsers([]);
  };

  const handleBulkDelete = () => {
    bulkDeleteUsers(selectedUsers);
    setShowBulkDeleteDialog(false);
    setSelectedUsers([]);
  };

  const toggleUserSelection = (userId: string) => {
    setSelectedUsers(prev => 
      prev.includes(userId) 
        ? prev.filter(id => id !== userId)
        : [...prev, userId]
    );
  };

  const toggleAllUsers = () => {
    if (selectedUsers.length === sortedUsers.length) {
      setSelectedUsers([]);
    } else {
      setSelectedUsers(sortedUsers.map(u => u.id));
    }
  };

  const filteredUsers = users.filter((user) => {
    const matchesSearch =
      user.email?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      user.full_name?.toLowerCase().includes(searchQuery.toLowerCase());
    
    const matchesPlatform =
      platformFilter === "all" ||
      user.social_accounts?.some((acc) => acc.platform === platformFilter);
    
    const matchesPlan =
      planFilter === "all" ||
      (planFilter === "admin" && user.role === "admin") ||
      (planFilter !== "admin" && user.plan_slug === planFilter);
    
    return matchesSearch && matchesPlatform && matchesPlan;
  });

  const planRank: Record<string, number> = { free: 0, pro: 1, business: 2, admin: 3 };
  const roleRank: Record<string, number> = { user: 0, subscriber: 1, admin: 2 };

  const sortedUsers = useMemo(() => {
    const arr = [...filteredUsers];
    const dir = sortDir === "asc" ? 1 : -1;
    const cmp = (a: any, b: any): number => {
      switch (sortKey) {
        case "email": {
          const av = (a.email || a.full_name || "").toLowerCase();
          const bv = (b.email || b.full_name || "").toLowerCase();
          return av.localeCompare(bv) * dir;
        }
        case "accounts":
          return ((a.social_accounts?.length || 0) - (b.social_accounts?.length || 0)) * dir;
        case "plan":
          return ((planRank[a.plan_slug] ?? 0) - (planRank[b.plan_slug] ?? 0)) * dir;
        case "role":
          return ((roleRank[a.role] ?? 0) - (roleRank[b.role] ?? 0)) * dir;
        case "usage":
          return ((a.post_count || 0) - (b.post_count || 0)) * dir;
        case "ai":
          return ((a.ai_calls || 0) - (b.ai_calls || 0)) * dir;
        case "joined":
        default: {
          const av = a.created_at ? new Date(a.created_at).getTime() : 0;
          const bv = b.created_at ? new Date(b.created_at).getTime() : 0;
          return (av - bv) * dir;
        }
      }
    };
    return arr.sort(cmp);
  }, [filteredUsers, sortKey, sortDir]);

  const handleSort = (key: SortKey) => {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir("asc");
    } else if (sortDir === "asc") {
      setSortDir("desc");
    } else {
      setSortKey("joined");
      setSortDir("desc");
    }
  };

  const SortableHead = ({ label, sortKeyVal, className }: { label: string; sortKeyVal: SortKey; className?: string }) => {
    const active = sortKey === sortKeyVal;
    const Icon = active ? (sortDir === "asc" ? ChevronUp : ChevronDown) : ChevronsUpDown;
    return (
      <TableHead className={className}>
        <button
          type="button"
          onClick={() => handleSort(sortKeyVal)}
          className={`inline-flex items-center gap-1 select-none hover:text-foreground transition-colors ${active ? "text-foreground" : "text-muted-foreground"}`}
        >
          {label}
          <Icon className="w-3.5 h-3.5" />
        </button>
      </TableHead>
    );
  };

  const getRoleBadge = (role: AppRole) => {
    switch (role) {
      case "admin":
        return (
          <Badge className="bg-primary/10 text-primary border-primary/30">
            <Shield className="w-3 h-3 mr-1" />
            Admin
          </Badge>
        );
      case "subscriber":
        return (
          <Badge className="bg-amber-500/10 text-amber-600 border-amber-500/30">
            <Crown className="w-3 h-3 mr-1" />
            Subscriber
          </Badge>
        );
      default:
        return (
          <Badge variant="secondary">
            <User className="w-3 h-3 mr-1" />
            User
          </Badge>
        );
    }
  };

  const getPlanBadge = (planSlug: PlanSlug, role?: AppRole) => {
    if (role === "admin") {
      return (
        <Badge className="bg-gradient-to-r from-primary/20 to-purple-500/20 text-foreground border-primary/30">
          <Shield className="w-3 h-3 mr-1" />
          Admin
        </Badge>
      );
    }
    switch (planSlug) {
      case "business":
        return (
          <Badge className="bg-gradient-to-r from-purple-500/20 to-pink-500/20 text-purple-600 border-purple-500/30">
            <Crown className="w-3 h-3 mr-1" />
            Business
          </Badge>
        );
      case "pro":
        return (
          <Badge className="bg-gradient-to-r from-blue-500/20 to-cyan-500/20 text-blue-600 border-blue-500/30">
            <Zap className="w-3 h-3 mr-1" />
            Pro
          </Badge>
        );
      default:
        return (
          <Badge variant="outline" className="text-muted-foreground">
            Free
          </Badge>
        );
    }
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        {/* Auth Status Debug Row */}
        <AuthStatusDebug />

        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold">Users Management</h2>
            <p className="text-muted-foreground">
              Manage all registered users ({users.length} total)
            </p>
          </div>
          <div className="flex items-center gap-3">
            <SyncQuotasButton />
            <Button 
              variant="outline" 
              size="sm" 
              onClick={() => refetch()}
              disabled={isFetching}
              className="gap-2"
            >
              <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
              {isFetching ? 'Refreshing...' : 'Refresh'}
            </Button>
            <Select value={planFilter} onValueChange={setPlanFilter}>
              <SelectTrigger className="w-36">
                <Zap className="w-4 h-4 mr-2" />
                <SelectValue placeholder="Filter by plan" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Plans</SelectItem>
                <SelectItem value="free">Free</SelectItem>
                <SelectItem value="pro">Pro</SelectItem>
                <SelectItem value="business">Business</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
            {planFilter !== "all" && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setPlanFilter("all")}
                className="h-9 w-9"
              >
                <X className="w-4 h-4" />
              </Button>
            )}
            <Select value={platformFilter} onValueChange={setPlatformFilter}>
              <SelectTrigger className="w-44">
                <Filter className="w-4 h-4 mr-2" />
                <SelectValue placeholder="Filter by platform" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Platforms</SelectItem>
                {PLATFORMS.map((platform) => (
                  <SelectItem key={platform} value={platform}>
                    <div className="flex items-center gap-2">
                      <PlatformIcon platform={platform as Platform} size="xs" />
                      {getPlatformName(platform as Platform)}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {platformFilter !== "all" && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setPlatformFilter("all")}
                className="h-9 w-9"
              >
                <X className="w-4 h-4" />
              </Button>
            )}
            <div className="relative w-72">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search users..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>
          </div>
        </div>

        {/* Bulk Actions Bar */}
        {selectedUsers.length > 0 && (
          <div className="flex items-center gap-4 p-4 bg-muted/50 rounded-lg border">
            <span className="text-sm font-medium">
              {selectedUsers.length} user{selectedUsers.length > 1 ? 's' : ''} selected
            </span>
            <div className="flex-1" />
            <Button
              variant="outline"
              size="sm"
              onClick={handleBulkEditQuota}
              className="gap-2"
            >
              <Settings2 className="w-4 h-4" />
              Edit Quotas
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setShowBulkDeleteDialog(true)}
              className="gap-2"
            >
              <Trash2 className="w-4 h-4" />
              Delete Users
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedUsers([])}
            >
              Clear Selection
            </Button>
          </div>
        )}

        {/* Users Table */}
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="rounded-xl border bg-card overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[50px]">
                    <Checkbox
                      checked={selectedUsers.length === sortedUsers.length && sortedUsers.length > 0}
                      onCheckedChange={toggleAllUsers}
                    />
                  </TableHead>
                  <TableHead className="w-[50px]">#</TableHead>
                  <SortableHead label="User" sortKeyVal="email" />
                  <SortableHead label="Connected Accounts" sortKeyVal="accounts" />
                  <SortableHead label="Plan" sortKeyVal="plan" />
                  <SortableHead label="Role" sortKeyVal="role" />
                  <SortableHead label="Usage" sortKeyVal="usage" />
                  <SortableHead label="AI Usage" sortKeyVal="ai" />
                  <SortableHead label="Joined" sortKeyVal="joined" />
                  <TableHead className="w-[100px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedUsers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center py-8 text-muted-foreground">
                      No users found
                    </TableCell>
                  </TableRow>
                ) : (
                  sortedUsers.map((user, index) => (
                    <TableRow key={user.id} className={selectedUsers.includes(user.id) ? "bg-muted/30" : ""}>
                      <TableCell>
                        <Checkbox
                          checked={selectedUsers.includes(user.id)}
                          onCheckedChange={() => toggleUserSelection(user.id)}
                        />
                      </TableCell>
                      <TableCell className="font-medium text-muted-foreground">
                        {index + 1}
                      </TableCell>
                      <TableCell>
                        <Link to={`/admin/users/${user.id}`} className="flex items-center gap-3 hover:opacity-80 transition-opacity">
                          <Avatar>
                            <AvatarImage src={user.avatar_url || undefined} />
                            <AvatarFallback>
                              {user.full_name?.charAt(0) || user.email?.charAt(0) || "U"}
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <p className="font-medium">{user.full_name || "No name"}</p>
                            <p className="text-sm text-muted-foreground">{user.email}</p>
                          </div>
                        </Link>
                      </TableCell>
                      <TableCell>
                        <TooltipProvider>
                          <div className="flex items-center gap-2">
                            <Badge 
                              variant={user.social_accounts && user.social_accounts.length > 0 ? "default" : "secondary"}
                              className={user.social_accounts && user.social_accounts.length >= 5 
                                ? "bg-green-500/10 text-green-600 border-green-500/30" 
                                : user.social_accounts && user.social_accounts.length >= 3 
                                  ? "bg-blue-500/10 text-blue-600 border-blue-500/30"
                                  : ""
                              }
                            >
                              {user.social_accounts?.length || 0}
                            </Badge>
                            <div className="flex items-center gap-1 flex-wrap">
                              {user.social_accounts && user.social_accounts.length > 0 ? (
                                user.social_accounts.slice(0, 5).map((account) => (
                                  <Tooltip key={account.id}>
                                    <TooltipTrigger asChild>
                                      <div className="relative">
                                        <Avatar className="w-7 h-7 border-2 border-background">
                                          {account.avatar_url ? (
                                            <AvatarImage 
                                              src={account.avatar_url} 
                                              alt={account.platform_username || account.platform} 
                                            />
                                          ) : null}
                                          <AvatarFallback className="text-[10px]">
                                            <PlatformIcon platform={account.platform as Platform} size="xs" />
                                          </AvatarFallback>
                                        </Avatar>
                                        <div className="absolute -bottom-0.5 -right-0.5">
                                          <PlatformIcon platform={account.platform as Platform} size="xs" />
                                        </div>
                                      </div>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      <div className="text-xs">
                                        <p className="font-medium">{account.platform_username || 'Unknown'}</p>
                                        <p className="text-muted-foreground">{getPlatformName(account.platform as Platform)}</p>
                                      </div>
                                    </TooltipContent>
                                  </Tooltip>
                                ))
                              ) : (
                                <span className="text-xs text-muted-foreground">No accounts</span>
                              )}
                              {user.social_accounts && user.social_accounts.length > 5 && (
                                <Badge variant="outline" className="text-xs">
                                  +{user.social_accounts.length - 5}
                                </Badge>
                              )}
                            </div>
                          </div>
                        </TooltipProvider>
                      </TableCell>
                      <TableCell>{getPlanBadge(user.plan_slug || "free", user.role)}</TableCell>
                      <TableCell>{getRoleBadge(user.role || "user")}</TableCell>
                      <TableCell>
                        {user.role === "admin" ? (
                          <div className="text-xs text-muted-foreground italic">
                            Unlimited (Admin)
                          </div>
                        ) : (
                          <div className="text-xs space-y-1">
                            <div className="flex items-center gap-1">
                              <span className="w-3 h-3 text-muted-foreground text-center">📱</span>
                              <span>{user.social_accounts?.length || 0}/{formatQuotaValue(user.quota?.max_social_accounts)} accounts</span>
                            </div>
                            <div className="flex items-center gap-1">
                              <FileText className="w-3 h-3 text-muted-foreground" />
                              <span>{user.quota?.posts_this_month ?? 0}/{formatQuotaValue(user.quota?.max_posts_per_month)} posts/mo</span>
                            </div>
                            <div className="flex items-center gap-1">
                              <Calendar className="w-3 h-3 text-muted-foreground" />
                              <span>{user.quota?.posts_today ?? 0}/{formatQuotaValue(user.quota?.max_posts_per_day)} posts/day</span>
                            </div>
                            <div className="flex items-center gap-1">
                              <ImagePlus className="w-3 h-3 text-muted-foreground" />
                              <span>{user.quota?.media_uploads_today ?? 0}/{formatQuotaValue(user.quota?.max_media_uploads_per_day)} uploads/day</span>
                            </div>
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <Sparkles className="w-3 h-3 text-muted-foreground" />
                          <span className="text-sm font-medium">{user.ai_calls || 0}</span>
                          {(user.ai_calls || 0) > 0 && (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                              calls
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {format(new Date(user.created_at), "MMM d, yyyy")}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <SyncUserButton userId={user.id} email={user.email} />
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon">
                                <MoreHorizontal className="w-4 h-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                            <Link to={`/admin/users/${user.id}`}>
                              <DropdownMenuItem>
                                <Eye className="w-4 h-4 mr-2" />
                                View Details
                              </DropdownMenuItem>
                            </Link>
                            <DropdownMenuSeparator />
                            <DropdownMenuLabel>Change Role</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => {
                                if (user.stripe_subscription_id) {
                                  setDowngradeUser(user);
                                  setCancelStripeOnDowngrade(true);
                                  return;
                                }
                                changeRoleMutation.mutate({ userId: user.id, newRole: "user" });
                              }}
                              disabled={user.role === "user" && user.plan_slug === "free"}
                            >
                              <User className="w-4 h-4 mr-2" />
                              Set as Free User
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => {
                                setSubscriberPlanUser(user);
                                setSelectedSubscriberPlan(
                                  user.role === "subscriber" && user.plan_slug && user.plan_slug !== "free"
                                    ? user.plan_slug
                                    : defaultPlanSlug
                                );
                              }}
                            >
                              <Crown className="w-4 h-4 mr-2" />
                              {user.role === "subscriber" ? "Change Plan" : "Set as Subscriber"}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => changeRoleMutation.mutate({ userId: user.id, newRole: "admin" })}
                              disabled={user.role === "admin"}
                            >
                              <Shield className="w-4 h-4 mr-2" />
                              Set as Admin
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => handleEditQuota(user)}>
                              <Settings2 className="w-4 h-4 mr-2" />
                              Edit Quotas
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={() => setDeleteUser(user)}
                            >
                              <Trash2 className="w-4 h-4 mr-2" />
                              Delete User
                            </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Edit Quota Dialog (Single User) */}
      <Dialog open={!!editQuotaUser} onOpenChange={() => setEditQuotaUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Quotas for {editQuotaUser?.email}</DialogTitle>
            <DialogDescription>
              Set custom limits for this user's profiles and posts.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="maxProfiles">Max Social Profiles</Label>
              <Input
                id="maxProfiles"
                type="number"
                min={-1}
                value={quotaMaxProfiles ?? ""}
                placeholder="Empty inherits from plan"
                onChange={(e) => setQuotaMaxProfiles(parseQuotaFieldInput(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">Use -1 for unlimited. Leave empty to inherit from the plan.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="maxSocialAccounts">Max Social Media Accounts</Label>
              <Input
                id="maxSocialAccounts"
                type="number"
                min={-1}
                value={quotaMaxSocialAccounts ?? ""}
                placeholder="Empty inherits from plan"
                onChange={(e) => setQuotaMaxSocialAccounts(parseQuotaFieldInput(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">Use -1 for unlimited. Leave empty to inherit from the plan.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="maxPosts">Max Posts Per Month</Label>
              <Input
                id="maxPosts"
                type="number"
                min={-1}
                value={quotaMaxPosts ?? ""}
                placeholder="Empty inherits from plan"
                onChange={(e) => setQuotaMaxPosts(parseQuotaFieldInput(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">Use -1 for unlimited. Leave empty to inherit from the plan.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="maxPostsPerDay">Max Posts Per Day</Label>
              <Input
                id="maxPostsPerDay"
                type="number"
                min={-1}
                value={quotaMaxPostsPerDay ?? ""}
                placeholder="Empty inherits from plan"
                onChange={(e) => setQuotaMaxPostsPerDay(parseQuotaFieldInput(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">Use -1 for unlimited. Leave empty to inherit from the plan.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="maxMediaUploads">Max Media Uploads Per Day</Label>
              <Input
                id="maxMediaUploads"
                type="number"
                min={-1}
                value={quotaMaxMediaUploads ?? ""}
                placeholder="Empty inherits from plan"
                onChange={(e) => setQuotaMaxMediaUploads(parseQuotaFieldInput(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">Use -1 for unlimited. Leave empty to inherit from the plan.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditQuotaUser(null)}>
              Cancel
            </Button>
            <Button onClick={handleSaveQuota} disabled={isUpdating}>
              {isUpdating && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Edit Quota Dialog */}
      <Dialog open={showBulkEditDialog} onOpenChange={setShowBulkEditDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Bulk Edit Quotas</DialogTitle>
            <DialogDescription>
              Set quotas for {selectedUsers.length} selected user{selectedUsers.length > 1 ? 's' : ''}. Leave a field
              empty to clear that override and have those users inherit it from their plan.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="bulkMaxProfiles">Max Social Profiles</Label>
              <Input
                id="bulkMaxProfiles"
                type="number"
                min={-1}
                value={quotaMaxProfiles ?? ""}
                placeholder="Empty inherits from plan"
                onChange={(e) => setQuotaMaxProfiles(parseQuotaFieldInput(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">Use -1 for unlimited. Leave empty to inherit from the plan.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="bulkMaxSocialAccounts">Max Social Media Accounts</Label>
              <Input
                id="bulkMaxSocialAccounts"
                type="number"
                min={-1}
                value={quotaMaxSocialAccounts ?? ""}
                placeholder="Empty inherits from plan"
                onChange={(e) => setQuotaMaxSocialAccounts(parseQuotaFieldInput(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">Use -1 for unlimited. Leave empty to inherit from the plan.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="bulkMaxPosts">Max Posts Per Month</Label>
              <Input
                id="bulkMaxPosts"
                type="number"
                min={-1}
                value={quotaMaxPosts ?? ""}
                placeholder="Empty inherits from plan"
                onChange={(e) => setQuotaMaxPosts(parseQuotaFieldInput(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">Use -1 for unlimited. Leave empty to inherit from the plan.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="bulkMaxPostsPerDay">Max Posts Per Day</Label>
              <Input
                id="bulkMaxPostsPerDay"
                type="number"
                min={-1}
                value={quotaMaxPostsPerDay ?? ""}
                placeholder="Empty inherits from plan"
                onChange={(e) => setQuotaMaxPostsPerDay(parseQuotaFieldInput(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">Use -1 for unlimited. Leave empty to inherit from the plan.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="bulkMaxMediaUploads">Max Media Uploads Per Day</Label>
              <Input
                id="bulkMaxMediaUploads"
                type="number"
                min={-1}
                value={quotaMaxMediaUploads ?? ""}
                placeholder="Empty inherits from plan"
                onChange={(e) => setQuotaMaxMediaUploads(parseQuotaFieldInput(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">Use -1 for unlimited. Leave empty to inherit from the plan.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBulkEditDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveBulkQuota} disabled={isBulkUpdating}>
              {isBulkUpdating && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Update {selectedUsers.length} User{selectedUsers.length > 1 ? 's' : ''}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Delete Confirmation */}
      <AlertDialog open={showBulkDeleteDialog} onOpenChange={setShowBulkDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedUsers.length} user{selectedUsers.length > 1 ? 's' : ''}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the selected users and all their data including posts, social accounts, and profiles. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleBulkDelete}
              disabled={isBulkDeleting}
            >
              {isBulkDeleting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Delete {selectedUsers.length} User{selectedUsers.length > 1 ? 's' : ''}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Single User Confirmation */}
      <AlertDialog open={!!deleteUser} onOpenChange={() => setDeleteUser(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete user "{deleteUser?.email}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the user and all their data. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteUser) {
                  bulkDeleteUsers([deleteUser.id]);
                }
                setDeleteUser(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Downgrade confirmation for Stripe-billed users */}
      <AlertDialog
        open={!!downgradeUser}
        onOpenChange={(open) => {
          if (!open && !changeRoleMutation.isPending) setDowngradeUser(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Downgrade to Free User</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-semibold">{downgradeUser?.email}</span> is on the{" "}
              <span className="capitalize">{downgradeUser?.plan_slug}</span> plan and pays through Stripe. Their
              subscription record and quotas drop to Free immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex items-start gap-3 rounded-md border p-3">
            <Checkbox
              id="cancel-stripe-on-downgrade"
              checked={cancelStripeOnDowngrade}
              onCheckedChange={(checked) => setCancelStripeOnDowngrade(checked === true)}
            />
            <Label htmlFor="cancel-stripe-on-downgrade" className="text-sm font-normal leading-snug">
              Cancel their Stripe subscription now
              <span className="block text-xs text-muted-foreground">
                Leave this unchecked only if you are handling the billing separately — otherwise Stripe keeps charging
                them.
              </span>
            </Label>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={changeRoleMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={changeRoleMutation.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (!downgradeUser) return;
                changeRoleMutation.mutate({
                  userId: downgradeUser.id,
                  newRole: "user",
                  stripeSubscriptionIdToCancel: cancelStripeOnDowngrade
                    ? downgradeUser.stripe_subscription_id ?? undefined
                    : undefined,
                });
              }}
            >
              {changeRoleMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Downgrade
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Plan Selection Dialog for Subscriber Role */}
      <Dialog
        open={!!subscriberPlanUser}
        onOpenChange={(open) => {
          if (!open && !changeRoleMutation.isPending) setSubscriberPlanUser(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {subscriberPlanUser?.role === "subscriber" ? "Change Subscription Plan" : "Select Subscription Plan"}
            </DialogTitle>
            <DialogDescription>
              Choose which plan to assign to <span className="font-semibold">{subscriberPlanUser?.email}</span>. The
              subscription record and quotas will be updated based on the selected plan.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-4">
            <Label>Plan</Label>
            <Select value={selectedSubscriberPlan} onValueChange={setSelectedSubscriberPlan}>
              <SelectTrigger>
                <SelectValue placeholder="Select a plan" />
              </SelectTrigger>
              <SelectContent>
                {assignablePlans.map((plan) => (
                  <SelectItem key={plan.id} value={plan.slug}>
                    <div className="flex flex-col">
                      <span>{plan.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {[
                          plan.profile_limit == null
                            ? null
                            : plan.profile_limit === -1
                              ? "Unlimited profiles"
                              : `${plan.profile_limit} profiles`,
                          plan.price_monthly == null ? null : `$${plan.price_monthly}/mo`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Current plan:{" "}
              <span className="font-medium capitalize">{subscriberPlanUser?.plan_slug || "free"}</span>
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSubscriberPlanUser(null)}
              disabled={changeRoleMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (subscriberPlanUser) {
                  changeRoleMutation.mutate({
                    userId: subscriberPlanUser.id,
                    newRole: "subscriber",
                    planSlug: selectedSubscriberPlan,
                  });
                }
              }}
              disabled={changeRoleMutation.isPending || !selectedSubscriberPlan}
            >
              {changeRoleMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Assign {assignablePlans.find((plan) => plan.slug === selectedSubscriberPlan)?.name || "Plan"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
