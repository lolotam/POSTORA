import React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Trash2 } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PostStep } from "./StepProgressBar";
import { Platform } from "@/lib/types";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { motion, AnimatePresence } from "framer-motion";

interface ConnectedAccount {
  id: string;
  platform: Platform;
  platform_username?: string;
  platformUsername?: string;
  avatar_url?: string;
}

interface CreatePostHeaderProps {
  title?: string;
  currentStep?: PostStep;
  onDiscardDraft?: () => void;
  hasDraft?: boolean;
  selectedPlatforms?: Platform[];
  connectedAccounts?: ConnectedAccount[];
  selectedAccountIds?: string[];
}

export function CreatePostHeader({
  title,
  currentStep = 1,
  onDiscardDraft,
  hasDraft = false,
  selectedPlatforms = [],
  connectedAccounts = [],
  selectedAccountIds = [],
}: CreatePostHeaderProps) {
  const { t } = useTranslation("post");

  const stepDescriptions: Record<PostStep, string> = {
    1: t("header.step1Desc", "Add your media and write your caption"),
    2: t("header.step2Desc", "Choose which accounts to publish to"),
    3: t("header.step3Desc", "Set your schedule and publish"),
  };

  const displayTitle = title ?? t("header.title", "Create New Post");
  const uniquePlatforms = Array.from(new Set(selectedPlatforms));

  const getAccountsForPlatform = (platform: Platform) => {
    return connectedAccounts.filter(
      (acc) =>
        acc.platform === platform &&
        selectedAccountIds.includes(acc.id)
    );
  };

  const selectedAccounts = connectedAccounts.filter((acc) =>
    selectedAccountIds.includes(acc.id)
  );

  const showPlatformIcons = currentStep >= 2 && uniquePlatforms.length > 0;

  return (
    <div className="relative text-center py-4">
      <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground">
        {displayTitle}
      </h1>
      <p className="text-muted-foreground mt-1 text-sm">
        {t("header.stepIndicator", "Step {{step}}: {{description}}", {
          step: currentStep,
          description: stepDescriptions[currentStep],
        })}
      </p>

      <AnimatePresence>
        {showPlatformIcons && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25 }}
            className="flex flex-col items-center gap-2 mt-3"
          >
            <div className="flex items-start justify-center gap-3 flex-wrap">
              {uniquePlatforms.map((platform, index) => {
                const accounts = getAccountsForPlatform(platform);
                const username =
                  accounts[0]?.platform_username ||
                  accounts[0]?.platformUsername ||
                  platform;

                return (
                  <React.Fragment key={platform}>
                    <div className="flex flex-col items-center gap-1.5">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <motion.div
                            initial={{ scale: 0 }}
                            animate={{ scale: 1 }}
                            transition={{ type: "spring", stiffness: 400, damping: 20 }}
                            className="flex items-center justify-center w-8 h-8 rounded-lg bg-muted border border-border"
                          >
                            <PlatformIcon platform={platform} size="sm" />
                          </motion.div>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="text-xs">@{username}</p>
                        </TooltipContent>
                      </Tooltip>
                      <div className="flex items-center gap-1">
                        {accounts.map((account) => {
                          const accUsername =
                            account.platform_username ||
                            account.platformUsername ||
                            account.platform;
                          const initial = (accUsername || "?")[0].toUpperCase();
                          return (
                            <Tooltip key={account.id}>
                              <TooltipTrigger asChild>
                                <motion.div
                                  initial={{ scale: 0 }}
                                  animate={{ scale: 1 }}
                                  transition={{ type: "spring", stiffness: 400, damping: 20 }}
                                >
                                  <Avatar className="w-7 h-7 border border-border">
                                    {account.avatar_url ? (
                                      <AvatarImage src={account.avatar_url} alt={accUsername} />
                                    ) : null}
                                    <AvatarFallback className="text-[10px] bg-muted text-muted-foreground">
                                      {initial}
                                    </AvatarFallback>
                                  </Avatar>
                                </motion.div>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p className="text-xs">@{accUsername}</p>
                              </TooltipContent>
                            </Tooltip>
                          );
                        })}
                      </div>
                    </div>
                    {index < uniquePlatforms.length - 1 && (
                      <div className="w-px h-10 bg-border self-stretch" />
                    )}
                  </React.Fragment>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {hasDraft && onDiscardDraft && (
        <div className="absolute right-0 top-1/2 -translate-y-1/2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={onDiscardDraft}
                className="gap-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
              >
                <Trash2 className="w-4 h-4" />
                <span className="hidden sm:inline">{t("header.discard", "Discard")}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("header.discardTooltip", "Clear all saved content and start fresh")}</p>
            </TooltipContent>
          </Tooltip>
        </div>
      )}
    </div>
  );
}