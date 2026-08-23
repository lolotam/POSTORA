import { useState } from "react";
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
import { usePlanQuotas } from "@/hooks/usePlanQuotas";
import type { PlanQuota } from "@/hooks/usePlanQuotas";
import { validateQuotaFieldInput } from "@/lib/quotaValidation";

type QuotaFormValues = {
  plan_slug: string;
  profile_limit: number | null;
  max_social_accounts: number | null;
  max_posts_per_month: number | null;
  max_posts_per_day: number | null;
  max_media_uploads_per_day: number | null;
};

type QuotaFieldName = keyof Omit<QuotaFormValues, "plan_slug">;

// R5 (CodeRabbit round 2, 2026-08-23): raw string per field, always shown in
// the Input regardless of validity. See the comment on handleQuotaFieldChange
// below for why formData's numeric snapshot is no longer written on every
// keystroke.
type QuotaRawValues = Record<QuotaFieldName, string>;

const EMPTY_RAW_VALUES: QuotaRawValues = {
  profile_limit: "",
  max_social_accounts: "",
  max_posts_per_month: "",
  max_posts_per_day: "",
  max_media_uploads_per_day: "",
};

const EMPTY_FIELD_ERRORS: Record<QuotaFieldName, string | null> = {
  profile_limit: null,
  max_social_accounts: null,
  max_posts_per_month: null,
  max_posts_per_day: null,
  max_media_uploads_per_day: null,
};

function toRawQuotaValue(value: number | null): string {
  return value === null ? "" : String(value);
}

