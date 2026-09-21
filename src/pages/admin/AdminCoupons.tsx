import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, Plus, Trash2, Pencil, Copy } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";

interface Coupon {
  id: string;
  code: string;
  discount_type: string;
  discount_amount: number;
  valid_from: string;
  expires_at: string | null;
  max_redemptions: number | null;
  total_redemptions: number;
  is_active: boolean;
  created_at: string;
  description: string | null;
}

export default function AdminCoupons() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newCoupon, setNewCoupon] = useState({
    code: "",
    discount_percent: "",
    discount_amount: "",
    valid_from: "",
    valid_until: "",
    max_uses: "",
    is_active: true,
  });

  const { data: coupons = [], isLoading } = useQuery({
    queryKey: ["admin-coupons"],
    queryFn: async (): Promise<Coupon[]> => {
      const { data, error } = await supabase
        .from("coupons")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) throw error;
      return data || [];
    },
  });

  const createCouponMutation = useMutation({
    mutationFn: async (coupon: { code: string; discount_type: string; discount_amount: number; valid_from?: string | null; expires_at?: string | null; max_redemptions?: number | null; is_active?: boolean }) => {
      const { data, error } = await supabase
        .from("coupons")
        .insert([coupon])
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-coupons"] });
      toast({ title: "Coupon created" });
      setIsCreateOpen(false);
      setNewCoupon({
        code: "",
        discount_percent: "",
        discount_amount: "",
        valid_from: "",
        valid_until: "",
        max_uses: "",
        is_active: true,
      });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to create coupon",
        variant: "destructive",
      });
    },
  });

  const toggleActiveMutation = useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      const { error } = await supabase
        .from("coupons")
        .update({ is_active })
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-coupons"] });
    },
  });

  const deleteCouponMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("coupons").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-coupons"] });
      toast({ title: "Coupon deleted" });
    },
  });

  const handleCreateCoupon = () => {
    const discountType = newCoupon.discount_percent ? "percentage" : "fixed";
    const discountAmount = newCoupon.discount_percent
      ? parseFloat(newCoupon.discount_percent)
      : newCoupon.discount_amount
      ? parseFloat(newCoupon.discount_amount)
      : 0;
    createCouponMutation.mutate({
      code: newCoupon.code.toUpperCase(),
      discount_type: discountType,
      discount_amount: discountAmount,
      valid_from: newCoupon.valid_from || undefined,
      expires_at: newCoupon.valid_until || undefined,
      max_redemptions: newCoupon.max_uses ? parseInt(newCoupon.max_uses) : undefined,
      is_active: newCoupon.is_active,
    });
  };

  const handleCopyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    toast({ title: "Copied!", description: `Code ${code} copied to clipboard.` });
  };

  const getDiscountDisplay = (coupon: Coupon) => {
    if (coupon.discount_type === "percentage") return `${coupon.discount_amount}% off`;
    return `$${coupon.discount_amount.toFixed(2)} off`;
  };

  const isExpired = (coupon: Coupon) => {
    if (!coupon.expires_at) return false;
    return new Date(coupon.expires_at) < new Date();
  };

  const isMaxedOut = (coupon: Coupon) => {
    if (!coupon.max_redemptions) return false;
    return coupon.total_redemptions >= coupon.max_redemptions;
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold">Coupons</h2>
            <p className="text-muted-foreground">Create and manage discount coupons</p>
          </div>
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="w-4 h-4 me-2" />
                Create Coupon
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create Coupon</DialogTitle>
                <DialogDescription>Add a new discount coupon</DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label>Coupon Code</Label>
                  <Input
                    value={newCoupon.code}
                    onChange={(e) => setNewCoupon({ ...newCoupon, code: e.target.value.toUpperCase() })}
                    placeholder="SUMMER2024"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Discount %</Label>
                    <Input
                      type="number"
                      value={newCoupon.discount_percent}
                      onChange={(e) => setNewCoupon({ ...newCoupon, discount_percent: e.target.value, discount_amount: "" })}
                      placeholder="20"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Or Fixed Amount ($)</Label>
                    <Input
                      type="number"
                      value={newCoupon.discount_amount}
                      onChange={(e) => setNewCoupon({ ...newCoupon, discount_amount: e.target.value, discount_percent: "" })}
                      placeholder="10.00"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Valid From</Label>
                    <Input
                      type="date"
                      value={newCoupon.valid_from}
                      onChange={(e) => setNewCoupon({ ...newCoupon, valid_from: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Valid Until</Label>
                    <Input
                      type="date"
                      value={newCoupon.valid_until}
                      onChange={(e) => setNewCoupon({ ...newCoupon, valid_until: e.target.value })}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Max Uses (leave empty for unlimited)</Label>
                  <Input
                    type="number"
                    value={newCoupon.max_uses}
                    onChange={(e) => setNewCoupon({ ...newCoupon, max_uses: e.target.value })}
                    placeholder="100"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={newCoupon.is_active}
                    onCheckedChange={(checked) => setNewCoupon({ ...newCoupon, is_active: checked })}
                  />
                  <Label>Active</Label>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setIsCreateOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleCreateCoupon} disabled={createCouponMutation.isPending || !newCoupon.code}>
                  {createCouponMutation.isPending && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
                  Create
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        {/* Coupons Table */}
        <Card>
          <CardHeader>
            <CardTitle>All Coupons</CardTitle>
            <CardDescription>{coupons.length} coupons</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
              </div>
            ) : coupons.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                No coupons yet. Create your first coupon!
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Discount</TableHead>
                    <TableHead>Usage</TableHead>
                    <TableHead>Validity</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-[100px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {coupons.map((coupon) => (
                    <TableRow key={coupon.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <code className="bg-muted px-2 py-1 rounded font-mono text-sm">
                            {coupon.code}
                          </code>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            onClick={() => handleCopyCode(coupon.code)}
                          >
                            <Copy className="w-3 h-3" />
                          </Button>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{getDiscountDisplay(coupon)}</Badge>
                      </TableCell>
                      <TableCell>
                        {coupon.total_redemptions}
                        {coupon.max_redemptions ? ` / ${coupon.max_redemptions}` : " uses"}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {coupon.valid_from && coupon.expires_at
                          ? `${format(new Date(coupon.valid_from), "MMM d")} - ${format(new Date(coupon.expires_at), "MMM d, yyyy")}`
                          : coupon.expires_at
                          ? `Until ${format(new Date(coupon.expires_at), "MMM d, yyyy")}`
                          : "No expiry"}
                      </TableCell>
                      <TableCell>
                        {isExpired(coupon) ? (
                          <Badge variant="destructive">Expired</Badge>
                        ) : isMaxedOut(coupon) ? (
                          <Badge variant="secondary">Maxed Out</Badge>
                        ) : coupon.is_active ? (
                          <Badge className="bg-green-500/10 text-green-600 border-green-500/30">Active</Badge>
                        ) : (
                          <Badge variant="secondary">Inactive</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Switch
                            checked={coupon.is_active}
                            onCheckedChange={(checked) =>
                              toggleActiveMutation.mutate({ id: coupon.id, is_active: checked })
                            }
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive"
                            onClick={() => deleteCouponMutation.mutate(coupon.id)}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </AdminLayout>
  );
}
