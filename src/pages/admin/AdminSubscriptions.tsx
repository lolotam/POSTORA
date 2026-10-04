import { useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2,
  RefreshCw,
  Search,
  MoreHorizontal,
  DollarSign,
  Users,
  TrendingUp,
  CreditCard,
  Calendar,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Clock,
  ArrowUpRight,
  ArrowDownRight,
  Zap,
  Plus,
  Edit,
  Download,
  ExternalLink,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { format, subDays, startOfMonth, endOfMonth } from "date-fns";

interface UserSubscription {
  id: string;
  user_id: string;
  plan_id: string;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  created_at: string;
  plan?: {
    id: string;
    name: string;
    slug: string;
    price_monthly: number | null;
    price_yearly: number | null;
  };
  profile?: {
    email: string;
    full_name: string | null;
  };
}

interface SubscriptionPlan {
  id: string;
  name: string;
  slug: string;
  price_monthly: number | null;
}

interface UserCredit {
  id: string;
  user_id: string;
  balance: number;
  total_purchased: number;
  total_used: number;
  created_at: string;
  updated_at: string;
  profile?: {
    email: string;
    full_name: string | null;
  };
}

export default function AdminSubscriptions() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const [creditSearchQuery, setCreditSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedSubscription, setSelectedSubscription] = useState<UserSubscription | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [selectedPlanId, setSelectedPlanId] = useState<string>("");
  const [selectedStatus, setSelectedStatus] = useState<string>("");
  
  // Credit management states
  const [selectedCredit, setSelectedCredit] = useState<UserCredit | null>(null);
  const [creditEditDialogOpen, setCreditEditDialogOpen] = useState(false);
  const [creditAddDialogOpen, setCreditAddDialogOpen] = useState(false);
  const [creditAmount, setCreditAmount] = useState<number>(0);
  const [creditUserEmail, setCreditUserEmail] = useState("");
  
  // Backfill subscription states
  const [backfillDialogOpen, setBackfillDialogOpen] = useState(false);
  const [backfillEmail, setBackfillEmail] = useState("");
  const [isBackfilling, setIsBackfilling] = useState(false);

  // Fetch subscriptions
  const { data: subscriptions = [], isLoading, refetch } = useQuery({
    queryKey: ["admin-subscriptions"],
    queryFn: async (): Promise<UserSubscription[]> => {
      const { data: subs, error } = await supabase
        .from("user_subscriptions")
        .select(
          `
          *,
          subscription_plans(id, name, slug, price_monthly, price_yearly)
        `
        )
        .order("created_at", { ascending: false });

      if (error) throw error;

      const userIds = Array.from(new Set((subs || []).map((s: any) => s.user_id)));
      let profilesById = new Map<string, { email: string; full_name: string | null }>();

      if (userIds.length > 0) {
        const { data: profiles, error: profilesError } = await supabase
          .from("profiles")
          .select("id, email, full_name")
          .in("id", userIds);

        if (profilesError) throw profilesError;
        profilesById = new Map(
          (profiles || []).map((p) => [p.id, { email: p.email, full_name: p.full_name }])
        );
      }

      return (subs || []).map((sub: any) => ({
        ...sub,
        plan: sub.subscription_plans,
        profile: profilesById.get(sub.user_id),
      }));
    },
  });

  // Fetch plans for the edit dialog
  const { data: plans = [] } = useQuery({
    queryKey: ["admin-subscription-plans"],
    queryFn: async (): Promise<SubscriptionPlan[]> => {
      const { data, error } = await supabase
        .from("subscription_plans")
        .select("id, name, slug, price_monthly")
        .eq("is_active", true)
        .order("sort_order");

      if (error) throw error;
      return data || [];
    },
  });

  // Fetch user credits
  const { data: userCredits = [], isLoading: isLoadingCredits, refetch: refetchCredits } = useQuery({
    queryKey: ["admin-user-credits"],
    queryFn: async (): Promise<UserCredit[]> => {
      const { data, error } = await supabase
        .from("user_credits")
        .select(`
          *,
          profiles(email, full_name)
        `)
        .order("updated_at", { ascending: false });

      if (error) throw error;

      return (data || []).map((credit: any) => ({
        ...credit,
        profile: credit.profiles,
      }));
    },
  });

  // Update subscription mutation
  const updateSubscriptionMutation = useMutation({
    mutationFn: async ({ id, plan_id, status }: { id: string; plan_id: string; status: string }) => {
      const { error } = await supabase
        .from("user_subscriptions")
        .update({ 
          plan_id, 
          status,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-subscriptions"] });
      toast({ title: "Subscription updated" });
      setEditDialogOpen(false);
    },
    onError: (error) => {
      toast({
        title: "Failed to update",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  // Update user credits mutation
  const updateCreditsMutation = useMutation({
    mutationFn: async ({ userId, amount, description }: { userId: string; amount: number; description: string }) => {
      const { error } = await supabase.rpc("add_user_credits", {
        p_user_id: userId,
        p_amount: amount,
        p_transaction_type: "admin_adjustment",
        p_description: description,
      });

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-user-credits"] });
      toast({ title: "Credits updated" });
      setCreditEditDialogOpen(false);
      setCreditAddDialogOpen(false);
    },
    onError: (error) => {
      toast({
        title: "Failed to update credits",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  // Add credits to a user by email
  const addCreditsByEmailMutation = useMutation({
    mutationFn: async ({ email, amount }: { email: string; amount: number }) => {
      // Find user by email
      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("id")
        .eq("email", email)
        .single();

      if (profileError || !profile) {
        throw new Error("User not found with that email");
      }

      const { error } = await supabase.rpc("add_user_credits", {
        p_user_id: profile.id,
        p_amount: amount,
        p_transaction_type: "admin_grant",
        p_description: `Admin granted ${amount} credits`,
      });

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-user-credits"] });
      toast({ title: "Credits added successfully" });
      setCreditAddDialogOpen(false);
      setCreditUserEmail("");
      setCreditAmount(0);
    },
    onError: (error) => {
      toast({
        title: "Failed to add credits",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  // Backfill subscription from Stripe
  const handleBackfillSubscription = async () => {
    if (!backfillEmail.trim()) {
      toast({ title: "Please enter an email", variant: "destructive" });
      return;
    }

    setIsBackfilling(true);
    try {
      const { data, error } = await supabase.functions.invoke("backfill-subscription", {
        body: { email: backfillEmail.trim() },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      toast({ 
        title: "Subscription backfilled", 
        description: data.message || `Successfully synced subscription for ${backfillEmail}` 
      });
      setBackfillDialogOpen(false);
      setBackfillEmail("");
      refetch();
    } catch (error) {
      toast({
        title: "Backfill failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsBackfilling(false);
    }
  };

  // Open Stripe Customer Portal for a subscriber
  const [portalLoadingId, setPortalLoadingId] = useState<string | null>(null);

  const handleOpenPortal = async (stripeCustomerId: string, subscriptionId: string) => {
    setPortalLoadingId(subscriptionId);
    try {
      const { data, error } = await supabase.functions.invoke("stripe-manage-subscription", {
        body: {
          action: "portal",
          customer_id: stripeCustomerId,
        },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      if (data?.url) {
        window.open(data.url, "_blank");
      }
    } catch (error) {
      toast({
        title: "Failed to open portal",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setPortalLoadingId(null);
    }
  };

  // Calculate metrics
  const activeSubscriptions = subscriptions.filter((s) => s.status === "active" && !s.cancel_at_period_end);
  const cancellingSubscriptions = subscriptions.filter((s) => s.cancel_at_period_end);
  const cancelledSubscriptions = subscriptions.filter((s) => s.status === "cancelled");
  const pastDueSubscriptions = subscriptions.filter((s) => s.status === "past_due");

  // Calculate MRR (Monthly Recurring Revenue)
  const mrr = activeSubscriptions.reduce((total, sub) => {
    return total + (sub.plan?.price_monthly || 0);
  }, 0);

  // Subscriptions created this month
  const thisMonthStart = startOfMonth(new Date());
  const thisMonthEnd = endOfMonth(new Date());
  const newThisMonth = subscriptions.filter(
    (s) => new Date(s.created_at) >= thisMonthStart && new Date(s.created_at) <= thisMonthEnd
  );

  // Filter subscriptions
  const filteredSubscriptions = subscriptions.filter((sub) => {
    const matchesSearch =
      searchQuery === "" ||
      sub.profile?.email?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      sub.profile?.full_name?.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesStatus =
      statusFilter === "all" ||
      (statusFilter === "cancelling" && sub.cancel_at_period_end) ||
      (statusFilter !== "cancelling" && sub.status === statusFilter);

    return matchesSearch && matchesStatus;
  });

  // Filter credits
  const filteredCredits = userCredits.filter((credit) => {
    return (
      creditSearchQuery === "" ||
      credit.profile?.email?.toLowerCase().includes(creditSearchQuery.toLowerCase()) ||
      credit.profile?.full_name?.toLowerCase().includes(creditSearchQuery.toLowerCase())
    );
  });

  // Credit metrics
  const totalCreditsBalance = userCredits.reduce((sum, c) => sum + c.balance, 0);
  const totalCreditsPurchased = userCredits.reduce((sum, c) => sum + c.total_purchased, 0);
  const totalCreditsUsed = userCredits.reduce((sum, c) => sum + c.total_used, 0);

  const getStatusBadge = (status: string, cancelAtPeriodEnd: boolean) => {
    if (cancelAtPeriodEnd) {
      return (
        <Badge variant="outline" className="text-amber-600 border-amber-500/30 gap-1">
          <Clock className="w-3 h-3" />
          Cancelling
        </Badge>
      );
    }
    switch (status) {
      case "active":
        return (
          <Badge className="bg-green-500/10 text-green-600 border-green-500/30 gap-1">
            <CheckCircle className="w-3 h-3" />
            Active
          </Badge>
        );
      case "cancelled":
        return (
          <Badge variant="destructive" className="gap-1">
            <XCircle className="w-3 h-3" />
            Cancelled
          </Badge>
        );
      case "past_due":
        return (
          <Badge variant="destructive" className="gap-1">
            <AlertTriangle className="w-3 h-3" />
            Past Due
          </Badge>
        );
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const openEditDialog = (subscription: UserSubscription) => {
    setSelectedSubscription(subscription);
    setSelectedPlanId(subscription.plan_id);
    setSelectedStatus(subscription.status);
    setEditDialogOpen(true);
  };

  const handleUpdateSubscription = () => {
    if (!selectedSubscription) return;
    updateSubscriptionMutation.mutate({
      id: selectedSubscription.id,
      plan_id: selectedPlanId,
      status: selectedStatus,
    });
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold">Subscriptions & Credits</h2>
            <p className="text-muted-foreground">Manage subscriptions, credits, and view revenue metrics</p>
          </div>
        </div>

        <Tabs defaultValue="subscriptions" className="space-y-6">
          <TabsList>
            <TabsTrigger value="subscriptions" className="gap-2">
              <CreditCard className="w-4 h-4" />
              Subscriptions
            </TabsTrigger>
            <TabsTrigger value="credits" className="gap-2">
              <Zap className="w-4 h-4" />
              AI Credits
            </TabsTrigger>
          </TabsList>

          {/* Subscriptions Tab */}
          <TabsContent value="subscriptions" className="space-y-6">
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => setBackfillDialogOpen(true)}>
                <Download className="w-4 h-4 me-2" />
                Backfill from Stripe
              </Button>
              <Button variant="outline" onClick={() => refetch()}>
                <RefreshCw className="w-4 h-4 me-2" />
                Refresh
              </Button>
            </div>

            {/* Revenue Metrics */}
            <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Monthly Revenue (MRR)
                  </CardTitle>
                  <DollarSign className="w-4 h-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">${mrr.toFixed(2)}</div>
                  <p className="text-xs text-muted-foreground">
                    From {activeSubscriptions.length} active subscriptions
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Active Subscribers
                  </CardTitle>
                  <Users className="w-4 h-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{activeSubscriptions.length}</div>
                  <div className="flex items-center text-xs">
                    {cancellingSubscriptions.length > 0 && (
                      <span className="text-amber-600">
                        {cancellingSubscriptions.length} cancelling
                      </span>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    New This Month
                  </CardTitle>
                  <TrendingUp className="w-4 h-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{newThisMonth.length}</div>
                  <div className="flex items-center text-xs text-green-600">
                    <ArrowUpRight className="w-3 h-3 me-1" />
                    New subscriptions
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Churn Risk
                  </CardTitle>
                  <AlertTriangle className="w-4 h-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {cancellingSubscriptions.length + pastDueSubscriptions.length}
                  </div>
                  <div className="flex items-center text-xs text-destructive">
                    {pastDueSubscriptions.length > 0 && (
                      <span>{pastDueSubscriptions.length} past due</span>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Subscriptions Table */}
            <Card>
              <CardHeader>
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                  <div>
                    <CardTitle>All Subscriptions</CardTitle>
                    <CardDescription>
                      {filteredSubscriptions.length} of {subscriptions.length} subscriptions
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="relative min-w-0 flex-1 sm:flex-none">
                      <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input
                        placeholder="Search by email or name..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="ps-9 w-full sm:w-64"
                      />
                    </div>
                    <Select value={statusFilter} onValueChange={setStatusFilter}>
                      <SelectTrigger className="w-36">
                        <SelectValue placeholder="Status" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Status</SelectItem>
                        <SelectItem value="active">Active</SelectItem>
                        <SelectItem value="cancelling">Cancelling</SelectItem>
                        <SelectItem value="cancelled">Cancelled</SelectItem>
                        <SelectItem value="past_due">Past Due</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                  </div>
                ) : filteredSubscriptions.length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground">
                    {searchQuery || statusFilter !== "all"
                      ? "No subscriptions match your filters"
                      : "No subscriptions yet"}
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>User</TableHead>
                        <TableHead>Plan</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Revenue</TableHead>
                        <TableHead>Period End</TableHead>
                        <TableHead>Created</TableHead>
                        <TableHead className="w-12"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredSubscriptions.map((sub) => (
                        <TableRow key={sub.id}>
                          <TableCell>
                            <div>
                              <p className="font-medium">{sub.profile?.full_name || "No name"}</p>
                              <p className="text-sm text-muted-foreground">{sub.profile?.email}</p>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{sub.plan?.name || "Unknown"}</Badge>
                          </TableCell>
                          <TableCell>
                            {getStatusBadge(sub.status, sub.cancel_at_period_end)}
                          </TableCell>
                          <TableCell>
                            <span className="font-medium">
                              ${(sub.plan?.price_monthly || 0).toFixed(2)}
                            </span>
                            <span className="text-muted-foreground">/mo</span>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {sub.current_period_end
                              ? format(new Date(sub.current_period_end), "MMM d, yyyy")
                              : "—"}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {format(new Date(sub.created_at), "MMM d, yyyy")}
                          </TableCell>
                          <TableCell>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon">
                                  <MoreHorizontal className="w-4 h-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuLabel>Actions</DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => openEditDialog(sub)}>
                                  Edit Subscription
                                </DropdownMenuItem>
                                {sub.stripe_customer_id && (
                                  <>
                                    <DropdownMenuItem
                                      onClick={() => handleOpenPortal(sub.stripe_customer_id!, sub.id)}
                                      disabled={portalLoadingId === sub.id}
                                    >
                                      <ExternalLink className="w-4 h-4 me-2" />
                                      {portalLoadingId === sub.id ? "Opening..." : "Manage in Portal"}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onClick={() =>
                                        window.open(
                                          `https://dashboard.stripe.com/customers/${sub.stripe_customer_id}`,
                                          "_blank"
                                        )
                                      }
                                    >
                                      View in Stripe Dashboard
                                    </DropdownMenuItem>
                                  </>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* AI Credits Tab */}
          <TabsContent value="credits" className="space-y-6">
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => setCreditAddDialogOpen(true)}>
                <Plus className="w-4 h-4 me-2" />
                Add Credits
              </Button>
              <Button variant="outline" onClick={() => refetchCredits()}>
                <RefreshCw className="w-4 h-4 me-2" />
                Refresh
              </Button>
            </div>

            {/* Credit Metrics */}
            <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Users with Credits
                  </CardTitle>
                  <Users className="w-4 h-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{userCredits.length}</div>
                  <p className="text-xs text-muted-foreground">
                    Active credit holders
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Total Balance
                  </CardTitle>
                  <Zap className="w-4 h-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{totalCreditsBalance.toLocaleString()}</div>
                  <p className="text-xs text-muted-foreground">
                    Credits available
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Total Purchased
                  </CardTitle>
                  <DollarSign className="w-4 h-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{totalCreditsPurchased.toLocaleString()}</div>
                  <p className="text-xs text-green-600">
                    <ArrowUpRight className="w-3 h-3 inline me-1" />
                    All time
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Total Used
                  </CardTitle>
                  <TrendingUp className="w-4 h-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{totalCreditsUsed.toLocaleString()}</div>
                  <p className="text-xs text-muted-foreground">
                    Credits consumed
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* Credits Table */}
            <Card>
              <CardHeader>
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                  <div>
                    <CardTitle>User Credits</CardTitle>
                    <CardDescription>
                      {filteredCredits.length} of {userCredits.length} users with credits
                    </CardDescription>
                  </div>
                  <div className="relative">
                    <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      placeholder="Search by email or name..."
                      value={creditSearchQuery}
                      onChange={(e) => setCreditSearchQuery(e.target.value)}
                      className="ps-9 w-full sm:w-64"
                    />
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {isLoadingCredits ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                  </div>
                ) : filteredCredits.length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground">
                    {creditSearchQuery
                      ? "No users match your search"
                      : "No users have purchased credits yet"}
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>User</TableHead>
                        <TableHead>Balance</TableHead>
                        <TableHead>Purchased</TableHead>
                        <TableHead>Used</TableHead>
                        <TableHead>Last Updated</TableHead>
                        <TableHead className="w-12"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredCredits.map((credit) => (
                        <TableRow key={credit.id}>
                          <TableCell>
                            <div>
                              <p className="font-medium">{credit.profile?.full_name || "No name"}</p>
                              <p className="text-sm text-muted-foreground">{credit.profile?.email}</p>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge className={credit.balance > 0 ? "bg-green-500/10 text-green-600" : "bg-muted"}>
                              <Zap className="w-3 h-3 me-1" />
                              {credit.balance.toLocaleString()}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-green-600 font-medium">
                            +{credit.total_purchased.toLocaleString()}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            -{credit.total_used.toLocaleString()}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {format(new Date(credit.updated_at), "MMM d, yyyy")}
                          </TableCell>
                          <TableCell>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon">
                                  <MoreHorizontal className="w-4 h-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuLabel>Actions</DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => {
                                  setSelectedCredit(credit);
                                  setCreditAmount(0);
                                  setCreditEditDialogOpen(true);
                                }}>
                                  <Edit className="w-4 h-4 me-2" />
                                  Adjust Credits
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* Edit Subscription Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Subscription</DialogTitle>
            <DialogDescription>
              Update subscription details for {selectedSubscription?.profile?.email}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Plan</Label>
              <Select value={selectedPlanId} onValueChange={setSelectedPlanId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select plan" />
                </SelectTrigger>
                <SelectContent>
                  {plans.map((plan) => (
                    <SelectItem key={plan.id} value={plan.id}>
                      {plan.name} - ${plan.price_monthly?.toFixed(2)}/mo
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={selectedStatus} onValueChange={setSelectedStatus}>
                <SelectTrigger>
                  <SelectValue placeholder="Select status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                  <SelectItem value="past_due">Past Due</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleUpdateSubscription}
              disabled={updateSubscriptionMutation.isPending}
            >
              {updateSubscriptionMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 me-2 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save Changes"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Adjust Credits Dialog */}
      <Dialog open={creditEditDialogOpen} onOpenChange={setCreditEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adjust User Credits</DialogTitle>
            <DialogDescription>
              Adjust credits for {selectedCredit?.profile?.email}
              <br />
              <span className="text-sm">Current balance: {selectedCredit?.balance.toLocaleString()} credits</span>
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Credits to Add/Remove</Label>
              <Input
                type="number"
                value={creditAmount}
                onChange={(e) => setCreditAmount(parseInt(e.target.value) || 0)}
                placeholder="Enter amount (use negative to deduct)"
              />
              <p className="text-xs text-muted-foreground">
                Use positive numbers to add, negative to deduct
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreditEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (selectedCredit && creditAmount !== 0) {
                  updateCreditsMutation.mutate({
                    userId: selectedCredit.user_id,
                    amount: creditAmount,
                    description: `Admin adjustment: ${creditAmount > 0 ? '+' : ''}${creditAmount} credits`,
                  });
                }
              }}
              disabled={updateCreditsMutation.isPending || creditAmount === 0}
            >
              {updateCreditsMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 me-2 animate-spin" />
                  Saving...
                </>
              ) : (
                "Apply Changes"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Credits Dialog */}
      <Dialog open={creditAddDialogOpen} onOpenChange={setCreditAddDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Credits to User</DialogTitle>
            <DialogDescription>
              Grant AI credits to a user by their email address
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>User Email</Label>
              <Input
                type="email"
                value={creditUserEmail}
                onChange={(e) => setCreditUserEmail(e.target.value)}
                placeholder="user@example.com"
              />
            </div>
            <div className="space-y-2">
              <Label>Credits to Add</Label>
              <Input
                type="number"
                value={creditAmount}
                onChange={(e) => setCreditAmount(parseInt(e.target.value) || 0)}
                placeholder="Enter amount"
                min={1}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreditAddDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (creditUserEmail && creditAmount > 0) {
                  addCreditsByEmailMutation.mutate({
                    email: creditUserEmail,
                    amount: creditAmount,
                  });
                }
              }}
              disabled={addCreditsByEmailMutation.isPending || !creditUserEmail || creditAmount <= 0}
            >
              {addCreditsByEmailMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 me-2 animate-spin" />
                  Adding...
                </>
              ) : (
                <>
                  <Plus className="w-4 h-4 me-2" />
                  Add Credits
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Backfill Subscription Dialog */}
      <Dialog open={backfillDialogOpen} onOpenChange={setBackfillDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Backfill Subscription from Stripe</DialogTitle>
            <DialogDescription>
              Sync a user's active Stripe subscription to the database. This will update their subscription record, role, and quotas.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>User Email</Label>
              <Input
                type="email"
                value={backfillEmail}
                onChange={(e) => setBackfillEmail(e.target.value)}
                placeholder="user@example.com"
              />
              <p className="text-xs text-muted-foreground">
                The email must match both the Supabase profile and Stripe customer.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setBackfillDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleBackfillSubscription}
              disabled={isBackfilling || !backfillEmail.trim()}
            >
              {isBackfilling ? (
                <>
                  <Loader2 className="w-4 h-4 me-2 animate-spin" />
                  Syncing...
                </>
              ) : (
                <>
                  <Download className="w-4 h-4 me-2" />
                  Backfill Subscription
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
