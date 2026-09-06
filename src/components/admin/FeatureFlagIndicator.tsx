import { useState } from "react";
import { useFeatureFlags, FeatureFlags } from "@/hooks/useFeatureFlags";
import { useUserRole } from "@/hooks/useUserRole";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Eye, EyeOff, ChevronDown, ChevronUp, Check, X } from "lucide-react";

const FLAG_LABELS: Record<keyof FeatureFlags, string> = {
  videoCompress: "Video Compression",
  tiktokTranscode: "TikTok Transcode",
  tiktokPreCheck: "TikTok Pre-Check",
  imageCrop: "Image Cropping",
  aiCaption: "AI Caption",
  aiHashtags: "AI Hashtags",
  aiThumbnails: "AI Thumbnails",
  aiImage: "AI Image",
  stockUpload: "Stock Upload",
  canvas: "Canvas",
  titleRequired: "Title Required",
  mediaCounter: "Media Counter",
  atlascloudUpscale: "AtlasCloud 4K Upscale",
  emailNotifications: "Email Notifications",
  platformAccess: "Platform Access",
  freePlatforms: "Free Platforms",
  tiktokOAuthDebug: "TikTok OAuth Debug",
  connectionTroubleshooter: "Connection Troubleshooter",
  instagramViaFacebook: "Instagram via Facebook",
  reusePostData: "Reuse Post Data",
  fbPostType: "FB Post Type",
  fbLocation: "FB Location",
  fbFirstComment: "FB First Comment",
  fbLink: "FB Link",
  fbShareToStory: "FB Share to Story",
  igPostType: "IG Post Type",
  igLocation: "IG Location",
  igFirstComment: "IG First Comment",
  igCollaborator: "IG Collaborator",
  igAdvancedSettings: "IG Advanced Settings",
  tabFacebook: "Facebook Tab",
  tabInstagram: "Instagram Tab",
  tabThreads: "Threads Tab",
  tabTiktok: "TikTok Tab",
  tabYoutube: "YouTube Tab",
  tabLinkedin: "LinkedIn Tab",
  tabTwitter: "X Tab",
  tabPinterest: "Pinterest Tab",
  tabBluesky: "Bluesky Tab",
  tabReddit: "Reddit Tab",
  tabWhatsapp: "WhatsApp Tab",
  tokenExpires: "Token Expires",
  tokenLifetime: "Token Lifetime",
  brandIntelligence: "Brand Intelligence",
  threadsShareToIg: "Threads Share to Instagram",
  msgFacebook: "Messaging Facebook",
  msgInstagram: "Messaging Instagram",
  msgWhatsapp: "Messaging WhatsApp",
  msgThreads: "Messaging Threads Mentions",
  msgThreadsReply: "Threads Reply",
  msgThreadsAutomation: "Threads Automation",
  msgThreadsWebhooks: "Threads Webhooks",
  msgThreadsAssignment: "Threads Assignment",
  commentManager: "Comment Manager",
  commentWorkflow: "Comment Workflow",
  byokProviders: "Your AI providers",
  youtubeComments: "YouTube Comments",
  leadsCrm: "Leads CRM",
  audienceHub: "Audience & Contacts",
  adAnalytics: "Ad Analytics",
  smartScheduling: "Smart Scheduling",
  humanAgent: "Human Agent",
  whatsappShop: "WhatsApp Shop",
  adManager: "Ad Manager",
  marketeroButton: "Marketero Button",
  waCloudApiEnabled: "WhatsApp Cloud API Mode",
  waEvolutionQrEnabled: "WhatsApp Direct QR Mode",
  analyticsFacebook: "Analytics: Facebook",
  analyticsInstagram: "Analytics: Instagram",
  analyticsThreads: "Analytics: Threads",
  analyticsTiktok: "Analytics: TikTok",
};

export function FeatureFlagIndicator() {
  const { isAdmin } = useUserRole();
  const { flags, isLoading } = useFeatureFlags();
  const [isOpen, setIsOpen] = useState(false);
  const [isVisible, setIsVisible] = useState(true);

  // Only show for admins
  if (!isAdmin || isLoading) return null;

  const activeCount = Object.values(flags).filter(Boolean).length;
  const totalCount = Object.keys(flags).length;

  if (!isVisible) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => setIsVisible(true)}
        className="fixed bottom-4 right-4 z-50 shadow-lg bg-background border-primary/20"
      >
        <Eye className="w-4 h-4 mr-2" />
        Show Flags
      </Button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 w-72 shadow-xl rounded-lg border bg-background/95 backdrop-blur-sm">
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <div className="flex items-center justify-between p-3 border-b">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="flex-1 justify-start gap-2 p-0 h-auto hover:bg-transparent">
              {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
              <span className="font-medium text-sm">Feature Flags</span>
              <Badge variant="secondary" className="ml-auto">
                {activeCount}/{totalCount}
              </Badge>
            </Button>
          </CollapsibleTrigger>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 ml-2"
            onClick={() => setIsVisible(false)}
          >
            <EyeOff className="w-3.5 h-3.5" />
          </Button>
        </div>

        <CollapsibleContent>
          <div className="p-3 space-y-2 max-h-64 overflow-y-auto">
            {(Object.entries(flags) as [keyof FeatureFlags, boolean][]).map(([key, enabled]) => (
              <div
                key={key}
                className="flex items-center justify-between py-1.5 px-2 rounded-md bg-muted/50"
              >
                <span className="text-sm">{FLAG_LABELS[key]}</span>
                {enabled ? (
                  <Badge variant="default" className="bg-green-500/20 text-green-600 border-green-500/30 hover:bg-green-500/20">
                    <Check className="w-3 h-3 mr-1" />
                    On
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="bg-destructive/10 text-destructive border-destructive/20">
                    <X className="w-3 h-3 mr-1" />
                    Off
                  </Badge>
                )}
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
