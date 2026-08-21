import { useState, useMemo } from "react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { Navigate } from "react-router-dom";
import { useSocialAccounts } from "@/hooks/useSocialAccounts";
import { useAdAccounts, useCampaigns } from "@/hooks/useAdAnalytics";
import { useCreateCampaign, useUpdateCampaignStatus, useDeleteCampaign } from "@/hooks/useAdManager";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Megaphone, Plus, Loader2, Play, Pause, Trash2, AlertCircle } from "lucide-react";
import { Icon3D, GradientHeading, GradientRingCard, GradientDivider, Reveal } from "@/components/fx";

const OBJECTIVES = [
  { value: "OUTCOME_AWARENESS", label: "Brand Awareness" },
  { value: "OUTCOME_TRAFFIC", label: "Traffic" },
  { value: "OUTCOME_ENGAGEMENT", label: "Engagement" },
  { value: "OUTCOME_LEADS", label: "Lead Generation" },
  { value: "OUTCOME_SALES", label: "Sales" },
  { value: "OUTCOME_APP_PROMOTION", label: "App Promotion" },
];

export default function AdManager() {
  const { flags, isLoading: flagsLoading } = useFeatureFlags();
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [selectedAdAccountId, setSelectedAdAccountId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newObjective, setNewObjective] = useState("");
  const [newBudget, setNewBudget] = useState("");

  const { data: socialAccounts = [] } = useSocialAccounts();
  const fbAccounts = useMemo(
    () => socialAccounts.filter((a) => a.platform === "facebook" && a.is_active),
    [socialAccounts]
  );
  const activeAccountId = selectedAccountId || fbAccounts[0]?.id || null;
  const { data: adAccounts = [], isLoading: adAccountsLoading, error: adAccountsError } = useAdAccounts(activeAccountId);
  const activeAdAccountId = selectedAdAccountId || adAccounts[0]?.id || null;
  const { data: campaigns = [], isLoading } = useCampaigns(activeAccountId, activeAdAccountId);

  const createCampaign = useCreateCampaign();
  const updateStatus = useUpdateCampaignStatus();
  const deleteCampaign = useDeleteCampaign();

  if (!flagsLoading && !flags.adManager) {
    return <Navigate to="/dashboard" replace />;
  }

  const handleCreate = () => {
    if (!activeAccountId || !activeAdAccountId || !newName || !newObjective) return;
    createCampaign.mutate({
      socialAccountId: activeAccountId,
      adAccountId: activeAdAccountId,
      name: newName,
      objective: newObjective,
      dailyBudget: newBudget ? String(parseInt(newBudget) * 100) : undefined, // cents
    }, {
      onSuccess: () => {
        setCreateOpen(false);
        setNewName("");
        setNewObjective("");
        setNewBudget("");
      },
    });
  };

  return (
    <DashboardLayout>
      <div className="w-full space-y-6">
        {/* Header */}
        <Reveal>
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="group flex items-center gap-4 min-w-0">
              <Icon3D icon={Megaphone} variant="rose" size="md" />
              <div className="flex-1 min-w-0">
                <GradientHeading preset="amber-rose-violet" size="lg" as="h1">Ad Campaign Manager</GradientHeading>
                <p className="text-sm text-muted-foreground mt-1">Create and manage Facebook/Instagram ad campaigns</p>
              </div>
            </div>
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0} className="inline-flex">
                    <DialogTrigger asChild>
                      <Button size="sm" className="bg-gradient-to-r from-rose-500 via-pink-500 to-fuchsia-500 text-white hover:opacity-90 disabled:bg-none disabled:bg-muted disabled:text-muted-foreground" disabled={!activeAdAccountId || adAccountsLoading}>
                        {adAccountsLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Plus className="h-4 w-4 mr-1" />}
                        New Campaign
                      </Button>
                    </DialogTrigger>
                  </span>
                </TooltipTrigger>
                {!activeAdAccountId && !adAccountsLoading && (
                  <TooltipContent>
                    {fbAccounts.length === 0
                      ? "Connect a Facebook account first"
                      : adAccountsError
                        ? "Failed to load ad accounts"
                        : "No ad accounts found for this Facebook account"}
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
            <DialogContent className="bg-card/85 backdrop-blur-xl border-border/50">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-3">
                  <span className="group inline-flex"><Icon3D icon={Megaphone} variant="rose" size="sm" /></span>
                  Create Campaign
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label>Campaign Name</Label>
                  <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="My Campaign" />
                </div>
                <div className="space-y-1.5">
                  <Label>Objective</Label>
                  <Select value={newObjective} onValueChange={setNewObjective}>
                    <SelectTrigger><SelectValue placeholder="Select objective" /></SelectTrigger>
                    <SelectContent>
                      {OBJECTIVES.map((o) => (
                        <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Daily Budget ($)</Label>
                  <Input type="number" value={newBudget} onChange={(e) => setNewBudget(e.target.value)} placeholder="10" />
                </div>
                <Button onClick={handleCreate} disabled={!newName || !newObjective || createCampaign.isPending} className="w-full bg-gradient-to-r from-rose-500 via-pink-500 to-fuchsia-500 text-white hover:opacity-90">
                  {createCampaign.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                  Create Campaign
                </Button>
              </div>
            </DialogContent>
          </Dialog>
          </div>
        </Reveal>
        <GradientDivider tone="rose" />

        {/* Controls */}
        <Reveal delay={80}>
        <GradientRingCard variant="rose" padded={false} hoverLift={false} ringIntensity="subtle" innerClassName="p-4">
        <div className="flex flex-wrap gap-4 items-end">
          {fbAccounts.length > 0 && (
            <div className="space-y-1.5">
              <span className="text-xs text-muted-foreground">Facebook Account</span>
              <Select value={activeAccountId || ""} onValueChange={setSelectedAccountId}>
                <SelectTrigger className="w-[200px] h-9"><SelectValue placeholder="Select account" /></SelectTrigger>
                <SelectContent>
                  {fbAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.platform_username || a.platform_user_id}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {adAccounts.length > 0 && (
            <div className="space-y-1.5">
              <span className="text-xs text-muted-foreground">Ad Account</span>
              <Select value={activeAdAccountId || ""} onValueChange={setSelectedAdAccountId}>
                <SelectTrigger className="w-[220px] h-9"><SelectValue placeholder="Select ad account" /></SelectTrigger>
                <SelectContent>
                  {adAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        </GradientRingCard>
        </Reveal>

        {/* Ad accounts feedback */}
        {fbAccounts.length > 0 && !adAccountsLoading && adAccounts.length === 0 && (
          <GradientRingCard variant="amber" padded={false} hoverLift={false} ringIntensity="subtle" innerClassName="px-4 py-3 flex items-center gap-2 text-sm text-muted-foreground">
            <AlertCircle className="h-4 w-4 shrink-0 text-amber-500" />
            {adAccountsError
              ? "Failed to load ad accounts. Please try again."
              : "No ad accounts found for this Facebook account. Make sure your Facebook account has an associated Ad Account."}
          </GradientRingCard>
        )}

        {/* Campaigns table */}
        {isLoading ? (
          <div className="flex items-center justify-center py-16 rounded-2xl border border-border/40 bg-card/60 backdrop-blur-md">
            <Loader2 className="h-8 w-8 animate-spin text-rose-500" />
          </div>
        ) : fbAccounts.length === 0 ? (
          <Reveal delay={140}>
            <GradientRingCard variant="rose" hoverLift={false} ringIntensity="subtle">
              <div className="flex flex-col items-center text-center py-6 space-y-3">
                <div className="group"><Icon3D icon={Megaphone} variant="rose" size="lg" /></div>
                <p className="font-medium mt-1">No Facebook accounts connected</p>
                <p className="text-sm text-muted-foreground">Connect a Facebook account to manage ad campaigns.</p>
              </div>
            </GradientRingCard>
          </Reveal>
        ) : (
          <Reveal delay={140}>
          <GradientRingCard variant="rose" padded={false} hoverLift={false} ringIntensity="subtle" innerClassName="overflow-hidden">
            <div className="p-6 pb-3 flex items-center gap-2 text-base font-semibold">
              <Megaphone className="h-4 w-4 text-rose-500" />
              Campaigns ({campaigns.length})
            </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Objective</TableHead>
                    <TableHead className="text-right">Budget</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {campaigns.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground py-10">
                        <div className="group inline-flex mb-3"><Icon3D icon={Megaphone} variant="rose" size="lg" /></div>
                        <p className="font-medium mt-2">No campaigns yet</p>
                        <p className="text-sm mt-1">Create your first campaign above.</p>
                      </TableCell>
                    </TableRow>
                  ) : (
                    campaigns.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell className="font-medium max-w-[200px] truncate">{c.name}</TableCell>
                        <TableCell>
                          <Badge className={c.status === "ACTIVE"
                            ? "bg-gradient-to-r from-emerald-500 to-teal-500 text-white border-0"
                            : "bg-card/60 backdrop-blur border border-border/40 text-muted-foreground"}>
                            {c.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs capitalize">{c.objective?.replace(/_/g, " ").toLowerCase()}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {c.daily_budget ? `$${(parseInt(c.daily_budget) / 100).toFixed(2)}/day` : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            {c.status === "ACTIVE" ? (
                              <Button size="icon" variant="ghost" className="h-8 w-8 text-amber-500 hover:bg-amber-500/10"
                                onClick={() => activeAccountId && updateStatus.mutate({ socialAccountId: activeAccountId, campaignId: c.id, status: "PAUSED" })}>
                                <Pause className="h-4 w-4" />
                              </Button>
                            ) : (
                              <Button size="icon" variant="ghost" className="h-8 w-8 text-emerald-500 hover:bg-emerald-500/10"
                                onClick={() => activeAccountId && updateStatus.mutate({ socialAccountId: activeAccountId, campaignId: c.id, status: "ACTIVE" })}>
                                <Play className="h-4 w-4" />
                              </Button>
                            )}
                            <Button size="icon" variant="ghost" className="h-8 w-8 text-rose-500 hover:bg-rose-500/10"
                              onClick={() => activeAccountId && deleteCampaign.mutate({ socialAccountId: activeAccountId, campaignId: c.id })}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
          </GradientRingCard>
          </Reveal>
        )}
      </div>
    </DashboardLayout>
  );
}
