import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Suspense } from "react";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { PageLoader } from "@/components/PageLoader";
import { PageTransition } from "@/components/PageTransition";
import { lazyWithRetry } from "@/lib/lazyWithRetry";

// Lazy load all page components with chunk-retry resilience
const Landing = lazyWithRetry(() => import("@/pages/Landing"), "Landing");
const Auth = lazyWithRetry(() => import("@/pages/Auth"), "Auth");
const WorkspaceInvite = lazyWithRetry(() => import("@/pages/WorkspaceInvite"), "WorkspaceInvite");
const ResetPassword = lazyWithRetry(() => import("@/pages/ResetPassword"), "ResetPassword");
const Dashboard = lazyWithRetry(() => import("@/pages/Dashboard"), "Dashboard");
const Profiles = lazyWithRetry(() => import("@/pages/Profiles"), "Profiles");
const CreatePost = lazyWithRetry(() => import("@/pages/CreatePost"), "CreatePost");
const History = lazyWithRetry(() => import("@/pages/History"), "History");
const Settings = lazyWithRetry(() => import("@/pages/Settings"), "Settings");
const PinterestCallback = lazyWithRetry(() => import("@/pages/PinterestCallback"), "PinterestCallback");
const TikTokCallback = lazyWithRetry(() => import("@/pages/TikTokCallback"), "TikTokCallback");
const MediaLibrary = lazyWithRetry(() => import("@/pages/MediaLibrary"), "MediaLibrary");
const Analytics = lazyWithRetry(() => import("@/pages/Analytics"), "Analytics");
const Calendar = lazyWithRetry(() => import("@/pages/Calendar"), "Calendar");
const Templates = lazyWithRetry(() => import("@/pages/Templates"), "Templates");
const Documentation = lazyWithRetry(() => import("@/pages/Documentation"), "Documentation");
const ApiPlayground = lazyWithRetry(() => import("@/pages/ApiPlayground"), "ApiPlayground");
const CharacterLimits = lazyWithRetry(() => import("@/pages/CharacterLimits"), "CharacterLimits");
const UploadLimits = lazyWithRetry(() => import("@/pages/UploadLimits"), "UploadLimits");
const N8nIntegration = lazyWithRetry(() => import("@/pages/N8nIntegration"), "N8nIntegration");
const MakeIntegration = lazyWithRetry(() => import("@/pages/MakeIntegration"), "MakeIntegration");
const InstagramApi = lazyWithRetry(() => import("@/pages/docs/InstagramApi"), "InstagramApi");
const FacebookApi = lazyWithRetry(() => import("@/pages/docs/FacebookApi"), "FacebookApi");
const PinterestApi = lazyWithRetry(() => import("@/pages/docs/PinterestApi"), "PinterestApi");
const YoutubeApi = lazyWithRetry(() => import("@/pages/docs/YoutubeApi"), "YoutubeApi");
const LinkedInApi = lazyWithRetry(() => import("@/pages/docs/LinkedInApi"), "LinkedInApi");
const TwitterApi = lazyWithRetry(() => import("@/pages/docs/TwitterApi"), "TwitterApi");
const TikTokApi = lazyWithRetry(() => import("@/pages/docs/TikTokApi"), "TikTokApi");
const ThreadsApi = lazyWithRetry(() => import("@/pages/docs/ThreadsApi"), "ThreadsApi");
const BlueskyApi = lazyWithRetry(() => import("@/pages/docs/BlueskyApi"), "BlueskyApi");
const RedditApi = lazyWithRetry(() => import("@/pages/docs/RedditApi"), "RedditApi");
const RemoveBackgroundApi = lazyWithRetry(() => import("@/pages/docs/RemoveBackgroundApi"), "RemoveBackgroundApi");
const UpscaleApi = lazyWithRetry(() => import("@/pages/docs/UpscaleApi"), "UpscaleApi");
const MultiPlatformGuide = lazyWithRetry(() => import("@/pages/docs/MultiPlatformGuide"), "MultiPlatformGuide");
const WebhookGuide = lazyWithRetry(() => import("@/pages/docs/WebhookGuide"), "WebhookGuide");
const PlatformMediaMatrix = lazyWithRetry(() => import("@/pages/docs/PlatformMediaMatrix"), "PlatformMediaMatrix");
const McpServer = lazyWithRetry(() => import("@/pages/docs/McpServer"), "McpServer");
const McpIntegration = lazyWithRetry(() => import("@/pages/docs/McpIntegration"), "McpIntegration");
const Privacy = lazyWithRetry(() => import("@/pages/Privacy"), "Privacy");
const Terms = lazyWithRetry(() => import("@/pages/Terms"), "Terms");
const CookiePolicy = lazyWithRetry(() => import("@/pages/CookiePolicy"), "CookiePolicy");
const GoogleApiDisclosure = lazyWithRetry(() => import("@/pages/GoogleApiDisclosure"), "GoogleApiDisclosure");
const PublicProfile = lazyWithRetry(() => import("@/pages/PublicProfile"), "PublicProfile");
const ContentCalendarTemplate = lazyWithRetry(() => import("@/pages/templates/ContentCalendarTemplate"), "ContentCalendarTemplate");

