import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Button } from "@/components/ui/button";
import { getPlatformName } from "@/components/PlatformIcon";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Platform } from "@/lib/types";
import { allPlatforms } from "@/lib/platformConstants";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { useUserRole } from "@/hooks/useUserRole";
import { useProfileOAuth } from "@/hooks/useProfileOAuth";
import { useQuotas } from "@/hooks/useQuotas";
import { useRealtimeSocialAccounts } from "@/hooks/useRealtimeSocialAccounts";
import {
  useSocialProfiles,
  useAllSocialAccounts,
  useEnsureDefaultProfile,
  useDisconnectAccountFromProfile,
  SocialAccountWithProfile,
} from "@/hooks/useSocialProfiles";
import { Loader2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Layers } from "lucide-react";
import { Reveal, Icon3D, GradientHeading, GradientDivider } from "@/components/fx";
import { platformVariant, PLATFORM_TAB_ACTIVE } from "@/components/profiles/platformVariant";
import { cn } from "@/lib/utils";
import {
  ProfilesHeader,
  PageSelectionDialog,
  DisconnectAccountDialog,
  QuotaIndicators,
  BlueskyConnectDialog,
  ConnectionTroubleshooter,
  PlatformAccountsTab,
} from "@/components/profiles";
import { InstagramConnectDialog, type InstagramFlow } from "@/components/profiles/InstagramConnectDialog";
import { InstagramSelectionDialog } from "@/components/profiles/InstagramSelectionDialog";
import { TikTokDebugPanel } from "@/components/profiles/TikTokDebugPanel";
import { ThreadsDebugPanel } from "@/components/admin/ThreadsDebugPanel";
import { UpgradeModal } from "@/components/UpgradeModal";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { useBetaPlatforms } from "@/hooks/useBetaPlatforms";

