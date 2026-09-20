import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
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
import { AlertCircle, Loader2, Plus, RefreshCw, LayoutGrid, Type, Link, Image, FileText, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { getPlatformProfileUrl } from "@/lib/platformProfileUrls";

interface PinterestBoard {
  id: string;
  name: string;
  pin_count?: number;
}

interface SelectedAccount {
  id: string;
  platform_username: string | null;
  avatar_url: string | null;
}

interface PinterestSettingsProps {
  boards: PinterestBoard[];
  selectedBoard: string;
  setSelectedBoard: (v: string) => void;
  loadingBoards: boolean;
  refreshBoards: () => void;
  title: string;
  setTitle: (v: string) => void;
  link: string;
  setLink: (v: string) => void;
  altText: string;
  setAltText: (v: string) => void;
  note: string;
  setNote: (v: string) => void;
  /** Number of media files selected */
  mediaCount?: number;
  // Selected accounts display
  selectedAccounts?: SelectedAccount[];
}

export function PinterestSettings({
  boards,
  selectedBoard,
  setSelectedBoard,
  loadingBoards,
  refreshBoards,
  title,
  setTitle,
  link,
  setLink,
  altText,
  setAltText,
  note,
  setNote,
  mediaCount = 0,
  selectedAccounts = [],
}: PinterestSettingsProps) {
  const { t } = useTranslation("postsettings");

  return (
    <div className="space-y-4">
      {/* Posting to Pinterest as: */}
      {selectedAccounts.length > 0 && (
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">{t("pinterest.postingAs", "Posting to Pinterest as:")}</Label>
          <div className="flex flex-wrap gap-2">
            {selectedAccounts.map((account) => {
              const profileUrl = getPlatformProfileUrl("pinterest", account.platform_username);
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
                        e.currentTarget.style.display = 'none';
                        e.currentTarget.nextElementSibling?.classList.remove('hidden');
                      }}
                    />
                  ) : null}
                  <div className={cn("w-8 h-8 rounded-full bg-[#E60023] flex items-center justify-center text-white text-xs font-bold", account.avatar_url && "hidden")}>
                    P
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

      {/* Multiple Images Warning */}
      {mediaCount > 1 && (
        <div className="p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
            <div className="space-y-1">
              <p className="text-sm text-amber-800 dark:text-amber-200 font-medium">
                {t("pinterest.multipleImagesTitle", "{{count}} images = {{count}} separate pins", { count: mediaCount })}
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-300">
                {t("pinterest.multipleImagesDesc", "Pinterest's API doesn't support carousel pins. Each image will be posted as a separate pin with a numbered title (e.g., \"{{title}} (1/{{count}})\", \"{{title}} (2/{{count}})\").", { title: title || t("pinterest.yourPinDefault", "Your Pin"), count: mediaCount })}
              </p>
            </div>
          </div>
        </div>
      )}
      {/* Board Selection */}
      <div className="space-y-2">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Label className="text-sm font-medium flex items-center gap-2 cursor-help">
                <LayoutGrid className="w-4 h-4" />
                {t("pinterest.board", "Board")} <span className="text-destructive">*</span>
              </Label>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <p className="font-medium mb-1">{t("pinterest.selectBoardTooltipTitle", "Select a Pinterest Board")}</p>
              <p className="text-xs text-muted-foreground">
                {t("pinterest.selectBoardTooltipDesc", "Boards help organize your pins by topic. Choose a relevant board to improve discoverability. If you don't have one, create it on Pinterest first.")}
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {loadingBoards ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            {t("pinterest.loadingBoards", "Loading boards...")}
          </div>
        ) : boards.length === 0 ? (
          <div className="p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
              <div className="space-y-2">
                <p className="text-sm text-amber-800 dark:text-amber-200 font-medium">
                  {t("pinterest.noBoardsFound", "No Pinterest boards found")}
                </p>
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  {t("pinterest.noBoardsDesc", "Pinterest requires a board to save pins to. Please create a board on Pinterest first, then click Refresh.")}
                </p>
                <div className="flex items-center gap-3">
                  <a
                    href="https://www.pinterest.com/pin-creation-tool/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    <Plus className="w-3 h-3" />
                    {t("pinterest.createBoard", "Create a board")}
                  </a>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={refreshBoards}
                    disabled={loadingBoards}
                    className="h-7 text-xs"
                  >
                    <RefreshCw className={cn("w-3 h-3 mr-1", loadingBoards && "animate-spin")} />
                    {t("pinterest.refresh", "Refresh")}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <Select value={selectedBoard} onValueChange={setSelectedBoard}>
            <SelectTrigger className={cn("w-full", !selectedBoard && "border-destructive/50")}>
              <SelectValue placeholder={t("pinterest.selectBoardPlaceholder", "Select a board")} />
            </SelectTrigger>
            <SelectContent>
              {boards.map((board) => (
                <SelectItem key={board.id} value={board.id}>
                  <div className="flex items-center justify-between w-full">
                    <span>{board.name}</span>
                    {board.pin_count !== undefined && (
                      <span className="text-xs text-muted-foreground ml-2">{t("pinterest.pinsCount", "({{count}} pins)", { count: board.pin_count })}</span>
                    )}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {!selectedBoard && boards.length > 0 && <p className="text-xs text-destructive">{t("pinterest.boardRequired", "Board is required")}</p>}
      </div>

      {/* Pin Title */}
      <div className="space-y-2">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Label className="text-sm font-medium flex items-center gap-2 cursor-help">
                <Type className="w-4 h-4" />
                {t("pinterest.pinTitle", "Pin Title")}
              </Label>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <p className="font-medium mb-1">{t("pinterest.pinTitleTooltipTitle", "Create an Eye-Catching Title")}</p>
              <p className="text-xs text-muted-foreground">
                {t("pinterest.pinTitleTooltipDesc", "Use keywords people search for. Keep it under 60 characters for best display. Good titles describe what the pin offers (e.g., \"10 Easy Breakfast Recipes\").")}
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <Input
          placeholder={t("pinterest.pinTitlePlaceholder", "Add a title for your pin")}
          maxLength={100}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className={cn(
            title.length > 90 && "border-amber-500 focus-visible:ring-amber-500"
          )}
        />
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {mediaCount > 1 && title.length > 0 && (
              <span className="text-amber-600 dark:text-amber-400">
                {t("pinterest.multipleImagesTitleNote", "Note: With {{count}} images, titles will be \"{{titlePreview}} (1/{{count}})\"", { count: mediaCount, titlePreview: `${title.substring(0, 85)}${title.length > 85 ? '...' : ''}` })}
              </span>
            )}
            {(mediaCount <= 1 || title.length === 0) && t("pinterest.maxCharacters", "Max 100 characters")}
          </p>
          <span className={cn(
            "text-xs",
            title.length > 90 ? "text-amber-600" : "text-muted-foreground"
          )}>
            {title.length}/100
          </span>
        </div>
        {mediaCount > 1 && title.length > 90 && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {t("pinterest.titleTruncateWarning", "⚠️ Title may be truncated when suffix \"(X/{{count}})\" is added", { count: mediaCount })}
          </p>
        )}
      </div>

      {/* Link URL */}
      <div className="space-y-2">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Label className="text-sm font-medium flex items-center gap-2 cursor-help">
                <Link className="w-4 h-4" />
                {t("pinterest.destinationLink", "Destination Link")}
              </Label>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <p className="font-medium mb-1">{t("pinterest.destinationLinkTooltipTitle", "Add a Destination URL")}</p>
              <p className="text-xs text-muted-foreground">
                {t("pinterest.destinationLinkTooltipDesc", "Link to your website, blog post, or product page. Use a clean URL without excessive tracking parameters. Make sure the landing page is mobile-friendly as most Pinterest users browse on mobile.")}
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <Input
          placeholder="https://your-website.com/page"
          type="url"
          value={link}
          onChange={(e) => setLink(e.target.value)}
        />
      </div>

      {/* Alt Text */}
      <div className="space-y-2">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Label className="text-sm font-medium flex items-center gap-2 cursor-help">
                <Image className="w-4 h-4" />
                {t("pinterest.altText", "Alt Text (optional)")}
              </Label>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <p className="font-medium mb-1">{t("pinterest.altTextTooltipTitle", "Improve Accessibility & SEO")}</p>
              <p className="text-xs text-muted-foreground">
                {t("pinterest.altTextTooltipDesc", "Describe your image for screen readers. Be specific and include relevant keywords naturally. Example: \"A woman in a blue dress standing on a beach at sunset\" instead of \"photo123\".")}
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <Textarea
          placeholder={t("pinterest.altTextPlaceholder", "Describe what's in your image for accessibility...")}
          className="min-h-[60px] resize-none"
          maxLength={500}
          value={altText}
          onChange={(e) => setAltText(e.target.value)}
        />
      </div>

      {/* Note/Description */}
      <div className="space-y-2">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Label className="text-sm font-medium flex items-center gap-2 cursor-help">
                <FileText className="w-4 h-4" />
                {t("pinterest.note", "Note (optional)")}
              </Label>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("pinterest.noteTooltip", "A private note for yourself - not visible to others")}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <Textarea
          placeholder={t("pinterest.notePlaceholder", "Add a note to yourself about this pin...")}
          className="min-h-[60px] resize-none"
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
    </div>
  );
}