const NotFound = lazyWithRetry(() => import("@/pages/NotFound"), "NotFound");
const ConnectionHealth = lazyWithRetry(() => import("@/pages/ConnectionHealth"), "ConnectionHealth");
const ApiKeys = lazyWithRetry(() => import("@/pages/ApiKeys"), "ApiKeys");
const Pricing = lazyWithRetry(() => import("@/pages/Pricing"), "Pricing");
const Contact = lazyWithRetry(() => import("@/pages/Contact"), "Contact");
const ScheduledPosts = lazyWithRetry(() => import("@/pages/ScheduledPosts"), "ScheduledPosts");
const WhatsNew = lazyWithRetry(() => import("@/pages/WhatsNew"), "WhatsNew");
const BlogPostDetail = lazyWithRetry(() => import("@/pages/BlogPostDetail"), "BlogPostDetail");
const SubscriptionSuccess = lazyWithRetry(() => import("@/pages/SubscriptionSuccess"), "SubscriptionSuccess");
const SubscriptionCancel = lazyWithRetry(() => import("@/pages/SubscriptionCancel"), "SubscriptionCancel");
const Credits = lazyWithRetry(() => import("@/pages/Credits"), "Credits");
const PaymentSuccess = lazyWithRetry(() => import("@/pages/PaymentSuccess"), "PaymentSuccess");
const CanvasPage = lazyWithRetry(() => import("@/pages/CanvasPage"), "CanvasPage");
const BrandIntelligence = lazyWithRetry(() => import("@/pages/BrandIntelligence"), "BrandIntelligence");
const FacebookAnalytics = lazyWithRetry(() => import("@/pages/analytics/FacebookAnalytics"), "FacebookAnalytics");
const InstagramAnalytics = lazyWithRetry(() => import("@/pages/analytics/InstagramAnalytics"), "InstagramAnalytics");
const ThreadsAnalytics = lazyWithRetry(() => import("@/pages/analytics/ThreadsAnalytics"), "ThreadsAnalytics");
const TikTokAnalytics = lazyWithRetry(() => import("@/pages/analytics/TikTokAnalytics"), "TikTokAnalytics");
const FacebookMessaging = lazyWithRetry(() => import("@/pages/messaging/FacebookMessaging"), "FacebookMessaging");
const InstagramMessaging = lazyWithRetry(() => import("@/pages/messaging/InstagramMessaging"), "InstagramMessaging");
const WhatsAppLayout = lazyWithRetry(() => import("@/components/whatsapp/WhatsAppLayout"), "WhatsAppLayout");
const WhatsAppDashboard = lazyWithRetry(() => import("@/pages/whatsapp/WhatsAppDashboard"), "WhatsAppDashboard");
const WhatsAppPipelines = lazyWithRetry(() => import("@/pages/whatsapp/Pipelines"), "Pipelines");
const WhatsAppConversations = lazyWithRetry(() => import("@/pages/whatsapp/Conversations"), "WhatsAppConversations");
const WhatsAppContacts = lazyWithRetry(() => import("@/pages/whatsapp/Contacts"), "WhatsAppContacts");
const WhatsAppTemplates = lazyWithRetry(() => import("@/pages/whatsapp/Templates"), "WhatsAppTemplates");
const WhatsAppAnalytics = lazyWithRetry(() => import("@/pages/whatsapp/Analytics"), "WhatsAppAnalytics");
const WhatsAppQuickReplies = lazyWithRetry(() => import("@/pages/whatsapp/QuickReplies"), "WhatsAppQuickReplies");
const WhatsAppAutoReplies = lazyWithRetry(() => import("@/pages/whatsapp/AutoReplies"), "WhatsAppAutoReplies");
const WhatsAppBroadcasts = lazyWithRetry(() => import("@/pages/whatsapp/Broadcasts"), "WhatsAppBroadcasts");
const WhatsAppAgents = lazyWithRetry(() => import("@/pages/whatsapp/Agents"), "WhatsAppAgents");
const WhatsAppAiAgent = lazyWithRetry(() => import("@/pages/whatsapp/AiAgent"), "WhatsAppAiAgent");
const WhatsAppAutomation = lazyWithRetry(() => import("@/pages/whatsapp/Automation"), "WhatsAppAutomation");
const WhatsAppBusinessProfile = lazyWithRetry(() => import("@/pages/whatsapp/BusinessProfile"), "WhatsAppBusinessProfile");
const WhatsAppScheduled = lazyWithRetry(() => import("@/pages/whatsapp/Scheduled"), "WhatsAppScheduled");
const WhatsAppResponseStats = lazyWithRetry(() => import("@/pages/whatsapp/ResponseStats"), "WhatsAppResponseStats");
const WhatsAppCatalog = lazyWithRetry(() => import("@/pages/whatsapp/Catalog"), "WhatsAppCatalog");
const WhatsAppSetup = lazyWithRetry(() => import("@/pages/whatsapp/Setup"), "WhatsAppSetup");
const WhatsAppDocs = lazyWithRetry(() => import("@/pages/whatsapp/Docs"), "WhatsAppDocs");
const ThreadsMentions = lazyWithRetry(() => import("@/pages/messaging/ThreadsMentions"), "ThreadsMentions");
const LeadsCRM = lazyWithRetry(() => import("@/pages/LeadsCRM"), "LeadsCRM");
const AdAnalytics = lazyWithRetry(() => import("@/pages/AdAnalytics"), "AdAnalytics");
const SmartScheduling = lazyWithRetry(() => import("@/pages/SmartScheduling"), "SmartScheduling");
const HumanAgentMode = lazyWithRetry(() => import("@/pages/HumanAgentMode"), "HumanAgentMode");
const WhatsAppShop = lazyWithRetry(() => import("@/pages/WhatsAppShop"), "WhatsAppShop");
const AdManager = lazyWithRetry(() => import("@/pages/AdManager"), "AdManager");
const ConnectAuthorize = lazyWithRetry(() => import("@/pages/ConnectAuthorize"), "ConnectAuthorize");
const McpAuthorize = lazyWithRetry(() => import("@/pages/McpAuthorize"), "McpAuthorize");
const BrandIntelligencePost = lazyWithRetry(() => import("@/pages/BrandIntelligencePost"), "BrandIntelligencePost");
const OAuthCallback = lazyWithRetry(() => import("@/pages/OAuthCallback"), "OAuthCallback");
const AdminHiggsfieldCallback = lazyWithRetry(() => import("@/pages/AdminHiggsfieldCallback"), "AdminHiggsfieldCallback");
const ApiDocumentation = lazyWithRetry(() => import("@/pages/ApiDocumentation"), "ApiDocumentation");
const EcommerceWhatsAppApi = lazyWithRetry(() => import("@/pages/docs/EcommerceWhatsAppApi"), "EcommerceWhatsAppApi");

