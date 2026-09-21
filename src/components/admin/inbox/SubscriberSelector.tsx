import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { Users, Search, UserCheck, Loader2, Crown, User } from "lucide-react";
import { cn } from "@/lib/utils";

interface UserProfile {
  id: string;
  email: string;
  full_name: string | null;
  status?: string;
  plan_name?: string;
}

interface SubscriberSelectorProps {
  selectedEmails: string[];
  onSelectEmails: (emails: string[]) => void;
}

export function SubscriberSelector({
  selectedEmails,
  onSelectEmails,
}: SubscriberSelectorProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [localSelected, setLocalSelected] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<"subscribers" | "users">("subscribers");

  // Fetch all users (profiles)
  const { data: allUsers = [], isLoading: isLoadingUsers } = useQuery({
    queryKey: ["all-users-for-email"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, email, full_name")
        .order("email");

      if (error) throw error;

      return (data || []).map((profile) => ({
        id: profile.id,
        email: profile.email,
        full_name: profile.full_name,
      })) as UserProfile[];
    },
    enabled: open,
  });

  // Fetch subscribers with paid subscriptions only
  const { data: subscribers = [], isLoading: isLoadingSubscribers } = useQuery({
    queryKey: ["paid-subscribers-for-email"],
    queryFn: async () => {
      const { data: subs, error } = await supabase
        .from("user_subscriptions")
        .select(
          `
          user_id,
          status,
          subscription_plans(id, name, slug)
        `
        )
        .order("created_at", { ascending: false });

      if (error) throw error;

      const paidSubs = (subs || []).filter(
        (s: any) => s.subscription_plans?.slug && s.subscription_plans.slug !== "free"
      );

      const userIds = Array.from(new Set(paidSubs.map((s: any) => s.user_id)));
      if (userIds.length === 0) return [] as UserProfile[];

      const { data: profiles, error: profilesError } = await supabase
        .from("profiles")
        .select("id, email, full_name")
        .in("id", userIds);

      if (profilesError) throw profilesError;

      const profileById = new Map<string, { email: string; full_name: string | null }>(
        (profiles || []).map((p) => [p.id, { email: p.email, full_name: p.full_name }])
      );

      // Transform and dedupe by email (user might have multiple subscriptions)
      const seen = new Set<string>();
      const result: UserProfile[] = [];

      for (const sub of paidSubs) {
        const profile = profileById.get(sub.user_id);
        const plan = sub.subscription_plans as any;

        if (profile?.email && !seen.has(profile.email)) {
          seen.add(profile.email);
          result.push({
            id: sub.user_id,
            email: profile.email,
            full_name: profile.full_name,
            status: sub.status,
            plan_name: plan?.name,
          });
        }
      }

      result.sort((a, b) => a.email.localeCompare(b.email));
      return result;
    },
    enabled: open,
  });

  const isLoading = activeTab === "subscribers" ? isLoadingSubscribers : isLoadingUsers;
  const currentList = activeTab === "subscribers" ? subscribers : allUsers;

  // Filter by search
  const filteredList = currentList.filter(
    (user) =>
      user.email.toLowerCase().includes(search.toLowerCase()) ||
      user.full_name?.toLowerCase().includes(search.toLowerCase())
  );

  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen);
    if (isOpen) {
      setLocalSelected(selectedEmails);
      setSearch("");
    }
  };

  const toggleEmail = (email: string) => {
    setLocalSelected((prev) =>
      prev.includes(email) ? prev.filter((e) => e !== email) : [...prev, email]
    );
  };

  const selectAll = () => {
    const allEmails = filteredList.map((user) => user.email);
    setLocalSelected((prev) => [...new Set([...prev, ...allEmails])]);
  };

  const clearAll = () => {
    setLocalSelected([]);
  };

  const handleConfirm = () => {
    // Merge with existing and dedupe
    const merged = [...new Set([...selectedEmails, ...localSelected])];
    onSelectEmails(merged);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Users className="h-4 w-4" />
          Recipients
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Select Recipients
          </DialogTitle>
        </DialogHeader>

        {/* Category Tabs */}
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "subscribers" | "users")}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="subscribers" className="gap-2">
              <Crown className="h-4 w-4" />
              Subscribers ({subscribers.length})
            </TabsTrigger>
            <TabsTrigger value="users" className="gap-2">
              <User className="h-4 w-4" />
              All Users ({allUsers.length})
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Search */}
        <div className="relative">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={activeTab === "subscribers" ? "Search subscribers..." : "Search users..."}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="ps-9"
          />
        </div>

        {/* Quick actions */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={selectAll}
              disabled={filteredList.length === 0}
            >
              <UserCheck className="h-4 w-4 me-1" />
              Select All ({filteredList.length})
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={clearAll}
              disabled={localSelected.length === 0}
            >
              Clear
            </Button>
          </div>
          <Badge variant="secondary">
            {localSelected.length} selected
          </Badge>
        </div>

        {/* User list */}
        <ScrollArea className="h-[300px] border rounded-lg">
          {isLoading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : filteredList.length === 0 ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              {search 
                ? `No ${activeTab === "subscribers" ? "subscribers" : "users"} found` 
                : `No ${activeTab === "subscribers" ? "subscribers" : "users"} yet`
              }
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {filteredList.map((user) => (
                <label
                  key={user.id}
                  className={cn(
                    "flex items-center gap-3 p-2 rounded-lg cursor-pointer hover:bg-muted/50 transition-colors",
                    localSelected.includes(user.email) && "bg-primary/10"
                  )}
                >
                  <Checkbox
                    checked={localSelected.includes(user.email)}
                    onCheckedChange={() => toggleEmail(user.email)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">
                        {user.full_name || user.email}
                      </span>
                      {activeTab === "subscribers" && user.status === "active" && (
                        <Badge variant="default" className="text-xs h-5">
                          Active
                        </Badge>
                      )}
                      {activeTab === "subscribers" && user.status === "canceled" && (
                        <Badge variant="secondary" className="text-xs h-5">
                          Canceled
                        </Badge>
                      )}
                    </div>
                    <div className="text-sm text-muted-foreground truncate">
                      {user.email}
                      {user.plan_name && (
                        <span className="ms-2 text-xs">• {user.plan_name}</span>
                      )}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          )}
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={localSelected.length === 0}>
            Add {localSelected.length} Recipient{localSelected.length !== 1 ? "s" : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
