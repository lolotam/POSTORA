import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Save, Settings, Users, FileText, Calendar, ImagePlus, Share2, Zap, Crown, Edit } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface PlanQuota {
  plan_slug: string;
  plan_name: string;
  max_profiles: number;
  max_social_accounts: number;
  max_posts_per_month: number;
  max_posts_per_day: number;
  max_media_uploads_per_day: number;
}

// Default quotas that match the hardcoded values
const DEFAULT_QUOTAS: PlanQuota[] = [
  {
    plan_slug: "free",
    plan_name: "Free",
    max_profiles: 2,
    max_social_accounts: 3,
    max_posts_per_month: 30,
    max_posts_per_day: 2,
    max_media_uploads_per_day: 20,
  },
  {
    plan_slug: "pro",
    plan_name: "Pro",
    max_profiles: 15,
    max_social_accounts: 30,
    max_posts_per_month: 500,
    max_posts_per_day: 30,
    max_media_uploads_per_day: -1,
  },
  {
    plan_slug: "business",
    plan_name: "Business",
    max_profiles: -1,
    max_social_accounts: -1,
    max_posts_per_month: -1,
    max_posts_per_day: -1,
    max_media_uploads_per_day: -1,
  },
];

export default function AdminPlanQuotas() {
  const [editPlan, setEditPlan] = useState<PlanQuota | null>(null);
  const [formData, setFormData] = useState<Omit<PlanQuota, "plan_name">>({
    plan_slug: "",
    max_profiles: 0,
    max_social_accounts: 0,
    max_posts_per_month: 0,
    max_posts_per_day: 0,
    max_media_uploads_per_day: 0,
  });
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Fetch plan quotas from app_settings or use defaults
  const { data: quotas = DEFAULT_QUOTAS, isLoading } = useQuery({
    queryKey: ["plan-quotas"],
    queryFn: async (): Promise<PlanQuota[]> => {
      const { data: settings, error } = await supabase
        .from("app_settings")
        .select("*")
        .eq("key", "plan_quotas")
        .maybeSingle();

      if (error) {
        console.error("Error fetching plan quotas:", error);
        return DEFAULT_QUOTAS;
      }

      if (settings?.value) {
        try {
          const parsed = settings.value as unknown as PlanQuota[];
          return Array.isArray(parsed) ? parsed : DEFAULT_QUOTAS;
        } catch {
          return DEFAULT_QUOTAS;
        }
      }

      return DEFAULT_QUOTAS;
    },
  });

  // Update plan quotas mutation
  const updateQuotasMutation = useMutation({
    mutationFn: async (updatedQuotas: PlanQuota[]) => {
      const { data: existing } = await supabase
        .from("app_settings")
        .select("id")
        .eq("key", "plan_quotas")
        .maybeSingle();

      // Convert to JSON-compatible format
      const jsonValue = JSON.parse(JSON.stringify(updatedQuotas));

      if (existing) {
        const { error } = await supabase
          .from("app_settings")
          .update({
            value: jsonValue,
            description: "Plan-based quota limits for profiles, social accounts, posts, and media uploads",
            updated_at: new Date().toISOString(),
          })
          .eq("key", "plan_quotas");

        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("app_settings")
          .insert([{
            key: "plan_quotas",
            value: jsonValue,
            description: "Plan-based quota limits for profiles, social accounts, posts, and media uploads",
          }]);

        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["plan-quotas"] });
      toast({
        title: "Quotas updated",
        description: "Plan quotas have been saved successfully.",
      });
      setEditPlan(null);
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to update quotas",
        variant: "destructive",
      });
    },
  });

  const handleEditPlan = (plan: PlanQuota) => {
    setEditPlan(plan);
    setFormData({
      plan_slug: plan.plan_slug,
      max_profiles: plan.max_profiles,
      max_social_accounts: plan.max_social_accounts,
      max_posts_per_month: plan.max_posts_per_month,
      max_posts_per_day: plan.max_posts_per_day,
      max_media_uploads_per_day: plan.max_media_uploads_per_day,
    });
  };

  const handleSave = () => {
    if (!editPlan) return;

    const updatedQuotas = quotas.map((q) =>
      q.plan_slug === editPlan.plan_slug
        ? { ...q, ...formData, plan_name: editPlan.plan_name }
        : q
    );

    updateQuotasMutation.mutate(updatedQuotas);
  };

  const formatLimit = (value: number) => {
    return value === -1 ? "∞" : value.toString();
  };

  const getPlanBadge = (planSlug: string) => {
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
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold">Plan Quota Management</h2>
            <p className="text-muted-foreground">
              Configure quota limits for each subscription plan
            </p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="w-5 h-5" />
              Subscription Plan Quotas
            </CardTitle>
            <CardDescription>
              Set the maximum limits for profiles, social accounts, posts, and media uploads for each plan.
              Use -1 for unlimited.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="rounded-xl border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Plan</TableHead>
                      <TableHead className="text-center">
                        <div className="flex items-center justify-center gap-1">
                          <Users className="w-4 h-4" />
                          Profiles
                        </div>
                      </TableHead>
                      <TableHead className="text-center">
                        <div className="flex items-center justify-center gap-1">
                          <Share2 className="w-4 h-4" />
                          Social Accounts
                        </div>
                      </TableHead>
                      <TableHead className="text-center">
                        <div className="flex items-center justify-center gap-1">
                          <FileText className="w-4 h-4" />
                          Posts/Month
                        </div>
                      </TableHead>
                      <TableHead className="text-center">
                        <div className="flex items-center justify-center gap-1">
                          <Calendar className="w-4 h-4" />
                          Posts/Day
                        </div>
                      </TableHead>
                      <TableHead className="text-center">
                        <div className="flex items-center justify-center gap-1">
                          <ImagePlus className="w-4 h-4" />
                          Uploads/Day
                        </div>
                      </TableHead>
                      <TableHead className="w-[100px]">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {quotas.map((plan) => (
                      <TableRow key={plan.plan_slug}>
                        <TableCell>{getPlanBadge(plan.plan_slug)}</TableCell>
                        <TableCell className="text-center font-mono">
                          {formatLimit(plan.max_profiles)}
                        </TableCell>
                        <TableCell className="text-center font-mono">
                          {formatLimit(plan.max_social_accounts)}
                        </TableCell>
                        <TableCell className="text-center font-mono">
                          {formatLimit(plan.max_posts_per_month)}
                        </TableCell>
                        <TableCell className="text-center font-mono">
                          {formatLimit(plan.max_posts_per_day)}
                        </TableCell>
                        <TableCell className="text-center font-mono">
                          {formatLimit(plan.max_media_uploads_per_day)}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleEditPlan(plan)}
                          >
                            <Edit className="w-4 h-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Important Notes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>• <strong>-1</strong> means unlimited for that resource.</p>
            <p>• Changes here affect how quotas are displayed in the admin panel and the /profiles page.</p>
            <p>• To apply quota changes to existing users, use the <strong>Sync Quotas</strong> button in the Users Management page.</p>
            <p>• New subscribers will automatically get the quotas defined here when their subscription is activated via Stripe webhook.</p>
            <p>• For immediate effect on edge functions (stripe-webhook, sync-user-quotas), the values should match the database.</p>
          </CardContent>
        </Card>
      </div>

      {/* Edit Quota Dialog */}
      <Dialog open={!!editPlan} onOpenChange={() => setEditPlan(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {editPlan?.plan_name} Plan Quotas</DialogTitle>
            <DialogDescription>
              Update the quota limits for this plan. Use -1 for unlimited.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="maxProfiles" className="flex items-center gap-2">
                <Users className="w-4 h-4" />
                Max Profiles
              </Label>
              <Input
                id="maxProfiles"
                type="number"
                min={-1}
                value={formData.max_profiles}
                onChange={(e) => setFormData({ ...formData, max_profiles: parseInt(e.target.value) || 0 })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="maxSocialAccounts" className="flex items-center gap-2">
                <Share2 className="w-4 h-4" />
                Max Social Accounts
              </Label>
              <Input
                id="maxSocialAccounts"
                type="number"
                min={-1}
                value={formData.max_social_accounts}
                onChange={(e) => setFormData({ ...formData, max_social_accounts: parseInt(e.target.value) || 0 })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="maxPostsMonth" className="flex items-center gap-2">
                <FileText className="w-4 h-4" />
                Max Posts Per Month
              </Label>
              <Input
                id="maxPostsMonth"
                type="number"
                min={-1}
                value={formData.max_posts_per_month}
                onChange={(e) => setFormData({ ...formData, max_posts_per_month: parseInt(e.target.value) || 0 })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="maxPostsDay" className="flex items-center gap-2">
                <Calendar className="w-4 h-4" />
                Max Posts Per Day
              </Label>
              <Input
                id="maxPostsDay"
                type="number"
                min={-1}
                value={formData.max_posts_per_day}
                onChange={(e) => setFormData({ ...formData, max_posts_per_day: parseInt(e.target.value) || 0 })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="maxUploads" className="flex items-center gap-2">
                <ImagePlus className="w-4 h-4" />
                Max Media Uploads Per Day
              </Label>
              <Input
                id="maxUploads"
                type="number"
                min={-1}
                value={formData.max_media_uploads_per_day}
                onChange={(e) => setFormData({ ...formData, max_media_uploads_per_day: parseInt(e.target.value) || 0 })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditPlan(null)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={updateQuotasMutation.isPending} className="gap-2">
              {updateQuotasMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Save className="w-4 h-4" />
              )}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}