// Admin pages
const AdminDashboard = lazyWithRetry(() => import("@/pages/admin/AdminDashboard"), "AdminDashboard");
const AdminUsers = lazyWithRetry(() => import("@/pages/admin/AdminUsers"), "AdminUsers");
const AdminSubscriptions = lazyWithRetry(() => import("@/pages/admin/AdminSubscriptions"), "AdminSubscriptions");
const AdminPlans = lazyWithRetry(() => import("@/pages/admin/AdminPlans"), "AdminPlans");
const AdminCoupons = lazyWithRetry(() => import("@/pages/admin/AdminCoupons"), "AdminCoupons");
const AdminSettings = lazyWithRetry(() => import("@/pages/admin/AdminSettings"), "AdminSettings");
const AdminMessages = lazyWithRetry(() => import("@/pages/admin/AdminMessages"), "AdminMessages");
const AdminBlogPosts = lazyWithRetry(() => import("@/pages/admin/AdminBlogPosts"), "AdminBlogPosts");
const AdminNotifications = lazyWithRetry(() => import("@/pages/admin/AdminNotifications"), "AdminNotifications");
const AdminOAuthVerification = lazyWithRetry(() => import("@/pages/admin/AdminOAuthVerification"), "AdminOAuthVerification");
const AdminLogs = lazyWithRetry(() => import("@/pages/admin/AdminLogs"), "AdminLogs");
const AdminTokenHealth = lazyWithRetry(() => import("@/pages/admin/AdminTokenHealth"), "AdminTokenHealth");
const AdminAnalytics = lazyWithRetry(() => import("@/pages/admin/AdminAnalytics"), "AdminAnalytics");
const AdminLaunchChecklist = lazyWithRetry(() => import("@/pages/admin/AdminLaunchChecklist"), "AdminLaunchChecklist");
const AdminRateLimits = lazyWithRetry(() => import("@/pages/admin/AdminRateLimits"), "AdminRateLimits");
const AdminMediaCleanup = lazyWithRetry(() => import("@/pages/admin/AdminMediaCleanup"), "AdminMediaCleanup");
const AdminPlanQuotas = lazyWithRetry(() => import("@/pages/admin/AdminPlanQuotas"), "AdminPlanQuotas");
const AdminInbox = lazyWithRetry(() => import("@/pages/admin/AdminInbox"), "AdminInbox");
const AdminObservability = lazyWithRetry(() => import("@/pages/admin/AdminObservability"), "AdminObservability");
const AdminFeatureFlags = lazyWithRetry(() => import("@/pages/admin/AdminFeatureFlags"), "AdminFeatureFlags");
const AdminScaling = lazyWithRetry(() => import("@/pages/admin/AdminScaling"), "AdminScaling");
const AdminOAuthApps = lazyWithRetry(() => import("@/pages/admin/AdminOAuthApps"), "AdminOAuthApps");
const TokenExpiryDocs = lazyWithRetry(() => import("@/pages/docs/TokenExpiryDocs"), "TokenExpiryDocs");
const AdminUserDetail = lazyWithRetry(() => import("@/pages/admin/AdminUserDetail"), "AdminUserDetail");
const TikTokAuthPage = lazyWithRetry(() => import("@/pages/TikTokAuth"), "TikTokAuth");
const TikTokPublishPage = lazyWithRetry(() => import("@/pages/TikTokPublish"), "TikTokPublish");

