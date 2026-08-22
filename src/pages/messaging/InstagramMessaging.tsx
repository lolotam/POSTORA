import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { MessagingInbox } from "@/components/messaging/MessagingInbox";
import { Camera, Inbox, MessageCircle, Bot, UserCog, Sparkles } from "lucide-react";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { Navigate, useSearchParams } from "react-router-dom";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CommentManagerPanel } from "@/components/comments/CommentManagerPanel";
import { AutoReplyManager } from "@/components/messaging/AutoReplyManager";
import { AgentManager } from "@/components/messaging/AgentManager";
import { AiAgentManager } from "@/components/messaging/AiAgentManager";
import { Icon3D, GradientHeading, GradientRingCard, GradientDivider, Reveal } from "@/components/fx";
import { AutomationHandlerCard } from "@/components/messaging/AutomationHandlerCard";
import { messagingTabFromSearch } from "@/lib/messagingTab";

export default function InstagramMessaging() {
  const { flags, isLoading } = useFeatureFlags();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = messagingTabFromSearch(searchParams.toString(), "inbox", ["inbox", "comments", "auto-replies", "agents", "ai-agent"]);

  const setTab = (nextTab: string) => {
    setSearchParams((current) => {
      current.set("tab", nextTab);
      return current;
    });
  };

  if (!isLoading && !flags.msgInstagram) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <DashboardLayout>
      <div className="w-full space-y-6">
        <Reveal>
          <div className="group flex items-center gap-4">
            <Icon3D icon={Camera} variant="rose" size="md" />
            <div className="flex-1 min-w-0">
              <GradientHeading preset="amber-rose-violet" size="lg" as="h1">Instagram DMs</GradientHeading>
              <p className="text-sm text-muted-foreground mt-1">Manage your Instagram Direct Messages</p>
            </div>
          </div>
        </Reveal>
        <GradientDivider tone="rose" />
        <Reveal delay={80}>
          <Tabs value={tab} onValueChange={setTab} className="w-full">
            <TabsList className="bg-card/50 backdrop-blur-md border border-border/40 rounded-xl p-1 h-auto [&>[data-state=active]]:bg-gradient-to-r [&>[data-state=active]]:from-rose-500 [&>[data-state=active]]:via-pink-500 [&>[data-state=active]]:to-fuchsia-500 [&>[data-state=active]]:text-white [&>[data-state=active]]:shadow-md">
              <TabsTrigger value="inbox" className="gap-1.5 rounded-lg">
                <Inbox className="w-4 h-4" />
                Inbox
              </TabsTrigger>
              {flags.commentManager && (
                <TabsTrigger value="comments" className="gap-1.5 rounded-lg">
                  <MessageCircle className="w-4 h-4" />
                  Comment Manager
                </TabsTrigger>
              )}
              <TabsTrigger value="auto-replies" className="gap-1.5 rounded-lg">
                <Bot className="w-4 h-4" />
                Auto Replies
              </TabsTrigger>
              {flags.humanAgent && (
                <TabsTrigger value="agents" className="gap-1.5 rounded-lg">
                  <UserCog className="w-4 h-4" />
                  Agents
                </TabsTrigger>
              )}
              <TabsTrigger value="ai-agent" className="gap-1.5 rounded-lg">
                <Sparkles className="w-4 h-4" />
                AI Agent
              </TabsTrigger>
            </TabsList>
            <TabsContent value="inbox" className="mt-4">
              <GradientRingCard variant="rose" padded={false} hoverLift={false} ringIntensity="subtle" innerClassName="p-4 md:p-5">
                <MessagingInbox platform="instagram" />
              </GradientRingCard>
            </TabsContent>
            {flags.commentManager && (
              <TabsContent value="comments" className="mt-4">
                <GradientRingCard variant="rose" padded={false} hoverLift={false} ringIntensity="subtle" innerClassName="p-4 md:p-5">
                  <CommentManagerPanel platform="instagram" />
                </GradientRingCard>
              </TabsContent>
            )}
            <TabsContent value="auto-replies" className="mt-4">
              <GradientRingCard variant="rose" padded={false} hoverLift={false} ringIntensity="subtle" innerClassName="p-4 md:p-5">
                <AutomationHandlerCard platform="instagram" />
                <AutoReplyManager platform="instagram" />
              </GradientRingCard>
            </TabsContent>
            {flags.humanAgent && (
              <TabsContent value="agents" className="mt-4">
                <GradientRingCard variant="rose" padded={false} hoverLift={false} ringIntensity="subtle" innerClassName="p-4 md:p-5">
                  <AgentManager platform="instagram" />
                </GradientRingCard>
              </TabsContent>
            )}
            <TabsContent value="ai-agent" className="mt-4">
              <GradientRingCard variant="rose" padded={false} hoverLift={false} ringIntensity="subtle" innerClassName="p-4 md:p-5">
                <AiAgentManager platform="instagram" />
              </GradientRingCard>
            </TabsContent>
          </Tabs>
        </Reveal>
      </div>
    </DashboardLayout>
  );
}
