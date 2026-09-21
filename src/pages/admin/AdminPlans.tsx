import { useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Loader2, Plus, Trash2, GripVertical, Pencil } from "lucide-react";
import { useAllSubscriptionPlans, useUpdateSubscriptionPlan, useCreateSubscriptionPlan, useDeleteSubscriptionPlan, SubscriptionPlan } from "@/hooks/useSubscriptionPlans";
import { FREE_TIER_FALLBACK } from "@/hooks/useQuotas";
import { useToast } from "@/hooks/use-toast";
import { validateQuotaFieldInput } from "@/lib/quotaValidation";

/**
 * An empty input means "no explicit limit on this plan" — NULL, which falls
 * back to the built-in Free-tier default through effective_user_quotas().
 * Must be sent as NULL, never coerced to a hardcoded number (minor-3,
 * 2026-08-23 final review — this used to be `parseInt(...) || 2`, which
 * silently reset a cleared field to 2 instead of letting it inherit).
 * Mirrors AdminPlanQuotas.tsx's parseQuotaInput(), which sends NULL for the
 * same subscription_plans.profile_limit column.
 *
 * F8 (CodeRabbit round 1): delegates to the shared
 * src/lib/quotaValidation.ts, which additionally rejects (rather than
 * silently truncating) a fractional value or one below -1.
 */
const parseQuotaInput = (raw: string): number | null => validateQuotaFieldInput(raw).value;