// Helper component to wrap pages with transitions
function AnimatedPage({ children }: { children: React.ReactNode }) {
  return (
    <PageTransition>
      {children}
    </PageTransition>
  );
}

export function AnimatedRoutes() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/" element={<AnimatedPage><Landing /></AnimatedPage>} />
        <Route path="/auth" element={<AnimatedPage><Auth /></AnimatedPage>} />
        <Route path="/workspace/invite" element={<AnimatedPage><WorkspaceInvite /></AnimatedPage>} />
        <Route path="/connect/authorize" element={<AnimatedPage><ConnectAuthorize /></AnimatedPage>} />
        <Route path="/mcp/authorize" element={<AnimatedPage><McpAuthorize /></AnimatedPage>} />
        <Route path="/auth/oauth/callback" element={<AnimatedPage><OAuthCallback /></AnimatedPage>} />
        <Route path="/admin/oauth/higgsfield/callback" element={<AnimatedPage><AdminHiggsfieldCallback /></AnimatedPage>} />
        <Route path="/reset-password" element={<AnimatedPage><ResetPassword /></AnimatedPage>} />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <AnimatedPage><Dashboard /></AnimatedPage>
            </ProtectedRoute>
          }
        />
        <Route
          path="/profiles"
          element={
            <ProtectedRoute>
              <AnimatedPage><Profiles /></AnimatedPage>
            </ProtectedRoute>
          }
        />
        <Route
          path="/tiktok-callback"
          element={
            <ProtectedRoute>
              <AnimatedPage><TikTokCallback /></AnimatedPage>
            </ProtectedRoute>
          }
        />
        <Route
          path="/oauth/pinterest/callback"
          element={
            <ProtectedRoute>
              <AnimatedPage><PinterestCallback /></AnimatedPage>
            </ProtectedRoute>
          }
        />
        <Route
          path="/post"
          element={
            <ProtectedRoute>
              <AnimatedPage><CreatePost /></AnimatedPage>
            </ProtectedRoute>
          }
        />
        <Route
          path="/history"
          element={
            <ProtectedRoute>
              <AnimatedPage><History /></AnimatedPage>
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <ProtectedRoute>
              <AnimatedPage><Settings /></AnimatedPage>
            </ProtectedRoute>
          }
        />
        {/* Profile route redirects to Settings */}
        <Route
          path="/profile"
          element={
            <ProtectedRoute>
              <AnimatedPage><Settings /></AnimatedPage>
            </ProtectedRoute>
          }
        />
        <Route
          path="/media"
          element={
            <ProtectedRoute>
              <AnimatedPage><MediaLibrary /></AnimatedPage>
            </ProtectedRoute>
          }
        />
        <Route
          path="/analytics"
          element={
            <ProtectedRoute>
              <AnimatedPage><Analytics /></AnimatedPage>
            </ProtectedRoute>
          }
        />
        <Route
          path="/brand-intelligence"
          element={
            <ProtectedRoute>
              <AnimatedPage><Navigate to="/analytics/instagram" replace /></AnimatedPage>
            </ProtectedRoute>
          }
        />
        <Route
          path="/brand-intelligence/post/:postId"
          element={
            <ProtectedRoute>
              <AnimatedPage><BrandIntelligencePost /></AnimatedPage>
            </ProtectedRoute>
          }
        />
        <Route path="/analytics/facebook" element={<ProtectedRoute><AnimatedPage><FacebookAnalytics /></AnimatedPage></ProtectedRoute>} />
        <Route path="/analytics/instagram" element={<ProtectedRoute><AnimatedPage><InstagramAnalytics /></AnimatedPage></ProtectedRoute>} />
        <Route path="/analytics/threads" element={<ProtectedRoute><AnimatedPage><ThreadsAnalytics /></AnimatedPage></ProtectedRoute>} />
        <Route path="/threads" element={<Navigate to="/analytics/threads" replace />} />
        <Route path="/analytics/tiktok" element={<ProtectedRoute><AnimatedPage><TikTokAnalytics /></AnimatedPage></ProtectedRoute>} />
        <Route path="/messaging/facebook" element={<ProtectedRoute><AnimatedPage><FacebookMessaging /></AnimatedPage></ProtectedRoute>} />
        <Route path="/messaging/instagram" element={<ProtectedRoute><AnimatedPage><InstagramMessaging /></AnimatedPage></ProtectedRoute>} />
        <Route path="/messaging/whatsapp" element={<ProtectedRoute><WhatsAppLayout /></ProtectedRoute>}>
          <Route index element={<AnimatedPage><WhatsAppDashboard /></AnimatedPage>} />
          <Route path="pipelines" element={<AnimatedPage><WhatsAppPipelines /></AnimatedPage>} />
          <Route path="conversations" element={<AnimatedPage><WhatsAppConversations /></AnimatedPage>} />
          <Route path="contacts" element={<AnimatedPage><WhatsAppContacts /></AnimatedPage>} />
          <Route path="templates" element={<AnimatedPage><WhatsAppTemplates /></AnimatedPage>} />
          <Route path="analytics" element={<AnimatedPage><WhatsAppAnalytics /></AnimatedPage>} />
          <Route path="quick-replies" element={<AnimatedPage><WhatsAppQuickReplies /></AnimatedPage>} />
          <Route path="auto-replies" element={<AnimatedPage><WhatsAppAutoReplies /></AnimatedPage>} />
          <Route path="broadcasts" element={<AnimatedPage><WhatsAppBroadcasts /></AnimatedPage>} />
          <Route path="agents" element={<AnimatedPage><WhatsAppAgents /></AnimatedPage>} />
          <Route path="ai-agent" element={<AnimatedPage><WhatsAppAiAgent /></AnimatedPage>} />
          <Route path="ai-agent/:tab" element={<AnimatedPage><WhatsAppAiAgent /></AnimatedPage>} />
          <Route path="automation" element={<AnimatedPage><WhatsAppAutomation /></AnimatedPage>} />
          <Route path="profile" element={<AnimatedPage><WhatsAppBusinessProfile /></AnimatedPage>} />
          {/* Webhooks now live as a tab inside Setup; existing links and bookmarks land there. */}
          <Route path="webhooks" element={<Navigate to="/messaging/whatsapp/setup?tab=webhooks" replace />} />
          <Route path="scheduled" element={<AnimatedPage><WhatsAppScheduled /></AnimatedPage>} />
          <Route path="response-stats" element={<AnimatedPage><WhatsAppResponseStats /></AnimatedPage>} />
          <Route path="catalog" element={<AnimatedPage><WhatsAppCatalog /></AnimatedPage>} />
          <Route path="setup" element={<AnimatedPage><WhatsAppSetup /></AnimatedPage>} />
          <Route path="docs" element={<AnimatedPage><WhatsAppDocs /></AnimatedPage>} />
        </Route>
        <Route path="/messaging/thread" element={<ProtectedRoute><AnimatedPage><ThreadsMentions /></AnimatedPage></ProtectedRoute>} />
        <Route path="/leads-crm" element={<ProtectedRoute><AnimatedPage><LeadsCRM /></AnimatedPage></ProtectedRoute>} />
        <Route path="/leads" element={<Navigate to="/leads-crm" replace />} />
        <Route path="/ad-analytics" element={<ProtectedRoute><AnimatedPage><AdAnalytics /></AnimatedPage></ProtectedRoute>} />
        <Route path="/smart-scheduling" element={<ProtectedRoute><AnimatedPage><SmartScheduling /></AnimatedPage></ProtectedRoute>} />
        <Route path="/human-agent" element={<ProtectedRoute><AnimatedPage><HumanAgentMode /></AnimatedPage></ProtectedRoute>} />
        <Route path="/whatsapp-shop" element={<ProtectedRoute><AnimatedPage><WhatsAppShop /></AnimatedPage></ProtectedRoute>} />
        <Route path="/ad-manager" element={<ProtectedRoute><AnimatedPage><AdManager /></AnimatedPage></ProtectedRoute>} />
        <Route
          path="/calendar"
          element={
            <ProtectedRoute>
              <AnimatedPage><Calendar /></AnimatedPage>
            </ProtectedRoute>
          }
        />
        <Route
          path="/templates"
          element={
            <ProtectedRoute>
              <AnimatedPage><Templates /></AnimatedPage>
            </ProtectedRoute>
          }
        />
        <Route
          path="/scheduled"
          element={
            <ProtectedRoute>
              <AnimatedPage><ScheduledPosts /></AnimatedPage>
            </ProtectedRoute>
          }
        />
        <Route
          path="/upload-limits"
          element={
            <ProtectedRoute>
              <AnimatedPage><UploadLimits /></AnimatedPage>
            </ProtectedRoute>
          }
        />
        <Route
          path="/connection-health"
          element={
            <ProtectedRoute>
              <AnimatedPage><ConnectionHealth /></AnimatedPage>
            </ProtectedRoute>
          }
        />
        <Route
          path="/api-keys"
          element={
            <ProtectedRoute>
              <AnimatedPage><ApiKeys /></AnimatedPage>
            </ProtectedRoute>
          }
        />
        <Route path="/doc" element={<Navigate to="/docs" replace />} />
        <Route path="/docs" element={<AnimatedPage><Documentation /></AnimatedPage>} />
        <Route path="/docs/playground" element={<AnimatedPage><ApiPlayground /></AnimatedPage>} />
        <Route path="/api-playground" element={<AnimatedPage><ApiPlayground /></AnimatedPage>} />
        <Route path="/docs/character-limits" element={<AnimatedPage><CharacterLimits /></AnimatedPage>} />
        <Route path="/docs/n8n-integration" element={<AnimatedPage><N8nIntegration /></AnimatedPage>} />
        <Route path="/docs/mcp-server" element={<AnimatedPage><McpServer /></AnimatedPage>} />
        <Route path="/docs/mcp-integration" element={<AnimatedPage><McpIntegration /></AnimatedPage>} />
        <Route path="/docs/make-integration" element={<AnimatedPage><MakeIntegration /></AnimatedPage>} />
        <Route path="/docs/instagram-api" element={<AnimatedPage><InstagramApi /></AnimatedPage>} />
        <Route path="/docs/facebook-api" element={<AnimatedPage><FacebookApi /></AnimatedPage>} />
        <Route path="/docs/pinterest-api" element={<AnimatedPage><PinterestApi /></AnimatedPage>} />
        <Route path="/n8n" element={<AnimatedPage><N8nIntegration /></AnimatedPage>} />
        <Route path="/n8n/instagram" element={<AnimatedPage><InstagramApi /></AnimatedPage>} />
        <Route path="/n8n/facebook" element={<AnimatedPage><FacebookApi /></AnimatedPage>} />
        <Route path="/n8n/pinterest" element={<AnimatedPage><PinterestApi /></AnimatedPage>} />
        <Route path="/docs/youtube-api" element={<AnimatedPage><YoutubeApi /></AnimatedPage>} />
        <Route path="/docs/linkedin-api" element={<AnimatedPage><LinkedInApi /></AnimatedPage>} />
        <Route path="/docs/twitter-api" element={<AnimatedPage><TwitterApi /></AnimatedPage>} />
        <Route path="/docs/tiktok-api" element={<AnimatedPage><TikTokApi /></AnimatedPage>} />
        <Route path="/docs/multi-platform" element={<AnimatedPage><MultiPlatformGuide /></AnimatedPage>} />
        <Route path="/docs/webhooks" element={<AnimatedPage><WebhookGuide /></AnimatedPage>} />
        <Route path="/docs/threads-api" element={<AnimatedPage><ThreadsApi /></AnimatedPage>} />
        <Route path="/docs/bluesky-api" element={<AnimatedPage><BlueskyApi /></AnimatedPage>} />
        <Route path="/docs/reddit-api" element={<AnimatedPage><RedditApi /></AnimatedPage>} />
        <Route path="/docs/remove-background" element={<AnimatedPage><RemoveBackgroundApi /></AnimatedPage>} />
        <Route path="/docs/upscale" element={<AnimatedPage><UpscaleApi /></AnimatedPage>} />
        <Route path="/docs/token-expiry" element={<AnimatedPage><TokenExpiryDocs /></AnimatedPage>} />
        <Route path="/docs/media-matrix" element={<AnimatedPage><PlatformMediaMatrix /></AnimatedPage>} />
        <Route path="/docs/api" element={<AnimatedPage><ApiDocumentation /></AnimatedPage>} />
        <Route path="/docs/whatsapp-ecommerce-api" element={<AnimatedPage><EcommerceWhatsAppApi /></AnimatedPage>} />
        <Route path="/n8n/youtube" element={<AnimatedPage><YoutubeApi /></AnimatedPage>} />
        <Route path="/n8n/linkedin" element={<AnimatedPage><LinkedInApi /></AnimatedPage>} />
        <Route path="/n8n/twitter" element={<AnimatedPage><TwitterApi /></AnimatedPage>} />
        <Route path="/n8n/tiktok" element={<AnimatedPage><TikTokApi /></AnimatedPage>} />
        <Route path="/n8n/threads" element={<AnimatedPage><ThreadsApi /></AnimatedPage>} />
        <Route path="/n8n/bluesky" element={<AnimatedPage><BlueskyApi /></AnimatedPage>} />
        <Route path="/n8n/reddit" element={<AnimatedPage><RedditApi /></AnimatedPage>} />
        <Route path="/n8n/remove-background" element={<AnimatedPage><RemoveBackgroundApi /></AnimatedPage>} />
        <Route path="/n8n/upscale" element={<AnimatedPage><UpscaleApi /></AnimatedPage>} />
        <Route path="/pricing" element={<AnimatedPage><Pricing /></AnimatedPage>} />
        <Route path="/privacy" element={<AnimatedPage><Privacy /></AnimatedPage>} />
        
        <Route path="/terms" element={<AnimatedPage><Terms /></AnimatedPage>} />
        <Route path="/cookies" element={<AnimatedPage><CookiePolicy /></AnimatedPage>} />
        <Route path="/google-api-disclosure" element={<AnimatedPage><GoogleApiDisclosure /></AnimatedPage>} />
        <Route
          path="/contact"
          element={
            <AnimatedPage><Contact /></AnimatedPage>
          }
        />
        <Route path="/p/:shareToken" element={<AnimatedPage><PublicProfile /></AnimatedPage>} />
        <Route path="/templates/content-calendar-template" element={<AnimatedPage><ContentCalendarTemplate /></AnimatedPage>} />
        
        {/* What's New / Blog Routes */}
        <Route
          path="/whats-new"
          element={
            <ProtectedRoute>
              <AnimatedPage><WhatsNew /></AnimatedPage>
            </ProtectedRoute>
          }
        />
        <Route
          path="/whats-new/:id"
          element={
            <ProtectedRoute>
              <AnimatedPage><BlogPostDetail /></AnimatedPage>
            </ProtectedRoute>
          }
        />
        
        {/* Subscription Routes */}
        <Route
          path="/subscription/success"
          element={
            <ProtectedRoute>
              <AnimatedPage><SubscriptionSuccess /></AnimatedPage>
            </ProtectedRoute>
          }
        />
        <Route
          path="/subscription/cancel"
          element={
            <ProtectedRoute>
              <AnimatedPage><SubscriptionCancel /></AnimatedPage>
            </ProtectedRoute>
          }
        />
        
        {/* Credits & One-time Payments */}
        <Route
          path="/credits"
          element={
            <ProtectedRoute>
              <AnimatedPage><Credits /></AnimatedPage>
            </ProtectedRoute>
          }
        />
        <Route
          path="/payment-success"
          element={
            <ProtectedRoute>
              <AnimatedPage><PaymentSuccess /></AnimatedPage>
            </ProtectedRoute>
          }
        />
        
        {/* Canvas Workflow Builder */}
        <Route
          path="/canvas"
          element={
            <ProtectedRoute>
              <AnimatedPage><CanvasPage /></AnimatedPage>
            </ProtectedRoute>
          }
        />
        
        {/* TikTok Demo Pages */}
        <Route
          path="/tiktok-auth"
          element={
            <ProtectedRoute>
              <AnimatedPage><TikTokAuthPage /></AnimatedPage>
            </ProtectedRoute>
          }
        />
        <Route
          path="/tiktok-publish"
          element={
            <ProtectedRoute>
              <AnimatedPage><TikTokPublishPage /></AnimatedPage>
            </ProtectedRoute>
          }
        />
        
        {/* Admin Routes */}
        <Route path="/admin" element={<AnimatedPage><AdminDashboard /></AnimatedPage>} />
        <Route path="/admin/users/:userId" element={<AnimatedPage><AdminUserDetail /></AnimatedPage>} />
        <Route path="/admin/users" element={<AnimatedPage><AdminUsers /></AnimatedPage>} />
        <Route path="/admin/subscriptions" element={<AnimatedPage><AdminSubscriptions /></AnimatedPage>} />
        <Route path="/admin/plans" element={<AnimatedPage><AdminPlans /></AnimatedPage>} />
        <Route path="/admin/coupons" element={<AnimatedPage><AdminCoupons /></AnimatedPage>} />
        <Route path="/admin/settings" element={<AnimatedPage><AdminSettings /></AnimatedPage>} />
        <Route path="/admin/messages" element={<AnimatedPage><AdminMessages /></AnimatedPage>} />
        <Route path="/admin/blog" element={<AnimatedPage><AdminBlogPosts /></AnimatedPage>} />
        <Route path="/admin/notifications" element={<AnimatedPage><AdminNotifications /></AnimatedPage>} />
        <Route path="/admin/oauth-verification" element={<AnimatedPage><AdminOAuthVerification /></AnimatedPage>} />
        <Route path="/admin/oauth-apps" element={<AnimatedPage><AdminOAuthApps /></AnimatedPage>} />
        <Route path="/admin/logs" element={<AnimatedPage><AdminLogs /></AnimatedPage>} />
        <Route path="/admin/token-health" element={<AnimatedPage><AdminTokenHealth /></AnimatedPage>} />
        <Route path="/admin/analytics" element={<AnimatedPage><AdminAnalytics /></AnimatedPage>} />
        <Route path="/admin/launch-checklist" element={<AnimatedPage><AdminLaunchChecklist /></AnimatedPage>} />
        <Route path="/admin/rate-limits" element={<AnimatedPage><AdminRateLimits /></AnimatedPage>} />
        <Route path="/admin/media-cleanup" element={<AnimatedPage><AdminMediaCleanup /></AnimatedPage>} />
        <Route path="/admin/plan-quotas" element={<AnimatedPage><AdminPlanQuotas /></AnimatedPage>} />
        <Route path="/admin/inbox" element={<AnimatedPage><AdminInbox /></AnimatedPage>} />
        <Route path="/admin/observability" element={<AnimatedPage><AdminObservability /></AnimatedPage>} />
        <Route path="/admin/feature-flags" element={<AnimatedPage><AdminFeatureFlags /></AnimatedPage>} />
        <Route path="/admin/scaling" element={<AnimatedPage><AdminScaling /></AnimatedPage>} />
        
        {/* Catch-all route */}
        <Route path="*" element={<AnimatedPage><NotFound /></AnimatedPage>} />
      </Routes>
    </Suspense>
  );
}
