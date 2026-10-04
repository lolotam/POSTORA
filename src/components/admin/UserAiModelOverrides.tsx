import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, Search, Trash2, Cpu, Calendar, AlertCircle, RefreshCw, Bell, Mail } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { format, isPast, parseISO, differenceInHours } from "date-fns";
import { ScrollArea } from "@/components/ui/scroll-area";

interface UserAiOverride {
  id: string;
  user_id: string;
  provider: string;
  model: string;
  created_at: string;
  expires_at: string | null;
  reason: string | null;
  user_email?: string;
  user_name?: string;
}

interface UserProfile {
  id: string;
  email: string;
  full_name: string | null;
}

interface OpenRouterModel {
  id: string;
  name: string;
  description: string;
  pricing?: {
    prompt: string;
    completion: string;
  };
}

// Google AI Studio models
const GOOGLE_MODELS = [
  { id: "google/gemini-3-pro-preview", name: "Gemini 3 Pro Preview" },
  { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  { id: "google/gemini-3-flash-preview", name: "Gemini 3 Flash Preview" },
  { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash" },
];

export function UserAiModelOverrides() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<"google" | "openrouter">("google");
  const [selectedModel, setSelectedModel] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [reason, setReason] = useState("");
  const [modelSearch, setModelSearch] = useState("");

  // Fetch all user AI overrides
  const { data: overrides = [], isLoading: loadingOverrides } = useQuery({
    queryKey: ["admin-user-ai-model-overrides"],
    queryFn: async (): Promise<UserAiOverride[]> => {
      const { data: overridesData, error } = await supabase
        .from("user_ai_model_overrides")
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
    queryKey: ["admin-users-for-ai-overrides", searchTerm],
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

  // Fetch OpenRouter models
  const { data: openRouterData, isLoading: isLoadingModels, refetch: refetchModels } = useQuery({
    queryKey: ["openrouter-models-for-override"],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("fetch-openrouter-models");
      if (error) throw error;
      return data as { models: OpenRouterModel[]; error?: string };
    },
    enabled: dialogOpen && selectedProvider === "openrouter",
    staleTime: 5 * 60 * 1000,
  });

  const openRouterModels = openRouterData?.models || [];
  const filteredOpenRouterModels = openRouterModels.filter((model) =>
    model.name.toLowerCase().includes(modelSearch.toLowerCase()) ||
    model.id.toLowerCase().includes(modelSearch.toLowerCase())
  );

  // Add override mutation
  const addOverrideMutation = useMutation({
    mutationFn: async () => {
      if (!selectedUserId || !selectedModel) {
        throw new Error("Please select a user and model");
      }

      const { error } = await supabase.from("user_ai_model_overrides").upsert(
        {
          user_id: selectedUserId,
          provider: selectedProvider,
          model: selectedModel,
          expires_at: expiresAt || null,
          reason: reason || null,
        },
        { onConflict: "user_id" }
      );

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-user-ai-model-overrides"] });
      toast({ title: "AI model override added" });
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

  // Delete override mutation
  const deleteOverrideMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("user_ai_model_overrides").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-user-ai-model-overrides"] });
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

  // Send expiry notifications mutation
  const [isSendingNotifications, setIsSendingNotifications] = useState(false);
  const sendExpiryNotifications = async () => {
    setIsSendingNotifications(true);
    try {
      const { data, error } = await supabase.functions.invoke("notify-expiring-ai-overrides");
      if (error) throw error;
      
      if (data.count === 0) {
        toast({
          title: "No expiring overrides",
          description: "There are no AI model overrides expiring in the next 3 days.",
        });
      } else {
        toast({
          title: "Notifications sent",
          description: `Sent expiry notifications for ${data.count} override(s) to ${data.adminNotified} admin(s).`,
        });
      }
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to send notifications",
        variant: "destructive",
      });
    } finally {
      setIsSendingNotifications(false);
    }
  };

  // Count expiring soon overrides
  const expiringSoonCount = overrides.filter((o) => {
    if (!o.expires_at) return false;
    const hoursLeft = differenceInHours(parseISO(o.expires_at), new Date());
    return hoursLeft > 0 && hoursLeft <= 72; // 3 days
  }).length;

  const resetForm = () => {
    setSelectedUserId("");
    setSelectedProvider("google");
    setSelectedModel("");
    setExpiresAt("");
    setReason("");
    setModelSearch("");
  };

  const isExpired = (expiresAt: string | null) => {
    if (!expiresAt) return false;
    return isPast(parseISO(expiresAt));
  };

  const getProviderLabel = (provider: string) => {
    switch (provider) {
      case "google": return "Google AI Studio";
      case "openrouter": return "OpenRouter";
      default: return provider;
    }
  };

  const handleProviderChange = (provider: "google" | "openrouter") => {
    setSelectedProvider(provider);
    setSelectedModel("");
    setModelSearch("");
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 shrink-0 rounded-lg bg-primary/10 flex items-center justify-center">
              <Cpu className="w-5 h-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-lg">User AI Model Overrides</CardTitle>
              <CardDescription>
                Assign specific AI models to individual users
              </CardDescription>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={sendExpiryNotifications}
              disabled={isSendingNotifications}
            >
              {isSendingNotifications ? (
                <Loader2 className="w-4 h-4 me-1 animate-spin" />
              ) : (
                <Mail className="w-4 h-4 me-1" />
              )}
              {expiringSoonCount > 0 && (
                <Badge variant="destructive" className="me-1 px-1 py-0 text-[10px]">
                  {expiringSoonCount}
                </Badge>
              )}
              Notify
            </Button>
            <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}>
              <DialogTrigger asChild>
                <Button size="sm">
                  <Plus className="w-4 h-4 me-2" />
                  Add Override
                </Button>
              </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>Add User AI Model Override</DialogTitle>
                <DialogDescription>
                  Override the global AI model for a specific user
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 pt-4">
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

                {/* Provider Selection */}
                <div className="space-y-2">
                  <label className="text-sm font-medium">AI Provider</label>
                  <Select value={selectedProvider} onValueChange={handleProviderChange}>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose a provider" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="google">Google AI Studio</SelectItem>
                      <SelectItem value="openrouter">OpenRouter</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Model Selection */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium">AI Model</label>
                    {selectedProvider === "openrouter" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => refetchModels()}
                        disabled={isLoadingModels}
                      >
                        {isLoadingModels ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <RefreshCw className="w-4 h-4" />
                        )}
                      </Button>
                    )}
                  </div>
                  
                  {selectedProvider === "google" && (
                    <Select value={selectedModel} onValueChange={setSelectedModel}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select model" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectLabel>Google AI Studio Models</SelectLabel>
                          {GOOGLE_MODELS.map((model) => (
                            <SelectItem key={model.id} value={model.id}>
                              {model.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  )}
                  
                  {selectedProvider === "openrouter" && (
                    <div className="space-y-2">
                      <div className="relative">
                        <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <Input
                          placeholder="Search models..."
                          value={modelSearch}
                          onChange={(e) => setModelSearch(e.target.value)}
                          className="ps-9"
                        />
                      </div>
                      
                      {isLoadingModels ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Loading models...
                        </div>
                      ) : (
                        <Select value={selectedModel} onValueChange={setSelectedModel}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select model" />
                          </SelectTrigger>
                          <SelectContent>
                            <ScrollArea className="h-[200px]">
                              {filteredOpenRouterModels.slice(0, 50).map((model) => (
                                <SelectItem key={model.id} value={model.id}>
                                  <span className="truncate">{model.name}</span>
                                </SelectItem>
                              ))}
                            </ScrollArea>
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                  )}
                </div>

                {/* Reason */}
                <div className="space-y-2">
                  <label className="text-sm font-medium">Reason (Optional)</label>
                  <Input
                    placeholder="e.g., Testing new model, Premium user"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
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

                <Button
                  onClick={() => addOverrideMutation.mutate()}
                  disabled={addOverrideMutation.isPending || !selectedUserId || !selectedModel}
                  className="w-full"
                >
                  {addOverrideMutation.isPending ? (
                    <Loader2 className="w-4 h-4 me-2 animate-spin" />
                  ) : (
                    <Plus className="w-4 h-4 me-2" />
                  )}
                  Add Override
                </Button>
              </div>
            </DialogContent>
            </Dialog>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loadingOverrides ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : overrides.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Cpu className="w-10 h-10 mx-auto mb-2 opacity-50" />
            <p>No user AI model overrides configured.</p>
            <p className="text-sm">All users will use the global AI settings.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {overrides.map((override) => (
              <div
                key={override.id}
                className={`p-3 sm:p-4 rounded-lg border ${isExpired(override.expires_at) ? "opacity-60 bg-muted/50" : "bg-card"}`}
              >
                <div className="flex items-start justify-between gap-3 sm:gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium truncate">
                        {override.user_email}
                      </span>
                      <Badge variant="secondary" className="text-xs">
                        {getProviderLabel(override.provider)}
                      </Badge>
                      {isExpired(override.expires_at) && (
                        <Badge variant="destructive" className="text-xs">
                          <AlertCircle className="w-3 h-3 me-1" />
                          Expired
                        </Badge>
                      )}
                    </div>
                    {override.user_name && (
                      <p className="text-sm text-muted-foreground">{override.user_name}</p>
                    )}
                    <p className="text-sm text-muted-foreground mt-1">
                      Model: <span className="font-mono text-xs">{override.model}</span>
                    </p>
                    {override.reason && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Reason: {override.reason}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs text-muted-foreground">
                      <span>Added: {format(new Date(override.created_at), "MMM d, yyyy")}</span>
                      {override.expires_at && (
                        <span>
                          Expires: {format(new Date(override.expires_at), "MMM d, yyyy HH:mm")}
                        </span>
                      )}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => deleteOverrideMutation.mutate(override.id)}
                    disabled={deleteOverrideMutation.isPending}
                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