export default function Profiles() {
  const [pageSearchQuery, setPageSearchQuery] = useState("");
  const [disconnectAccount, setDisconnectAccount] = useState<SocialAccountWithProfile | null>(null);
  const [upgradeModal, setUpgradeModal] = useState<{
    open: boolean;
    type: "profile" | "social_account" | "post";
    current?: number;
    max?: number;
  }>({ open: false, type: "social_account" });
  const [igConfirmProfileId, setIgConfirmProfileId] = useState<string | null>(null);
  const [defaultProfileId, setDefaultProfileId] = useState<string | null>(null);
  const { toast } = useToast();
  const { user } = useAuth();
  const { isAdmin } = useUserRole();
  const { flags } = useFeatureFlags();
  const { betaPlatforms } = useBetaPlatforms();
  const navigate = useNavigate();

  const { data: profiles = [] } = useSocialProfiles();
  const { data: allAccounts = [], isLoading: accountsLoading, refetch, isFetching } = useAllSocialAccounts();
  const ensureDefaultProfile = useEnsureDefaultProfile();
  const disconnectAccountMutation = useDisconnectAccountFromProfile();
  const { quota, canConnectSocialAccount } = useQuotas();

  useRealtimeSocialAccounts();

  // Auto-create/get default profile on mount
  useEffect(() => {
    if (user && !defaultProfileId) {
      if (profiles.length > 0) {
        setDefaultProfileId(profiles[0].id);
      } else {
        ensureDefaultProfile.mutateAsync().then((id) => setDefaultProfileId(id as string)).catch(console.error);
      }
    }
  }, [user, profiles, defaultProfileId]);

  const {
    connectingPlatform,
    pageSelectionData,
    selectingPage,
    blueskyDialogData,
    handleConnectPlatform: originalHandleConnectPlatform,
    handleSelectPage,
    handleSelectStandaloneInstagram,
    handleBlueskyConnect,
    handleBlueskyOAuthConnect,
    handleFacebookConnect,
    handleInstagramBusinessLogin,
    handleInstagramConnect,
    handleLinkedInConnect,
    clearPageSelection,
    clearBlueskyDialog,
    igSelectionData,
    selectingIg,
    connectedIgIds,
    handleSelectIgAccount,
    clearIgSelection,
  } = useProfileOAuth();

  const handleConnectPlatform = async (profileId: string, platform: Platform) => {
    if (!isAdmin) {
      const quotaCheck = await canConnectSocialAccount(profileId);
      if (!quotaCheck.allowed) {
        setUpgradeModal({
          open: true,
          type: "social_account",
          max: quota?.max_social_accounts ?? 4,
        });
        return;
      }
    }
    // Instagram: show flow-choice dialog (Direct vs Facebook Business)
    if (platform === "instagram") {
      setIgConfirmProfileId(profileId);
      return;
    }
    originalHandleConnectPlatform(profileId, platform);
  };

  const handleDisconnectAccount = async (account: SocialAccountWithProfile) => {
    try {
      await disconnectAccountMutation.mutateAsync(account.id);
      toast({
        title: "Account disconnected",
        description: `Your ${getPlatformName(account.platform)} account has been disconnected.`,
      });
    } catch {
      toast({ title: "Error", description: "Failed to disconnect account.", variant: "destructive" });
    }
    setDisconnectAccount(null);
  };

  // Group accounts by platform
  const accountsByPlatform = useMemo(() => {
    const map: Record<Platform, SocialAccountWithProfile[]> = {} as any;
    for (const config of allPlatforms) {
      map[config.platform] = [];
    }
    for (const acc of allAccounts) {
      if (map[acc.platform]) {
        map[acc.platform].push(acc);
      }
    }
    return map;
  }, [allAccounts]);

  // Map platform names to feature flag keys for tab visibility
  const PLATFORM_FLAG_MAP: Record<Platform, keyof typeof flags> = {
    facebook: "tabFacebook",
    instagram: "tabInstagram",
    threads: "tabThreads",
    tiktok: "tabTiktok",
    youtube: "tabYoutube",
    linkedin: "tabLinkedin",
    twitter: "tabTwitter",
    pinterest: "tabPinterest",
    bluesky: "tabBluesky",
    reddit: "tabReddit",
    whatsapp: "tabWhatsapp",
  };

  // Filter platforms by feature flags
  const visiblePlatforms = useMemo(() => {
    if (isAdmin) return allPlatforms;
    return allPlatforms.filter((config) => flags[PLATFORM_FLAG_MAP[config.platform]] !== false);
  }, [flags, isAdmin]);

  const totalAccounts = allAccounts.length;

  // Find first platform with accounts, or default to first visible
  const defaultTab = useMemo(() => {
    for (const config of visiblePlatforms) {
      if (accountsByPlatform[config.platform]?.length > 0) return config.platform;
    }
    return visiblePlatforms[0]?.platform || "facebook";
  }, [accountsByPlatform, visiblePlatforms]);

  return (
    <DashboardLayout>
      <div className="space-y-10">
        <Reveal>
          <ProfilesHeader profileCount={totalAccounts} isAdmin={isAdmin} />
        </Reveal>

        <GradientDivider tone="violet" />

        {/* QuotaIndicators moved to Settings > Subscription */}
        {/* ConnectionTroubleshooter hidden temporarily — re-enable via feature flag */}
        {isAdmin && flags.tiktokOAuthDebug && <TikTokDebugPanel />}
        {isAdmin && (accountsByPlatform.threads?.length || 0) > 0 && (
          <ThreadsDebugPanel
            accounts={(accountsByPlatform.threads || []).map((a) => ({
              id: a.id,
              platform_username: a.platform_username,
            }))}
          />
        )}

        {/* Platform Tabs */}
        <Reveal delay={80}>
          <div className="space-y-5">
            <div className="flex items-center gap-3 flex-wrap">
              <Icon3D icon={Layers} variant="violet" size="sm" />
              <GradientHeading as="h2" preset="violet-sky" size="lg">
                Connected Accounts
              </GradientHeading>
              <Badge variant="secondary" className="ml-1">{totalAccounts} Total</Badge>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => refetch()}
                disabled={isFetching}
                className="h-8 w-8"
              >
                <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
              </Button>
            </div>

          {accountsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Tabs defaultValue={defaultTab} className="w-full">
              <TabsList className="flex flex-nowrap h-auto gap-2 bg-transparent p-0 pt-4 overflow-x-auto scrollbar-hide">
                {visiblePlatforms.map((config) => {
                  const count = accountsByPlatform[config.platform]?.length || 0;
                  const v = platformVariant(config.platform);
                  return (
                    <TabsTrigger
                      key={config.platform}
                      value={config.platform}
                      className={cn(
                        "group relative gap-2 rounded-xl border border-border/60 bg-card/60 backdrop-blur-md px-3 py-2 transition-all duration-300 hover:-translate-y-0.5 hover:bg-card",
                        "data-[state=active]:bg-gradient-to-br data-[state=active]:text-white data-[state=active]:border-transparent data-[state=active]:shadow-lg data-[state=active]:ring-1 data-[state=active]:ring-white/20",
                        PLATFORM_TAB_ACTIVE[v],
                      )}
                    >
                      {betaPlatforms[config.platform] && (
                        <Badge className="absolute -top-2.5 left-1/2 -translate-x-1/2 bg-amber-500/20 text-amber-600 border-amber-500/30 text-[9px] px-1.5 py-0 leading-tight">Beta</Badge>
                      )}
                      <PlatformIcon platform={config.platform} size="sm" />
                      {config.name}
                      <Badge
                        variant={count > 0 ? "default" : "secondary"}
                        className={`h-5 min-w-[20px] text-xs ${count > 0 ? "bg-primary/20 text-primary group-data-[state=active]:bg-white/90 group-data-[state=active]:text-foreground" : "group-data-[state=active]:bg-white/20 group-data-[state=active]:text-white"}`}
                      >
                        {count}
                      </Badge>
                    </TabsTrigger>
                  );
                })}
              </TabsList>

              {visiblePlatforms.map((config) => (
                <TabsContent key={config.platform} value={config.platform} className="mt-4">
                  <Reveal>
                    <PlatformAccountsTab
                    platform={config.platform}
                    accounts={accountsByPlatform[config.platform] || []}
                    onConnect={() => {
                      if (defaultProfileId) {
                        handleConnectPlatform(defaultProfileId, config.platform);
                      } else {
                        toast({ title: "Please wait", description: "Setting up your account...", variant: "destructive" });
                      }
                    }}
                    onDisconnect={setDisconnectAccount}
                    onReconnect={(platform) => {
                      if (defaultProfileId) handleConnectPlatform(defaultProfileId, platform);
                    }}
                    isConnecting={connectingPlatform === config.platform}
                    />
                  </Reveal>
                </TabsContent>
              ))}
            </Tabs>
          )}
          </div>
        </Reveal>
      </div>

      {/* Dialogs */}
      <DisconnectAccountDialog
        account={disconnectAccount}
        onOpenChange={() => setDisconnectAccount(null)}
        onDisconnect={handleDisconnectAccount}
      />

      <PageSelectionDialog
        open={!!pageSelectionData}
        onOpenChange={(open) => {
          if (!open && !selectingPage) {
            clearPageSelection();
            setPageSearchQuery("");
          }
        }}
        pages={pageSelectionData?.pages || []}
        standaloneInstagram={pageSelectionData?.standaloneInstagram || []}
        pageSearchQuery={pageSearchQuery}
        onPageSearchChange={setPageSearchQuery}
        onSelectPage={handleSelectPage}
        onSelectStandaloneInstagram={handleSelectStandaloneInstagram}
        selectingPage={selectingPage}
      />

      <BlueskyConnectDialog
        open={!!blueskyDialogData}
        onOpenChange={(open) => { if (!open) clearBlueskyDialog(); }}
        onConnect={async (handle, appPassword) => {
          if (blueskyDialogData) await handleBlueskyConnect(blueskyDialogData.profileId, handle, appPassword);
        }}
        onOAuthConnect={async (handle) => {
          if (blueskyDialogData) await handleBlueskyOAuthConnect(blueskyDialogData.profileId, handle);
        }}
        isConnecting={connectingPlatform === "bluesky"}
      />


      <InstagramConnectDialog
        open={!!igConfirmProfileId}
        onOpenChange={(open) => { if (!open) setIgConfirmProfileId(null); }}
        disabled={connectingPlatform === "instagram"}
        onSelect={(flow: InstagramFlow) => {
          if (igConfirmProfileId) {
            handleInstagramConnect(igConfirmProfileId, flow);
            setIgConfirmProfileId(null);
          }
        }}
      />

      <InstagramSelectionDialog
        open={!!igSelectionData}
        onOpenChange={(open) => { if (!open && !selectingIg) clearIgSelection(); }}
        accounts={igSelectionData?.accounts ?? []}
        selectingId={selectingIg}
        connectedIds={connectedIgIds}
        onSelect={handleSelectIgAccount}
        onDone={clearIgSelection}
      />

      <UpgradeModal
        open={upgradeModal.open}
        onOpenChange={(open) => setUpgradeModal({ ...upgradeModal, open })}
        limitType={upgradeModal.type}
        currentUsage={upgradeModal.current}
        maxAllowed={upgradeModal.max}
      />
    </DashboardLayout>
  );
}
