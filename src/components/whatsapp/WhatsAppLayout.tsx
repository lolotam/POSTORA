import { ArrowLeft, MessageCircle } from "lucide-react";
import { Link, NavLink, Navigate, Outlet } from "react-router-dom";
import { WhatsAppCoexistenceSetupBanner } from "@/components/messaging/WhatsAppCoexistenceSetupBanner";
import { cn } from "@/lib/utils";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { whatsappNavItems, whatsappSectionRoute } from "./waNav";

export default function WhatsAppLayout() {
  const { flags, isLoading } = useFeatureFlags();

  if (!isLoading && !flags.msgWhatsapp) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-[#25D366]/20 bg-[#075E54] text-white shadow-sm">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/20">
              <MessageCircle className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-xl font-semibold leading-tight">WhatsApp Business</h1>
              <p className="text-sm text-white/75">Conversations, automation, commerce, and diagnostics</p>
            </div>
          </div>
          <Link
            to="/dashboard"
            className="inline-flex w-fit items-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Postora
          </Link>
        </div>
      </header>

      <div className="wa-app border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/90">
        <nav
          aria-label="WhatsApp sections"
          className="mx-auto flex max-w-7xl gap-2 overflow-x-auto px-4 py-3 sm:px-6 lg:px-8"
        >
          {whatsappNavItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.path || "dashboard"}
                to={whatsappSectionRoute(item.path)}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    "flex shrink-0 items-center gap-2 rounded-full px-3 py-2 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-[#128C7E] text-white shadow-sm shadow-[#128C7E]/20"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  )
                }
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </NavLink>
            );
          })}
        </nav>
      </div>

      <main className="wa-app min-h-[calc(100vh-8rem)] bg-gradient-to-b from-[#DCF8C6]/25 via-background to-background dark:from-[#075E54]/25">
        <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
          <WhatsAppCoexistenceSetupBanner />
          <Outlet />
        </div>
      </main>
    </div>
  );
}
