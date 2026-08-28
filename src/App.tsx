import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "@/hooks/useAuth";
import { OAuthReturnHandler } from "@/components/OAuthReturnHandler";
import { ThemeProvider } from "next-themes";
import { DocumentTitle } from "@/components/DocumentTitle";
import { FeatureFlagIndicator } from "@/components/admin/FeatureFlagIndicator";
import { PublishingProvider } from "@/contexts/PublishingContext";
import { ProcessingJobsProvider } from "@/contexts/ProcessingJobsContext";
import { VideoProcessingDebugProvider } from "@/contexts/VideoProcessingDebugContext";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { NetworkStatusIndicator } from "@/components/NetworkStatusIndicator";
import { ThemeApplier } from "@/components/ThemeApplier";
import { initErrorTracking } from "@/services/errorTracking";
import { AnimatedRoutes } from "@/components/AnimatedRoutes";
import { useScopedActivityStore } from "@/stores/notificationHistoryStore";
import { useAuthQueryCacheSync } from "@/hooks/useAuthQueryCacheSync";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes — reuse cached data, reduce DB calls by ~80%
      gcTime: 10 * 60 * 1000,   // 10 minutes — keep unused cache longer before GC
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
// Initialize error tracking on app load
initErrorTracking();

/** Binds the activity-history store to the current authenticated user. */
const ActivityStoreScope = () => {
  useScopedActivityStore();
  return null;
};

/** Drops cached server state whenever the authenticated identity changes. */
const QueryCacheAuthScope = () => {
  useAuthQueryCacheSync();
  return null;
};

const App = () => (
  <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ActivityStoreScope />
        <QueryCacheAuthScope />
        <PublishingProvider>
          <ProcessingJobsProvider>
          <VideoProcessingDebugProvider>
          <TooltipProvider>
            <NetworkStatusIndicator />
            <ThemeApplier />
            <Toaster />
            <Sonner />
            <FeatureFlagIndicator />
            <BrowserRouter>
              <DocumentTitle />
              <OAuthReturnHandler />
              <ErrorBoundary>
                <AnimatedRoutes />
              </ErrorBoundary>
            </BrowserRouter>
          </TooltipProvider>
          </VideoProcessingDebugProvider>
          </ProcessingJobsProvider>
        </PublishingProvider>
      </AuthProvider>
    </QueryClientProvider>
  </ThemeProvider>
);

export default App;
