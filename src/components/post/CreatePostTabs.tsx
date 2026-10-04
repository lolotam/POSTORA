import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Image, Type, Users, Settings, Clock } from "lucide-react";
import { motion } from "framer-motion";

export type PostTab = "media" | "caption" | "accounts" | "settings" | "schedule";

interface CreatePostTabsProps {
  activeTab: PostTab;
  onTabChange: (tab: PostTab) => void;
  accountCount?: number;
  mediaCount?: number;
}

export function CreatePostTabs({ activeTab, onTabChange, accountCount = 0, mediaCount = 0 }: CreatePostTabsProps) {
  const { t } = useTranslation("post");

  const tabs: { id: PostTab; label: string; icon: React.ElementType }[] = [
    { id: "media", label: t("tabs.media", "Media"), icon: Image },
    { id: "caption", label: t("tabs.caption", "Caption"), icon: Type },
    { id: "accounts", label: t("tabs.accounts", "Accounts"), icon: Users },
    { id: "settings", label: t("tabs.settings", "Settings"), icon: Settings },
    { id: "schedule", label: t("tabs.schedule", "Schedule"), icon: Clock },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2 p-1.5 rounded-2xl border border-white/15 bg-white/5">
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        const Icon = tab.icon;
        const badge = tab.id === "accounts" ? accountCount : tab.id === "media" ? mediaCount : 0;

        return (
          <motion.button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            className={cn(
              "relative flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all duration-200",
              "border outline-none focus-visible:ring-2 focus-visible:ring-ring",
              isActive
                ? "border-primary/40 bg-primary/15 text-primary"
                : "border-white/10 bg-transparent text-muted-foreground hover:bg-white/10 hover:border-white/25 hover:text-foreground"
            )}
          >
            <Icon className="w-4 h-4" />
            <span className="hidden sm:inline">{tab.label}</span>
            {badge > 0 && (
              <span className={cn(
                "inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-[11px] font-bold",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground"
              )}>
                {badge}
              </span>
            )}
          </motion.button>
        );
      })}
    </div>
  );
}
