import { useEffect, useState } from "react";
import { ArrowLeft, MessageCircle, Menu, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Link, Navigate, Outlet, useLocation } from "react-router-dom";
import { WhatsAppCoexistenceSetupBanner } from "@/components/messaging/WhatsAppCoexistenceSetupBanner";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { WhatsAppNavList } from "./WhatsAppNavList";
import { WhatsAppChromeProvider, useWhatsAppChrome } from "./WhatsAppChromeContext";
import { WhatsAppWorkspaceProvider } from "./WhatsAppWorkspaceProvider";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

const SIDEBAR_STORAGE_KEY = "postora.whatsapp.sidebarCollapsed";

/** Reading storage throws outright in some privacy modes, so a failure means "use the default". */
function readCollapsedPreference(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function WhatsAppLayoutContent() {
  const { flags, isLoading } = useFeatureFlags();
  const { pathname } = useLocation();
  const { compact, immersive } = useWhatsAppChrome();
  const [collapsed, setCollapsed] = useState(readCollapsedPreference);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Navigating from the drawer should not leave it covering the page it just opened.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // Persisted from an effect rather than inside the updater: StrictMode runs updaters twice in
  // development, and a writing updater would fire the side effect on a render React discards.
  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(collapsed));
    } catch {
      // A viewer who cannot persist the preference still gets it for this session.
    }
  }, [collapsed]);

  if (!isLoading && !flags.msgWhatsapp) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <WhatsAppWorkspaceProvider>
      <TooltipProvider>
        <div className="flex h-[calc(100vh-3.5rem)] supports-[height:100dvh]:h-[calc(100dvh-3.5rem)] flex-col overflow-hidden bg-background text-foreground">
          <header className="z-40 shrink-0 border-b border-[#25D366]/20 bg-[#075E54] text-white shadow-sm">
            <div
              className={cn(
                "flex flex-col px-4 transition-all duration-200 motion-reduce:transition-none sm:px-6 lg:flex-row lg:items-center lg:justify-between",
                compact ? "gap-1.5 py-1.5" : "gap-3 py-2.5",
              )}
            >
              <div className="flex items-center gap-3">
                <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
                  <SheetTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Open WhatsApp navigation"
                      className="text-white hover:bg-white/20 hover:text-white lg:hidden"
                    >
                      <Menu className="h-5 w-5" />
                    </Button>
                  </SheetTrigger>
                  <SheetContent side="left" className="w-72 overflow-y-auto p-4">
                    <SheetTitle className="mb-4 text-base">WhatsApp Business</SheetTitle>
                    <WhatsAppNavList onNavigate={() => setDrawerOpen(false)} />
                  </SheetContent>
                </Sheet>

                <div
                  className={cn(
                    "flex items-center justify-center rounded-full bg-white/10 ring-1 ring-white/20 transition-all duration-200 motion-reduce:transition-none",
                    compact ? "h-7 w-7" : "h-9 w-9",
                  )}
                >
                  <MessageCircle className={cn("transition-all duration-200 motion-reduce:transition-none", compact ? "h-4 w-4" : "h-5 w-5")} />
                </div>
                <div>
                  <h1 className={cn("font-semibold leading-tight transition-all duration-200 motion-reduce:transition-none", compact ? "text-base" : "text-lg")}>
                    WhatsApp Business
                  </h1>
                  <p
                    className={cn(
                      "hidden overflow-hidden text-xs text-white/75 transition-all duration-200 motion-reduce:transition-none sm:block",
                      compact ? "max-h-0 opacity-0" : "max-h-6 opacity-100",
                    )}
                  >
                    Conversations, automation, commerce, and diagnostics
                  </p>
                </div>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <WorkspaceSwitcher />
                <Link
                  to="/messaging"
                  className="inline-flex w-fit items-center gap-1.5 rounded-lg bg-white/10 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  All Inboxes
                </Link>
              </div>
            </div>
          </header>

          <div className="flex min-h-0 flex-1">
            {/* Scrolls independently: fourteen sections do not fit a short viewport, and the
                content pane must not be pushed down by the nav. */}
            <aside
              className={cn(
                "wa-app hidden min-h-0 shrink-0 flex-col border-r bg-background/95 transition-[width] duration-200 ease-in-out lg:flex",
                collapsed ? "w-16" : "w-60",
              )}
            >
              <div className={cn("flex-1 overflow-y-auto", collapsed ? "p-2 px-1.5 scrollbar-none" : "p-3")}>
                <WhatsAppNavList collapsed={collapsed} />
              </div>
              <div className="border-t p-2 flex justify-center">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setCollapsed((previous) => !previous)}
                  aria-expanded={!collapsed}
                  aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                  className={cn(
                    "text-muted-foreground",
                    collapsed ? "h-9 w-9 p-0 justify-center rounded-xl" : "w-full gap-2 px-3"
                  )}
                >
                  {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
                  {!collapsed && <span>Collapse</span>}
                </Button>
              </div>
            </aside>

            <main
              className={cn(
                "wa-app min-h-0 min-w-0 flex-1",
                immersive
                  ? "overflow-hidden"
                  : "overflow-y-auto bg-gradient-to-b from-[#DCF8C6]/25 via-background to-background dark:from-[#075E54]/25",
              )}
            >
              <div className={cn(immersive ? "flex h-full min-h-0 flex-col" : "space-y-6 px-4 py-6 sm:px-6 lg:px-8")}>
                {!immersive && <WhatsAppCoexistenceSetupBanner />}
                <Outlet />
              </div>
            </main>
          </div>
        </div>
      </TooltipProvider>
    </WhatsAppWorkspaceProvider>
  );
}

export default function WhatsAppLayout() {
  return (
    <DashboardLayout noPadding hideFooter>
      <WhatsAppChromeProvider>
        <WhatsAppLayoutContent />
      </WhatsAppChromeProvider>
    </DashboardLayout>
  );
}
