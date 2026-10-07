import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle2, LogOut, Music, Shield, Video, User, ExternalLink } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

export default function TikTokAuth() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  

  // Fetch connected TikTok accounts
  const { data: tiktokAccounts, isLoading } = useQuery({
    queryKey: ["tiktok-demo-accounts", user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("social_accounts")
        .select("*")
        .eq("user_id", user!.id)
        .eq("platform", "tiktok")
        .eq("is_active", true);
      if (error) throw error;
      return data;
    },
    enabled: !!user?.id,
  });

  // Handle OAuth callback code in URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    if (code && !isConnecting) {
      handleCallback(code);
      window.history.replaceState({}, "", "/tiktok-auth");
    }
  }, []);

  const handleConnect = async () => {
    setIsConnecting(true);
    try {
      const redirectUri = "https://postora.cloud/tiktok-callback";
      const { data, error } = await supabase.functions.invoke("tiktok-oauth", {
        body: { action: "authorize", redirect_uri: redirectUri },
      });
      if (error) throw error;
      if (data?.url) {
        sessionStorage.setItem("tiktok_demo_return", "true");
        window.location.href = data.url;
      } else {
        throw new Error("No authorization URL received");
      }
    } catch (error) {
      toast({
        title: "Connection failed",
        description: error instanceof Error ? error.message : "Failed to start TikTok OAuth",
        variant: "destructive",
      });
      setIsConnecting(false);
    }
  };

  const handleCallback = async (code: string) => {
    setIsConnecting(true);
    try {
      const redirectUri = "https://postora.cloud/tiktok-callback";
      const { data, error } = await supabase.functions.invoke("tiktok-oauth", {
        body: {
          action: "callback",
          code,
          redirect_uri: redirectUri,
          user_id: user?.id,
        },
      });
      if (error) throw error;
      if (data?.success) {
        toast({ title: "TikTok connected!", description: "Your TikTok account has been connected successfully." });
        queryClient.invalidateQueries({ queryKey: ["tiktok-demo-accounts"] });
      } else {
        throw new Error(data?.error || "Failed to complete TikTok connection");
      }
    } catch (error) {
      toast({
        title: "Connection failed",
        description: error instanceof Error ? error.message : "Failed to connect TikTok",
        variant: "destructive",
      });
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async (accountId: string) => {
    setIsDisconnecting(true);
    try {
      const { error } = await supabase
        .from("social_accounts")
        .update({ is_active: false })
        .eq("id", accountId);
      if (error) throw error;
      toast({ title: "Disconnected", description: "TikTok account has been disconnected." });
      queryClient.invalidateQueries({ queryKey: ["tiktok-demo-accounts"] });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to disconnect account",
        variant: "destructive",
      });
    } finally {
      setIsDisconnecting(false);
    }
  };

  const connectedAccount = tiktokAccounts?.[0];

  const PERMISSIONS = [
    { icon: User, label: "Access your TikTok profile", description: "Read your display name, avatar, and account info" },
    { icon: Video, label: "Upload videos on your behalf", description: "Publish and schedule video content to your TikTok" },
    { icon: Shield, label: "Read your video list", description: "View your published videos and their status" },
  ];

  return (
    <DashboardLayout noPadding hideFooter>
      <div className="flex-1 bg-background">
        {/* Top Navigation Bar */}
        <header className="border-b border-border px-6 py-4">
          <div className="w-full flex items-center justify-center">
            <nav className="flex gap-4">
              <Link
                to="/tiktok-auth"
                className="text-sm font-medium text-foreground border-b-2 border-foreground pb-1"
              >
                Connect to TikTok
              </Link>
              <Link
                to="/tiktok-publish"
                className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                TikTok Management
              </Link>
            </nav>
          </div>
        </header>

        {/* Main Content */}
        <section className="w-full px-6 py-16">
          <div className="text-center mb-10">
            <h2 className="text-2xl font-bold text-foreground mb-2">
              Connect Your TikTok Account
            </h2>
            <p className="text-muted-foreground text-sm">
              Authenticate with TikTok to publish videos directly from Postora.
            </p>
          </div>

          {isLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
              {/* Left Column: Connect / Disconnect */}
              <div>
                {connectedAccount ? (
                  <div className="rounded-xl border border-border bg-card p-6 space-y-6">
                    <div className="flex items-center gap-4">
                      <div className="w-14 h-14 rounded-full bg-secondary flex items-center justify-center overflow-hidden">
                        {connectedAccount.avatar_url ? (
                          <img
                            src={connectedAccount.avatar_url}
                            alt={connectedAccount.platform_username || "TikTok"}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <Music className="w-6 h-6 text-muted-foreground" />
                        )}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-foreground">
                            @{connectedAccount.platform_username || "Unknown"}
                          </span>
                          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          ID: {connectedAccount.platform_user_id}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Connected {new Date(connectedAccount.connected_at || "").toLocaleDateString()}
                        </p>
                      </div>
                    </div>

                    <button
                      onClick={() => handleDisconnect(connectedAccount.id)}
                      disabled={isDisconnecting}
                      className="flex items-center justify-center gap-2 w-full h-12 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isDisconnecting ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <LogOut className="w-4 h-4" />
                      )}
                      Disconnect TikTok
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-6">
                    <button
                      onClick={handleConnect}
                      disabled={isConnecting}
                      className="flex items-center justify-center gap-3 w-full max-w-sm h-12 rounded-md bg-black text-white font-medium text-base hover:bg-black/85 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isConnecting ? (
                        <Loader2 className="w-5 h-5 animate-spin" />
                      ) : (
                        <>
                          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M16.5 4.5C15.12 3.75 14.22 2.3 14.08 0.67C14.07 0.55 14.06 0.43 14.06 0.31V0H10.56V13.25C10.56 14.79 9.31 16.06 7.78 16.06C6.25 16.06 5 14.79 5 13.25C5 11.71 6.25 10.44 7.78 10.44C8.07 10.44 8.35 10.48 8.61 10.56V7C8.34 6.96 8.06 6.94 7.78 6.94C4.33 6.94 1.5 9.77 1.5 13.22C1.5 16.67 4.33 19.5 7.78 19.5C11.23 19.5 14.06 16.67 14.06 13.22V6.56C15.28 7.5 16.79 8.06 18.44 8.06V4.56C17.76 4.56 17.11 4.41 16.5 4.14V4.5Z" fill="currentColor"/>
                          </svg>
                          Continue with TikTok
                        </>
                      )}
                    </button>

                    <p className="text-xs text-muted-foreground text-center max-w-sm">
                      By continuing, you agree to TikTok's{" "}
                      <a href="https://www.tiktok.com/legal/terms-of-service" target="_blank" rel="noopener noreferrer" className="underline">
                        Terms of Service
                      </a>{" "}
                      and acknowledge that you have read TikTok's{" "}
                      <a href="https://www.tiktok.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer" className="underline">
                        Privacy Policy
                      </a>.
                    </p>
                  </div>
                )}
              </div>

              {/* Right Column: Permissions / Status Info */}
              <div className="rounded-xl border border-border bg-card p-6 space-y-5">
                <h3 className="text-lg font-semibold text-foreground">Permissions Requested</h3>
                <p className="text-sm text-muted-foreground">
                  Postora requires the following permissions to manage your TikTok content.
                </p>
                <div className="space-y-1">
                  {PERMISSIONS.map((perm, i) => (
                    <div key={i} className="flex items-start gap-3 p-3 rounded-lg hover:bg-secondary/60 transition-colors">
                      <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center flex-shrink-0 mt-0.5">
                        <perm.icon className="w-4 h-4 text-muted-foreground" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-foreground">{perm.label}</p>
                        <p className="text-xs text-muted-foreground">{perm.description}</p>
                      </div>
                    </div>
                  ))}
                </div>
                {connectedAccount && (
                  <div className="pt-3 border-t border-border">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                      <span className="text-sm text-emerald-600 font-medium">All permissions granted</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </DashboardLayout>
  );
}