export default function AdminPlans() {
  const { data: plans = [], isLoading } = useAllSubscriptionPlans();
  const updatePlanMutation = useUpdateSubscriptionPlan();
  const createPlanMutation = useCreateSubscriptionPlan();
  const deletePlanMutation = useDeleteSubscriptionPlan();
  const { toast } = useToast();
  
  const [editingPlan, setEditingPlan] = useState<SubscriptionPlan | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newPlan, setNewPlan] = useState({
    name: "",
    slug: "",
    price_monthly: "",
    price_yearly: "",
    profile_limit: "2",
    features: "",
    is_popular: false,
    is_active: true,
    sort_order: 0,
  });
  // F8 (CodeRabbit round 1): visible validation error for the create-plan
  // profile_limit field, and for the edit-plan one below.
  const [newPlanProfileLimitError, setNewPlanProfileLimitError] = useState<string | null>(null);
  const [editPlanProfileLimitError, setEditPlanProfileLimitError] = useState<string | null>(null);

  const handleToggleActive = async (plan: SubscriptionPlan) => {
    try {
      await updatePlanMutation.mutateAsync({
        id: plan.id,
        is_active: !plan.is_active,
      });
      toast({
        title: plan.is_active ? "Plan deactivated" : "Plan activated",
        description: `${plan.name} has been ${plan.is_active ? "deactivated" : "activated"}.`,
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to update plan",
        variant: "destructive",
      });
    }
  };

  const handleTogglePopular = async (plan: SubscriptionPlan) => {
    try {
      // First, unset popular from all other plans
      for (const p of plans.filter((p) => p.is_popular && p.id !== plan.id)) {
        await updatePlanMutation.mutateAsync({ id: p.id, is_popular: false });
      }
      // Then toggle this plan
      await updatePlanMutation.mutateAsync({
        id: plan.id,
        is_popular: !plan.is_popular,
      });
      toast({
        title: "Updated",
        description: `${plan.name} is ${!plan.is_popular ? "now" : "no longer"} marked as popular.`,
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to update plan",
        variant: "destructive",
      });
    }
  };

  const handleCreatePlan = async () => {
    // F8: re-validate at submit time even though the field's onChange
    // already tracks an error - defence in depth against a stale/disabled
    // check being bypassed.
    const { value: profileLimit, error: profileLimitError } = validateQuotaFieldInput(
      newPlan.profile_limit,
    );
    if (profileLimitError) {
      setNewPlanProfileLimitError(profileLimitError);
      return;
    }

    try {
      await createPlanMutation.mutateAsync({
        name: newPlan.name,
        slug: newPlan.slug,
        price_monthly: parseFloat(newPlan.price_monthly) || 0,
        price_yearly: parseFloat(newPlan.price_yearly) || 0,
        profile_limit: profileLimit,
        features: newPlan.features.split("\n").filter((f) => f.trim()),
        is_popular: newPlan.is_popular,
        is_active: newPlan.is_active,
        sort_order: plans.length + 1,
      });
      toast({
        title: "Plan created",
        description: `${newPlan.name} has been created.`,
      });
      setIsCreateOpen(false);
      setNewPlan({
        name: "",
        slug: "",
        price_monthly: "",
        price_yearly: "",
        profile_limit: "2",
        features: "",
        is_popular: false,
        is_active: true,
        sort_order: 0,
      });
      setNewPlanProfileLimitError(null);
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to create plan",
        variant: "destructive",
      });
    }
  };

  const handleDeletePlan = async (plan: SubscriptionPlan) => {
    try {
      await deletePlanMutation.mutateAsync(plan.id);
      toast({
        title: "Plan deleted",
        description: `${plan.name} has been deleted.`,
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to delete plan",
        variant: "destructive",
      });
    }
  };

  const handleSaveEdit = async () => {
    if (!editingPlan) return;
    try {
      await updatePlanMutation.mutateAsync({
        id: editingPlan.id,
        name: editingPlan.name,
        price_monthly: editingPlan.price_monthly,
        price_yearly: editingPlan.price_yearly,
        profile_limit: editingPlan.profile_limit,
        features: editingPlan.features,
      });
      toast({
        title: "Plan updated",
        description: `${editingPlan.name} has been updated.`,
      });
      setEditingPlan(null);
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to update plan",
        variant: "destructive",
      });
    }
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold">Plans Builder</h2>
            <p className="text-muted-foreground">Create and manage subscription plans</p>
          </div>
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="w-4 h-4 me-2" />
                Create Plan
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create New Plan</DialogTitle>
                <DialogDescription>Add a new subscription plan</DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Name</Label>
                    <Input
                      value={newPlan.name}
                      onChange={(e) => setNewPlan({ ...newPlan, name: e.target.value })}
                      placeholder="Pro"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Slug</Label>
                    <Input
                      value={newPlan.slug}
                      onChange={(e) => setNewPlan({ ...newPlan, slug: e.target.value })}
                      placeholder="pro"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Monthly Price ($)</Label>
                    <Input
                      type="number"
                      value={newPlan.price_monthly}
                      onChange={(e) => setNewPlan({ ...newPlan, price_monthly: e.target.value })}
                      placeholder="19.99"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Yearly Price ($)</Label>
                    <Input
                      type="number"
                      value={newPlan.price_yearly}
                      onChange={(e) => setNewPlan({ ...newPlan, price_yearly: e.target.value })}
                      placeholder="199.99"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Social Profiles</Label>
                  <Input
                    type="number"
                    value={newPlan.profile_limit}
                    aria-invalid={!!newPlanProfileLimitError}
                    onChange={(e) => {
                      setNewPlan({ ...newPlan, profile_limit: e.target.value });
                      setNewPlanProfileLimitError(validateQuotaFieldInput(e.target.value).error);
                    }}
                  />
                  {newPlanProfileLimitError ? (
                    <p className="text-xs text-destructive">{newPlanProfileLimitError}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Use -1 for unlimited. Shared with the Plan Quotas page — editing here changes both.
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label>Features (one per line)</Label>
                  <Textarea
                    value={newPlan.features}
                    onChange={(e) => setNewPlan({ ...newPlan, features: e.target.value })}
                    placeholder="10 Social Profiles&#10;Unlimited Posts&#10;Priority Support"
                    rows={4}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={newPlan.is_popular}
                    onCheckedChange={(checked) => setNewPlan({ ...newPlan, is_popular: checked })}
                  />
                  <Label>Mark as Popular</Label>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setIsCreateOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={handleCreatePlan}
                  disabled={createPlanMutation.isPending || !!newPlanProfileLimitError}
                >
                  {createPlanMutation.isPending && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
                  Create Plan
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        {/* Plans List */}
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            {plans.map((plan) => (
              <Card key={plan.id} className={!plan.is_active ? "opacity-60" : ""}>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <div className="flex items-center gap-3">
                    <GripVertical className="w-5 h-5 text-muted-foreground cursor-grab" />
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        {plan.name}
                        {plan.is_popular && (
                          <Badge className="bg-primary/10 text-primary border-primary/30">
                            Popular
                          </Badge>
                        )}
                        {!plan.is_active && (
                          <Badge variant="secondary">Inactive</Badge>
                        )}
                      </CardTitle>
                      <CardDescription>
                        ${plan.price_monthly}/mo • ${plan.price_yearly}/yr •{" "}
                        {plan.profile_limit === -1
                          ? "Unlimited"
                          : plan.profile_limit ?? FREE_TIER_FALLBACK.max_profiles}{" "}
                        profiles
                      </CardDescription>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditingPlan(plan);
                        setEditPlanProfileLimitError(null);
                      }}
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleTogglePopular(plan)}
                    >
                      {plan.is_popular ? "Unmark Popular" : "Mark Popular"}
                    </Button>
                    <Switch
                      checked={plan.is_active}
                      onCheckedChange={() => handleToggleActive(plan)}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-destructive"
                      onClick={() => handleDeletePlan(plan)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-2">
                    {plan.features.map((feature, index) => (
                      <Badge key={index} variant="secondary">
                        {feature}
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Edit Plan Dialog */}
        <Dialog open={!!editingPlan} onOpenChange={() => setEditingPlan(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit Plan</DialogTitle>
              <DialogDescription>Update plan details</DialogDescription>
            </DialogHeader>
            {editingPlan && (
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label>Name</Label>
                  <Input
                    value={editingPlan.name}
                    onChange={(e) => setEditingPlan({ ...editingPlan, name: e.target.value })}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Monthly Price ($)</Label>
                    <Input
                      type="number"
                      value={editingPlan.price_monthly || ""}
                      onChange={(e) =>
                        setEditingPlan({
                          ...editingPlan,
                          price_monthly: parseFloat(e.target.value) || null,
                        })
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Yearly Price ($)</Label>
                    <Input
                      type="number"
                      value={editingPlan.price_yearly || ""}
                      onChange={(e) =>
                        setEditingPlan({
                          ...editingPlan,
                          price_yearly: parseFloat(e.target.value) || null,
                        })
                      }
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Social Profiles</Label>
                  <Input
                    type="number"
                    value={editingPlan.profile_limit ?? ""}
                    placeholder="Empty inherits the Free default"
                    aria-invalid={!!editPlanProfileLimitError}
                    onChange={(e) => {
                      const { value, error } = validateQuotaFieldInput(e.target.value);
                      setEditPlanProfileLimitError(error);
                      if (!error) setEditingPlan({ ...editingPlan, profile_limit: value });
                    }}
                  />
                  {editPlanProfileLimitError ? (
                    <p className="text-xs text-destructive">{editPlanProfileLimitError}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Use -1 for unlimited. Shared with the Plan Quotas page — editing here changes both.
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label>Features (one per line)</Label>
                  <Textarea
                    value={editingPlan.features.join("\n")}
                    onChange={(e) =>
                      setEditingPlan({
                        ...editingPlan,
                        features: e.target.value.split("\n").filter((f) => f.trim()),
                      })
                    }
                    rows={4}
                  />
                </div>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditingPlan(null)}>
                Cancel
              </Button>
              <Button onClick={handleSaveEdit} disabled={updatePlanMutation.isPending || !!editPlanProfileLimitError}>
                {updatePlanMutation.isPending && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
                Save Changes
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
