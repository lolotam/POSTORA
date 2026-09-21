import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Building2, Eye, Type, FileText, ExternalLink, ChevronDown, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { getPlatformProfileUrl } from "@/lib/platformProfileUrls";

export type LinkedInVisibility = "PUBLIC" | "CONNECTIONS" | "LOGGED_IN" | "CONTAINER";

export interface LinkedInPage {
  id: string;
  name: string;
  vanityName?: string;
  logoUrl?: string;
}

interface SelectedAccount {
  id: string;
  platform_username: string | null;
  platform_user_id?: string | null;
  avatar_url: string | null;
  account_metadata?: Record<string, unknown> | null;
}

interface LinkedInSettingsProps {
  visibility: LinkedInVisibility;
  setVisibility: (v: LinkedInVisibility) => void;
  linkedInTitle: string;
  setLinkedInTitle: (v: string) => void;
  linkedInDescription: string;
  setLinkedInDescription: (v: string) => void;
  selectedDestinationIds: string[];
  setSelectedDestinationIds: (ids: string[]) => void;
  availablePages?: LinkedInPage[];
  selectedAccounts?: SelectedAccount[];
}

const PERSONAL_ID = "personal";

export function LinkedInSettings({
  visibility,
  setVisibility,
  linkedInTitle,
  setLinkedInTitle,
  linkedInDescription,
  setLinkedInDescription,
  selectedDestinationIds,
  setSelectedDestinationIds,
  availablePages = [],
  selectedAccounts = [],
}: LinkedInSettingsProps) {
  const { t } = useTranslation("postsettings");
  const personalAccount = selectedAccounts[0];
  const personalName = personalAccount?.platform_username || t("linkedin.personalProfile", "Personal Profile");

  const allDestinationIds = useMemo(
    () => [PERSONAL_ID, ...availablePages.map((p) => p.id)],
    [availablePages]
  );

  const toggle = (id: string, checked: boolean) => {
    const set = new Set(selectedDestinationIds);
    if (checked) {
      set.add(id);
    } else {
      set.delete(id);
    }
    // Always keep at least one destination — fall back to personal.
    if (set.size === 0) {
      set.add(PERSONAL_ID);
    }
    setSelectedDestinationIds(Array.from(set));
  };

  const selectAll = () => setSelectedDestinationIds(allDestinationIds);
  const clearToPersonal = () => setSelectedDestinationIds([PERSONAL_ID]);

  const triggerLabel = (() => {
    const count = selectedDestinationIds.length;
    if (count === 0) return t("linkedin.selectDestinations", "Select destinations");
    if (count === 1) {
      const only = selectedDestinationIds[0];
      if (only === PERSONAL_ID) return t("linkedin.personalProfile", "Personal Profile");
      const page = availablePages.find((p) => p.id === only);
      return page?.name || t("linkedin.oneDestination", "1 destination");
    }
    const hasPersonal = selectedDestinationIds.includes(PERSONAL_ID);
    const pageCount = count - (hasPersonal ? 1 : 0);
    if (hasPersonal && pageCount > 0) {
      return pageCount === 1
        ? t("linkedin.personalPlusPage", "Personal Profile + 1 Page")
        : t("linkedin.personalPlusPages", "Personal Profile + {{count}} Pages", { count: pageCount });
    }
    return t("linkedin.countDestinations", "{{count}} destinations", { count });
  })();

  return (
    <div className="space-y-4">
      {/* Posting to LinkedIn as: */}
      {selectedAccounts.length > 0 && (
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">{t("linkedin.postingAs", "Posting to LinkedIn as:")}</Label>
          <div className="flex flex-wrap gap-2">
            {selectedAccounts.map((account) => {
              const profileUrl = getPlatformProfileUrl(
                "linkedin",
                account.platform_username,
                account.platform_user_id,
                account.account_metadata
              );
              return (
                <a
                  key={account.id}
                  href={profileUrl || "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    "flex items-center gap-2 p-2 bg-secondary/50 rounded-lg border transition-colors",
                    profileUrl && "hover:bg-secondary hover:border-primary/30 cursor-pointer"
                  )}
                  onClick={(e) => !profileUrl && e.preventDefault()}
                >
                  {account.avatar_url ? (
                    <img
                      src={account.avatar_url}
                      alt=""
                      className="w-8 h-8 rounded-full object-cover"
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                        e.currentTarget.nextElementSibling?.classList.remove("hidden");
                      }}
                    />
                  ) : null}
                  <div
                    className={cn(
                      "w-8 h-8 rounded-full bg-brand-linkedin flex items-center justify-center text-primary-foreground text-xs font-bold",
                      account.avatar_url && "hidden"
                    )}
                  >
                    in
                  </div>
                  <div className="flex flex-col">
                    <span className="text-sm font-medium flex items-center gap-1">
                      {account.platform_username || "Unknown"}
                      {profileUrl && <ExternalLink className="w-3 h-3 text-muted-foreground" />}
                    </span>
                  </div>
                </a>
              );
            })}
          </div>
        </div>
      )}

      {/* Post destinations multi-select */}
      <div className="space-y-2">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Label className="text-sm font-medium flex items-center gap-2 cursor-help">
                <Building2 className="w-4 h-4" />
                {t("linkedin.destinations", "Post Destinations")}
              </Label>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("linkedin.destinationsTooltip", "Choose any combination of your personal profile and the company pages you manage.")}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              className="w-full justify-between font-normal"
            >
              <span className="truncate text-start">{triggerLabel}</span>
              <ChevronDown className="w-4 h-4 opacity-60 shrink-0" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[--radix-popover-trigger-width] p-0">
            <div className="flex items-center justify-between px-3 py-2 border-b text-xs">
              <span className="text-muted-foreground">
                {t("linkedin.selectedCount", "{{count}} selected", { count: selectedDestinationIds.length })}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={selectAll}
                >
                  {t("linkedin.selectAll", "Select all")}
                </button>
                <span className="text-muted-foreground">·</span>
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={clearToPersonal}
                >
                  {t("linkedin.reset", "Reset")}
                </button>
              </div>
            </div>

            <div className="max-h-64 overflow-y-auto py-1">
              {/* Personal accounts group */}
              <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("linkedin.personalAccountGroup", "Personal account")}
              </div>
              <label className="flex items-center gap-3 px-3 py-2 hover:bg-accent cursor-pointer">
                <Checkbox
                  checked={selectedDestinationIds.includes(PERSONAL_ID)}
                  onCheckedChange={(v) => toggle(PERSONAL_ID, !!v)}
                />
                <Avatar className="h-7 w-7">
                  {personalAccount?.avatar_url ? (
                    <AvatarImage src={personalAccount.avatar_url} alt={personalName} />
                  ) : null}
                  <AvatarFallback>
                    <User className="w-3.5 h-3.5" />
                  </AvatarFallback>
                </Avatar>
                <div className="flex flex-col text-start">
                  <span className="text-sm">{t("linkedin.personalProfile", "Personal Profile")}</span>
                  <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                    {personalName}
                  </span>
                </div>
              </label>

              {/* Commercial pages group */}
              {availablePages.length === 0 ? (
                <>
                  <div className="my-1 border-t border-border/60" />
                  <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {t("linkedin.commercialPagesGroup", "Commercial pages")}
                  </div>
                  <div className="px-3 py-3 text-xs text-muted-foreground">
                    {t("linkedin.noPagesPrefix", "No LinkedIn Pages found on this account. Reconnect with the")}
                    <code className="mx-1 px-1 rounded bg-muted">w_organization_social</code>
                    {t("linkedin.noPagesSuffix", "scope to manage Pages.")}
                  </div>
                </>
              ) : (
                <>
                  <div className="my-1 border-t border-border/60" />
                  <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {t("linkedin.commercialPagesGroup", "Commercial pages")}
                  </div>
                  {availablePages.map((page) => (
                    <label
                      key={page.id}
                      className="flex items-center gap-3 px-3 py-2 hover:bg-accent cursor-pointer"
                    >
                      <Checkbox
                        checked={selectedDestinationIds.includes(page.id)}
                        onCheckedChange={(v) => toggle(page.id, !!v)}
                      />
                      <Avatar className="h-7 w-7">
                        <AvatarImage src={page.logoUrl} alt={page.name} />
                        <AvatarFallback className="text-xs">
                          {page.name.charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex flex-col text-start">
                        <span className="text-sm truncate max-w-[220px]">{page.name}</span>
                        {page.vanityName && (
                          <span className="text-xs text-muted-foreground truncate max-w-[220px]">
                            {page.vanityName}
                          </span>
                        )}
                      </div>
                    </label>
                  ))}
                </>
              )}
            </div>
          </PopoverContent>
        </Popover>

        <p className="text-xs text-muted-foreground">
          {t("linkedin.destinationsHelp", "The same post will be published once per selected destination.")}
        </p>
      </div>

      {/* Visibility and Title Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Label className="text-sm font-medium flex items-center gap-2 cursor-help">
                  <Eye className="w-4 h-4" />
                  {t("linkedin.visibility", "Visibility")}
                </Label>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t("linkedin.visibilityTooltip", "Control who can see your post on LinkedIn. Organization Pages always post as PUBLIC.")}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <Select value={visibility} onValueChange={(v) => setVisibility(v as LinkedInVisibility)}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="PUBLIC">{t("linkedin.visibilityPublic", "PUBLIC")}</SelectItem>
              <SelectItem value="CONNECTIONS">{t("linkedin.visibilityConnections", "CONNECTIONS")}</SelectItem>
              <SelectItem value="LOGGED_IN">{t("linkedin.visibilityLoggedIn", "LOGGED_IN")}</SelectItem>
              <SelectItem value="CONTAINER">{t("linkedin.visibilityContainer", "CONTAINER")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Label className="text-sm font-medium flex items-center gap-2 cursor-help">
                  <Type className="w-4 h-4" />
                  {t("linkedin.title", "LinkedIn Title (optional)")}
                </Label>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t("linkedin.titleTooltip", "Add a custom title that appears above your post content")}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <Textarea
            placeholder={t("linkedin.titlePlaceholder", "Custom title for LinkedIn")}
            className="min-h-[40px] resize-y"
            value={linkedInTitle}
            onChange={(e) => setLinkedInTitle(e.target.value)}
          />
        </div>
      </div>

      <div className="space-y-2">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Label className="text-sm font-medium flex items-center gap-2 cursor-help">
                <FileText className="w-4 h-4" />
                {t("linkedin.description", "LinkedIn Description (optional)")}
              </Label>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("linkedin.descriptionTooltip", "Add additional context or details specific to your LinkedIn audience")}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <Textarea
          placeholder={t("linkedin.descriptionPlaceholder", "LinkedIn description")}
          className="min-h-[80px] resize-y"
          value={linkedInDescription}
          onChange={(e) => setLinkedInDescription(e.target.value)}
        />
      </div>
    </div>
  );
}