export default function AdminPlanQuotas() {
  const [editPlan, setEditPlan] = useState<PlanQuota | null>(null);
  // R5: the raw text the admin typed, kept verbatim - never snapped back to
  // the last valid number. Converted to a number only in handleSave().
  const [rawFieldValues, setRawFieldValues] = useState<QuotaRawValues>(EMPTY_RAW_VALUES);
  const { quotas, isLoading, updateQuota } = usePlanQuotas();

  // F8 (CodeRabbit round 1): per-field validation error text (null = valid).
  const [fieldErrors, setFieldErrors] = useState<Record<QuotaFieldName, string | null>>(EMPTY_FIELD_ERRORS);
  const hasFieldErrors = Object.values(fieldErrors).some(Boolean);

  const handleEditPlan = (plan: PlanQuota) => {
    setEditPlan(plan);
    setRawFieldValues({
      profile_limit: toRawQuotaValue(plan.profile_limit),
      max_social_accounts: toRawQuotaValue(plan.max_social_accounts),
      max_posts_per_month: toRawQuotaValue(plan.max_posts_per_month),
      max_posts_per_day: toRawQuotaValue(plan.max_posts_per_day),
      max_media_uploads_per_day: toRawQuotaValue(plan.max_media_uploads_per_day),
    });
    setFieldErrors(EMPTY_FIELD_ERRORS);
  };

  // R5 (CodeRabbit round 2): the raw string is ALWAYS written, so the admin
  // always sees exactly what they typed. Validation only ever updates the
  // error message next to the field - it used to gate whether formData's
  // numeric snapshot updated at all, which meant a rejected keystroke made
  // the controlled Input snap back to the last valid number with no way to
  // see or correct what was actually typed.
  const handleQuotaFieldChange = (field: QuotaFieldName, raw: string) => {
    setRawFieldValues((prev) => ({ ...prev, [field]: raw }));
    const { error } = validateQuotaFieldInput(raw);
    setFieldErrors((prev) => ({ ...prev, [field]: error }));
  };

  const handleSave = () => {
    if (!editPlan || hasFieldErrors) return;
    const formData: QuotaFormValues = {
      plan_slug: editPlan.plan_slug,
      profile_limit: validateQuotaFieldInput(rawFieldValues.profile_limit).value,
      max_social_accounts: validateQuotaFieldInput(rawFieldValues.max_social_accounts).value,
      max_posts_per_month: validateQuotaFieldInput(rawFieldValues.max_posts_per_month).value,
      max_posts_per_day: validateQuotaFieldInput(rawFieldValues.max_posts_per_day).value,
      max_media_uploads_per_day: validateQuotaFieldInput(rawFieldValues.max_media_uploads_per_day).value,
    };
    updateQuota.mutate(
      { ...editPlan, ...formData },
      { onSuccess: () => setEditPlan(null) }
    );
  };

  const formatLimit = (value: number | null) => {
    if (value === null) return "inherit";
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
              Use -1 for unlimited. Leave a field empty to inherit the built-in Free-tier default.
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
                          {formatLimit(plan.profile_limit)}
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
            <p>• <strong>Empty (NULL)</strong> means the plan inherits the built-in Free-tier default for that quota (2 profiles, 3 social accounts, 30 posts/month, 2 posts/day, 20 uploads/day). An empty field is saved as NULL — <strong>0 is a real value</strong> that means "this plan allows zero", so never enter 0 to mean inherit.</p>
            <p>• Quotas are saved directly to the <strong>subscription_plans</strong> table and <strong>take effect immediately</strong> — every quota check resolves through the database, so users on the plan inherit new values on their next action. No sync step is required.</p>
            <p>• Per-user overrides on the Users Management page win over plan values — they can raise or lower a limit for a single user.</p>
            <p className="text-destructive">• <strong>Warning:</strong> the <strong>Sync Quotas</strong> action on the Users Management page <strong>clears per-user overrides</strong>, resetting every affected user back to these plan values. Running it will erase deliberate per-user grants — use it only when that is exactly what you intend.</p>
          </CardContent>
        </Card>
      </div>

      {/* Edit Quota Dialog */}
      <Dialog open={!!editPlan} onOpenChange={() => setEditPlan(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {editPlan?.plan_name} Plan Quotas</DialogTitle>
            <DialogDescription>
              Update the quota limits for this plan. Use -1 for unlimited. Leave a field empty to inherit the Free-tier default.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="profileLimit" className="flex items-center gap-2">
                <Users className="w-4 h-4" />
                Social Profiles (shared with Plans page)
              </Label>
              <Input
                id="profileLimit"
                type="number"
                min={-1}
                value={rawFieldValues.profile_limit}
                placeholder="Empty inherits Free default (2)"
                aria-invalid={!!fieldErrors.profile_limit}
                onChange={(e) => handleQuotaFieldChange("profile_limit", e.target.value)}
              />
              {fieldErrors.profile_limit && (
                <p className="text-xs text-destructive">{fieldErrors.profile_limit}</p>
              )}
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
                value={rawFieldValues.max_social_accounts}
                placeholder="Empty inherits Free default (3)"
                aria-invalid={!!fieldErrors.max_social_accounts}
                onChange={(e) => handleQuotaFieldChange("max_social_accounts", e.target.value)}
              />
              {fieldErrors.max_social_accounts && (
                <p className="text-xs text-destructive">{fieldErrors.max_social_accounts}</p>
              )}
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
                value={rawFieldValues.max_posts_per_month}
                placeholder="Empty inherits Free default (30)"
                aria-invalid={!!fieldErrors.max_posts_per_month}
                onChange={(e) => handleQuotaFieldChange("max_posts_per_month", e.target.value)}
              />
              {fieldErrors.max_posts_per_month && (
                <p className="text-xs text-destructive">{fieldErrors.max_posts_per_month}</p>
              )}
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
                value={rawFieldValues.max_posts_per_day}
                placeholder="Empty inherits Free default (2)"
                aria-invalid={!!fieldErrors.max_posts_per_day}
                onChange={(e) => handleQuotaFieldChange("max_posts_per_day", e.target.value)}
              />
              {fieldErrors.max_posts_per_day && (
                <p className="text-xs text-destructive">{fieldErrors.max_posts_per_day}</p>
              )}
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
                value={rawFieldValues.max_media_uploads_per_day}
                placeholder="Empty inherits Free default (20)"
                aria-invalid={!!fieldErrors.max_media_uploads_per_day}
                onChange={(e) => handleQuotaFieldChange("max_media_uploads_per_day", e.target.value)}
              />
              {fieldErrors.max_media_uploads_per_day && (
                <p className="text-xs text-destructive">{fieldErrors.max_media_uploads_per_day}</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditPlan(null)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={updateQuota.isPending || hasFieldErrors} className="gap-2">
              {updateQuota.isPending ? (
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
