import { useTranslation } from "react-i18next";
import { useSearchParams, Link } from "react-router-dom";
import { Navigate } from "react-router-dom";
import { motion } from "framer-motion";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { MessagingInbox } from "@/components/messaging/MessagingInbox";
import { AutomationHandlerCard } from "@/components/messaging/AutomationHandlerCard";
import { GradientDivider, Reveal } from "@/components/fx";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Button } from "@/components/ui/button";
import { WhatsAppChromeProvider } from "@/components/whatsapp/WhatsAppChromeContext";
import { WhatsAppWorkspaceProvider } from "@/components/whatsapp/WhatsAppWorkspaceProvider";
import { WhatsAppInboxScreen } from "@/features/whatsapp-inbox";
import { CheckCircle2, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

export type InboxPlatform = "whatsapp" | "facebook" | "instagram";

interface PlatformTabOption {
  id: InboxPlatform;
  label: string;
  subLabel: string;
  flagKey: "msgWhatsapp" | "msgFacebook" | "msgInstagram";
  colorPreset: "emerald" | "sky" | "rose";
}

const INBOX_PLATFORMS: PlatformTabOption[] = [
  {
    id: "whatsapp",
    label: "WhatsApp",
    subLabel: "Business Chats",
    flagKey: "msgWhatsapp",
    colorPreset: "emerald",
  },
  {
    id: "facebook",
    label: "Facebook",
    subLabel: "Messenger DMs",
    flagKey: "msgFacebook",
    colorPreset: "sky",
  },
  {
    id: "instagram",
    label: "Instagram",
    subLabel: "Direct Messages",
    flagKey: "msgInstagram",
    colorPreset: "rose",
  },
];

export default function UnifiedInboxesPage() {
  const { t } = useTranslation("inbox");
  const [searchParams, setSearchParams] = useSearchParams();

  const platformParam = searchParams.get("platform") as string;

  // Threads mentions live on their own page — send legacy ?platform=threads links there.
  if (platformParam === "threads") {
    return <Navigate to="/messaging/thread" replace />;
  }

  const platform: InboxPlatform = INBOX_PLATFORMS.some((p) => p.id === platformParam)
    ? (platformParam as InboxPlatform)
    : "whatsapp";

  const handlePlatformChange = (nextPlatform: InboxPlatform) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("platform", nextPlatform);
        return next;
      },
      { replace: true }
    );
  };

  return (
    <DashboardLayout>
      <div className="w-full space-y-6 pb-12">
        {/* Animated Gliding Title & 3D Social Media Channels */}
        <Reveal>
          <div className="flex flex-col items-center justify-center space-y-4 pt-1 pb-2">
            {/* Animated Title Track moving across the width of the social media section */}
            <div className="w-full max-w-3xl mx-auto overflow-hidden relative py-3 select-none">
              <motion.div
                className="flex items-center justify-center whitespace-nowrap"
                initial={{ x: "-15%" }}
                animate={{ x: ["-15%", "15%", "-15%"] }}
                transition={{
                  duration: 6,
                  repeat: Infinity,
                  ease: "easeInOut",
                }}
              >
                <h1 className="text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-black uppercase tracking-[0.18em] sm:tracking-[0.25em] md:tracking-[0.3em] drop-shadow-sm text-center text-foreground">
                  {t("unified.title", "Unified Inboxes")}
                </h1>
              </motion.div>
            </div>

            <div
              className="flex items-center justify-center gap-6 sm:gap-8 md:gap-10 lg:gap-12 px-4 py-3 sm:py-4 flex-wrap bg-transparent"
              role="tablist"
              aria-label={t("unified.channelsAria", "Inbox Channels")}
            >
              {INBOX_PLATFORMS.map((p) => {
                const isSelected = platform === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="tab"
                    aria-selected={isSelected}
                    onClick={() => handlePlatformChange(p.id)}
                    className="flex flex-col items-center gap-2 flex-shrink-0 transition-all duration-300 cursor-pointer group focus:outline-none"
                  >
                    <div
                      className={cn(
                        "relative w-20 h-20 sm:w-24 sm:h-24 md:w-28 md:h-28 rounded-2xl sm:rounded-3xl flex items-center justify-center border transition-all duration-300 overflow-visible",
                        // 3D glass specular highlight
                        "before:absolute before:inset-x-0 before:top-0 before:h-1/2 before:rounded-t-2xl sm:before:rounded-t-3xl before:pointer-events-none",
                        isSelected
                          ? "border-primary ring-4 ring-primary/40 shadow-[0_20px_40px_-8px_rgba(var(--primary-rgb,59,130,246),0.5),0_8px_16px_-4px_rgba(0,0,0,0.35),inset_0_2px_3px_rgba(255,255,255,0.9),inset_0_-3px_6px_rgba(0,0,0,0.25)] -translate-y-1.5 scale-105 bg-primary/25"
                          : "bg-card border-border/70 shadow-[0_12px_28px_-6px_rgba(0,0,0,0.35),0_4px_10px_-2px_rgba(0,0,0,0.2),inset_0_1.5px_2px_rgba(255,255,255,0.7),inset_0_-2px_4px_rgba(0,0,0,0.2)] hover:border-primary/60 hover:shadow-[0_18px_36px_-8px_rgba(0,0,0,0.5),inset_0_2px_3px_rgba(255,255,255,0.9)] hover:-translate-y-1.5 hover:scale-105"
                      )}
                    >
                      <PlatformIcon
                        platform={p.id}
                        size="2xl"
                        className="drop-shadow-[0_8px_10px_rgba(0,0,0,0.3)] transition-transform duration-300 group-hover:scale-110"
                      />
                      {isSelected && (
                        <div className="absolute -top-2 -end-2 w-6 h-6 sm:w-7 sm:h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-lg ring-2 ring-background animate-in zoom-in-50 duration-200">
                          <CheckCircle2 className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
                        </div>
                      )}
                    </div>

                    <div className="text-center">
                      <span
                        className={cn(
                          "block text-xs sm:text-sm font-bold tracking-tight transition-colors",
                          isSelected
                            ? "text-foreground font-extrabold"
                            : "text-muted-foreground group-hover:text-foreground"
                        )}
                      >
                        {p.label}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </Reveal>

        <GradientDivider tone="violet" />

        {/* Active Platform Inbox View */}
        <Reveal delay={60}>
          <div className="space-y-4">
            {platform === "whatsapp" && (
              <div className="space-y-4">
                {/* Centered Wide Bold WhatsApp Studio Button Banner */}
                <div className="flex items-center justify-center p-3 sm:p-4 border border-[#25D366]/30 rounded-2xl shadow-sm bg-[#25D366]/10">
                  <Button
                    asChild
                    size="lg"
                    className="w-full max-w-xl h-12 text-sm sm:text-base font-bold bg-[#25D366] hover:bg-[#128C7E] text-white shadow-md shadow-[#25D366]/30 hover:shadow-lg hover:shadow-[#25D366]/40 hover:scale-[1.01] active:scale-[0.99] transition-all gap-2.5 rounded-xl"
                  >
                    <Link to="/messaging/whatsapp/conversations">
                      <PlatformIcon platform="whatsapp" size="sm" />
                      <span>{t("unified.openStudio", "Open Full WhatsApp Studio")}</span>
                      <ExternalLink className="w-4 h-4 ms-1" />
                    </Link>
                  </Button>
                </div>

                <AutomationHandlerCard platform="whatsapp" surface="dms" />
                <div className="flex h-[620px] min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
                  <WhatsAppChromeProvider>
                    <WhatsAppWorkspaceProvider>
                      <WhatsAppInboxScreen />
                    </WhatsAppWorkspaceProvider>
                  </WhatsAppChromeProvider>
                </div>
              </div>
            )}

            {platform === "facebook" && (
              <div className="space-y-4">
                <AutomationHandlerCard platform="facebook" surface="dms" />
                <MessagingInbox platform="facebook" />
              </div>
            )}

            {platform === "instagram" && (
              <div className="space-y-4">
                <AutomationHandlerCard platform="instagram" surface="dms" />
                <MessagingInbox platform="instagram" />
              </div>
            )}
          </div>
        </Reveal>
      </div>
    </DashboardLayout>
  );
}
