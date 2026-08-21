import { useEffect, useState } from "react";
import { ArrowLeft, MessageCircle, Menu, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Link, Navigate, Outlet, useLocation } from "react-router-dom";
import { WhatsAppCoexistenceSetupBanner } from "@/components/messaging/WhatsAppCoexistenceSetupBanner";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { WhatsAppNavList } from "./WhatsAppNavList";
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

export default function WhatsAppLayout() {
  const { flags, isLoading } = useFeatureFlags();
  const { pathname } = useLocation();
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
        <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
          <header className="z-40 shrink-0 border-b border-[#25D366]/20 bg-[#075E54] text-white shadow-sm">
            <div className="flex flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
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

                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/20">
                  <MessageCircle className="h-6 w-6" />
                </div>
                <div>
                  <h1 className="text-xl font-semibold leading-tight">WhatsApp Business</h1>
                  <p className="hidden text-sm text-white/75 sm:block">
                    Conversations, automation, commerce, and diagnostics
                  </p>
                </div>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <WorkspaceSwitcher />
                <Link
                  to="/dashboard"
                  className="inline-flex w-fit items-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                >
                  <ArrowLeft className="h-4 w-4" />
                  Back to Postora
                </Link>
              </div>
            </div>
          </header>

          <div className="flex min-h-0 flex-1">
            {/* Scrolls independently: fourteen sections do not fit a short viewport, and the
                content pane must not be pushed down by the nav. */}
            <aside
              className={cn(
                "wa-app hidden shrink-0 flex-col border-r bg-background/95 transition-[width] duration-200 ease-in-out lg:flex",
                collapsed ? "w-[68px]" : "w-60",
              )}
            >
              <div className="flex-1 overflow-y-auto p-3">
                <WhatsAppNavList collapsed={collapsed} />
              </div>
              <div className="border-t p-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setCollapsed((previous) => !previous)}
                  aria-expanded={!collapsed}
                  aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                  className={cn("w-full gap-2 text-muted-foreground", collapsed && "px-0")}
                >
                  {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
                  {!collapsed && <span>Collapse</span>}
                </Button>
              </div>
            </aside>

            <main className="wa-app min-w-0 flex-1 overflow-y-auto bg-gradient-to-b from-[#DCF8C6]/25 via-background to-background dark:from-[#075E54]/25">
              <div className="space-y-6 px-4 py-6 sm:px-6 lg:px-8">
                <WhatsAppCoexistenceSetupBanner />
                <Outlet />
              </div>
            </main>
          </div>
        </div>
      </TooltipProvider>
    </WhatsAppWorkspaceProvider>
  );
}
