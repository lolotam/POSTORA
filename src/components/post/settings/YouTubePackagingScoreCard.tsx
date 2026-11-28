import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, CheckCircle2, Loader2, Sparkles, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { PackagingScore } from "@/lib/youtubePackagingScoreClient";

export interface YouTubePackagingScoreCardProps {
  title: string;
  description?: string;
  defaultLanguage?: "english" | "arabic";
  namespace?: "postsettings" | "accounts";
  disabled?: boolean;
  requestScore: (input: {
    title: string;
    thumbnailText?: string;
    description?: string;
    language: "english" | "arabic";
  }) => Promise<PackagingScore>;
  onApplyTitle: (newTitle: string) => void;
}

export function YouTubePackagingScoreCard({
  title,
  description,
  defaultLanguage,
  namespace = "postsettings",
  disabled = false,
  requestScore,
  onApplyTitle,
}: YouTubePackagingScoreCardProps): JSX.Element {
  const isAccounts = namespace === "accounts";
  const { t, i18n } = useTranslation(isAccounts ? "accounts" : "postsettings");
  const initialLang: "english" | "arabic" =
    defaultLanguage ?? (i18n.language?.startsWith("ar") ? "arabic" : "english");

  const [thumbnailText, setThumbnailText] = useState("");
  const [language, setLanguage] = useState<"english" | "arabic">(initialLang);
  const [isLoading, setIsLoading] = useState(false);
  const [score, setScore] = useState<PackagingScore | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const thumbnailInputId = useId();
  const requestIdRef = useRef(0);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, []);

  useEffect(() => {
    requestIdRef.current += 1;
    setIsLoading(false);
    setErrorMessage(null);
  }, [title, description]);

  const labels = isAccounts
    ? {
        heading: t(
          "accounts:youtubeManagement.score.heading",
          "Title & Thumbnail Packaging Score",
        ),
        disclaimer: t(
          "accounts:youtubeManagement.score.disclaimer",
          "AI estimate, not a YouTube metric",
        ),
        thumbnailLabel: t(
          "accounts:youtubeManagement.score.thumbnailLabel",
          "Thumbnail text / visual hook (optional)",
        ),
        thumbnailPlaceholder: t(
          "accounts:youtubeManagement.score.thumbnailPlaceholder",
          "Describe your thumbnail or text overlay to score synergy...",
        ),
        langEnglish: t("accounts:youtubeManagement.score.langEnglish", "English"),
        langArabic: t("accounts:youtubeManagement.score.langArabic", "العربية"),
        scoreButton: t(
          "accounts:youtubeManagement.score.scoreButton",
          "Score title & thumbnail",
        ),
        scoringButton: t(
          "accounts:youtubeManagement.score.scoringButton",
          "Scoring…",
        ),
        overallLabel: t(
          "accounts:youtubeManagement.score.overallLabel",
          "Overall packaging score",
        ),
        hookLabel: t("accounts:youtubeManagement.score.hookLabel", "Hook"),
        clarityLabel: t("accounts:youtubeManagement.score.clarityLabel", "Clarity"),
        mobileLengthLabel: t(
          "accounts:youtubeManagement.score.mobileLengthLabel",
          "Mobile length",
        ),
        synergyLabel: t(
          "accounts:youtubeManagement.score.synergyLabel",
          "Thumbnail synergy",
        ),
        synergyEmpty: t(
          "accounts:youtubeManagement.score.synergyEmpty",
          "Describe your thumbnail to score this",
        ),
        strengthsHeading: t(
          "accounts:youtubeManagement.score.strengthsHeading",
          "Strengths",
        ),
        fixesHeading: t(
          "accounts:youtubeManagement.score.fixesHeading",
          "Suggested fixes",
        ),
        betterTitlesHeading: t(
          "accounts:youtubeManagement.score.betterTitlesHeading",
          "Alternative titles",
        ),
        useThisTitle: t(
          "accounts:youtubeManagement.score.useThisTitle",
          "Use this title",
        ),
        errorFallback: t(
          "accounts:youtubeManagement.score.errorFallback",
          "Could not score title and thumbnail right now. Try again.",
        ),
      }
    : {
        heading: t(
          "postsettings:youtubeAI.score.heading",
          "Title & Thumbnail Packaging Score",
        ),
        disclaimer: t(
          "postsettings:youtubeAI.score.disclaimer",
          "AI estimate, not a YouTube metric",
        ),
        thumbnailLabel: t(
          "postsettings:youtubeAI.score.thumbnailLabel",
          "Thumbnail text / visual hook (optional)",
        ),
        thumbnailPlaceholder: t(
          "postsettings:youtubeAI.score.thumbnailPlaceholder",
          "Describe your thumbnail or text overlay to score synergy...",
        ),
        langEnglish: t("postsettings:youtubeAI.score.langEnglish", "English"),
        langArabic: t("postsettings:youtubeAI.score.langArabic", "العربية"),
        scoreButton: t(
          "postsettings:youtubeAI.score.scoreButton",
          "Score title & thumbnail",
        ),
        scoringButton: t(
          "postsettings:youtubeAI.score.scoringButton",
          "Scoring…",
        ),
        overallLabel: t(
          "postsettings:youtubeAI.score.overallLabel",
          "Overall packaging score",
        ),
        hookLabel: t("postsettings:youtubeAI.score.hookLabel", "Hook"),
        clarityLabel: t("postsettings:youtubeAI.score.clarityLabel", "Clarity"),
        mobileLengthLabel: t(
          "postsettings:youtubeAI.score.mobileLengthLabel",
          "Mobile length",
        ),
        synergyLabel: t(
          "postsettings:youtubeAI.score.synergyLabel",
          "Thumbnail synergy",
        ),
        synergyEmpty: t(
          "postsettings:youtubeAI.score.synergyEmpty",
          "Describe your thumbnail to score this",
        ),
        strengthsHeading: t(
          "postsettings:youtubeAI.score.strengthsHeading",
          "Strengths",
        ),
        fixesHeading: t(
          "postsettings:youtubeAI.score.fixesHeading",
          "Suggested fixes",
        ),
        betterTitlesHeading: t(
          "postsettings:youtubeAI.score.betterTitlesHeading",
          "Alternative titles",
        ),
        useThisTitle: t(
          "postsettings:youtubeAI.score.useThisTitle",
          "Use this title",
        ),
        errorFallback: t(
          "postsettings:youtubeAI.score.errorFallback",
          "Could not score title and thumbnail right now. Try again.",
        ),
      };

  const trimmedTitle = title.trim();
  const canScore =
    !disabled &&
    !isLoading &&
    trimmedTitle.length >= 1 &&
    trimmedTitle.length <= 100;

  const handleScore = async () => {
    if (!canScore) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const nextScore = await requestScore({
        title: trimmedTitle,
        ...(thumbnailText.trim() ? { thumbnailText: thumbnailText.trim() } : {}),
        ...(description?.trim() ? { description: description.trim() } : {}),
        language,
      });
      if (!isMountedRef.current || requestIdRef.current !== requestId) return;
      setScore(nextScore);
    } catch {
      if (!isMountedRef.current || requestIdRef.current !== requestId) return;
      setErrorMessage(labels.errorFallback);
    } finally {
      if (isMountedRef.current && requestIdRef.current === requestId) {
        setIsLoading(false);
      }
    }
  };

  const breakdownRows: ReadonlyArray<{
    key: string;
    label: string;
    value: number | null;
    emptyText?: string;
  }> = score
    ? [
        { key: "hook", label: labels.hookLabel, value: score.breakdown.hook },
        { key: "clarity", label: labels.clarityLabel, value: score.breakdown.clarity },
        {
          key: "mobile_length",
          label: labels.mobileLengthLabel,
          value: score.breakdown.mobile_length,
        },
        {
          key: "thumbnail_synergy",
          label: labels.synergyLabel,
          value: score.breakdown.thumbnail_synergy,
          emptyText: labels.synergyEmpty,
        },
      ]
    : [];

  return (
    <div
      className="space-y-3 rounded-lg border bg-secondary/20 p-3"
      data-testid="youtube-packaging-score-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold text-foreground">{labels.heading}</span>
        <Badge
          variant="outline"
          className="text-[11px] font-normal text-muted-foreground"
          data-testid="youtube-packaging-score-disclaimer"
        >
          {labels.disclaimer}
        </Badge>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={thumbnailInputId} className="text-xs text-muted-foreground">
          {labels.thumbnailLabel}
        </Label>
        <Input
          id={thumbnailInputId}
          data-testid="youtube-packaging-thumbnail-text"
          value={thumbnailText}
          onChange={(e) => setThumbnailText(e.target.value.slice(0, 300))}
          maxLength={300}
          disabled={disabled || isLoading}
          placeholder={labels.thumbnailPlaceholder}
          className="h-8 text-xs"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={language}
          onValueChange={(value) => setLanguage(value as "english" | "arabic")}
          disabled={disabled || isLoading}
        >
          <SelectTrigger className="h-8 w-28 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="english">{labels.langEnglish}</SelectItem>
            <SelectItem value="arabic">{labels.langArabic}</SelectItem>
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleScore}
          disabled={!canScore}
          data-testid="youtube-packaging-score-button"
          className="h-8 gap-1.5 text-xs"
        >
          {isLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          {isLoading ? labels.scoringButton : labels.scoreButton}
        </Button>
      </div>

      {errorMessage && (
        <div
          role="alert"
          data-testid="youtube-packaging-score-error"
          className="flex items-center gap-1.5 text-xs text-destructive"
        >
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {score && (
        <div className="space-y-3 border-t pt-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              {labels.overallLabel}
            </span>
            <span
              dir="ltr"
              data-testid="youtube-packaging-overall-score"
              className="text-sm font-bold text-foreground"
            >
              {score.overall_score}/100
            </span>
          </div>

          <div className="space-y-2">
            {breakdownRows.map((row) => (
              <div key={row.key} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{row.label}</span>
                  {row.value === null ? (
                    <span
                      data-testid="youtube-packaging-synergy-empty"
                      className="text-[11px] italic text-muted-foreground"
                    >
                      {row.emptyText}
                    </span>
                  ) : (
                    <span dir="ltr" className="font-medium text-foreground">
                      {row.value}/100
                    </span>
                  )}
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                  {row.value !== null && (
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${Math.max(0, Math.min(100, row.value))}%` }}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>

          {score.strengths.length > 0 && (
            <div className="space-y-1">
              <p className="flex items-center gap-1 text-xs font-medium text-foreground">
                <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                {labels.strengthsHeading}
              </p>
              <ul className="list-inside list-disc space-y-0.5 text-xs text-muted-foreground">
                {score.strengths.map((item, idx) => (
                  <li key={idx}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          {score.fixes.length > 0 && (
            <div className="space-y-1">
              <p className="flex items-center gap-1 text-xs font-medium text-foreground">
                <Wrench className="h-3.5 w-3.5 text-muted-foreground" />
                {labels.fixesHeading}
              </p>
              <ul className="list-inside list-disc space-y-0.5 text-xs text-muted-foreground">
                {score.fixes.map((item, idx) => (
                  <li key={idx}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-1.5">
            <p className="text-xs font-medium text-foreground">
              {labels.betterTitlesHeading}
            </p>
            <div className="space-y-1.5">
              {score.better_titles.map((altTitle, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between gap-2 rounded-md border bg-background p-2 text-xs"
                >
                  <span className="flex-1 text-foreground">{altTitle}</span>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={disabled}
                    data-testid={`youtube-packaging-use-title-${idx}`}
                    onClick={() => onApplyTitle(altTitle)}
                    className="h-7 shrink-0 text-xs"
                  >
                    {labels.useThisTitle}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
