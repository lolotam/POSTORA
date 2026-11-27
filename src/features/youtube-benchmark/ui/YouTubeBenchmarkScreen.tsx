import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/useAuth";
import { isBenchmarkInputFailure, parseBenchmarkInputs, type BenchmarkInputParseFailure } from "../domain/benchmark";
import type { YouTubeBenchmarkAccountOption } from "../domain/accounts";
import type { YouTubeBenchmarkGateway } from "../application/ports";
import { useYouTubeChannelBenchmark } from "../application/useYouTubeChannelBenchmark";
import { defaultYouTubeBenchmarkGateway } from "../infrastructure/supabaseYouTubeBenchmarkGateway";
import { YouTubeBenchmarkAccountPicker } from "./YouTubeBenchmarkAccountPicker";
import { YouTubeBenchmarkColumnCard } from "./YouTubeBenchmarkColumnCard";

export interface YouTubeBenchmarkScreenProps {
  accounts: readonly YouTubeBenchmarkAccountOption[];
  accountsLoading: boolean;
  gateway?: YouTubeBenchmarkGateway;
  // The page's connected-accounts query can fail; the screen then offers a
  // retry instead of pretending no channel is connected.
  accountsError?: unknown;
  onRetryAccounts?: () => void;
}

const EMPTY_VALUE = "—";

function validationMessage(reason: BenchmarkInputParseFailure, t: TFunction): string {
  switch (reason) {
    case "empty":
      return t(
        "youtubeBenchmark.validation.empty",
        "Enter at least one channel handle or channel ID.",
      );
    case "too_many":
      return t("youtubeBenchmark.validation.tooMany", "Compare up to three channels at a time.");
    case "duplicate_input":
      return t("youtubeBenchmark.validation.duplicateInput", "The same channel was entered twice.");
    default:
      return t(
        "youtubeBenchmark.validation.invalidInput",
        "That is not a YouTube handle or channel ID.",
      );
  }
}

/**
 * The composition root of the feature: the only ui/ file allowed to import
 * infrastructure (for the default gateway), which every test replaces.
 */
export function YouTubeBenchmarkScreen(props: YouTubeBenchmarkScreenProps): JSX.Element {
  const {
    accounts,
    accountsLoading,
    gateway = defaultYouTubeBenchmarkGateway,
    accountsError,
    onRetryAccounts,
  } = props;
  const { t, i18n } = useTranslation("accounts");
  const userId = useAuth().user?.id ?? null;
  const locale = i18n.language.startsWith("ar") ? "ar" : "en";

  const [pickedAccountId, setPickedAccountId] = useState<string | null>(null);
  const [inputs, setInputs] = useState<string[]>(["", "", ""]);
  const [validationError, setValidationError] = useState<string | null>(null);

  const activeAccountId =
    pickedAccountId !== null && accounts.some((account) => account.id === pickedAccountId)
      ? pickedAccountId
      : accounts[0]?.id ?? null;

  const { columns, isComparing, compare, retry } = useYouTubeChannelBenchmark({
    gateway,
    userId,
    accountId: activeAccountId,
  });

  // The freshest read among the columns: the freshness line describes the
  // comparison the creator is looking at.
  const fetchedAt = useMemo(() => {
    const stamps = columns
      .map((column) => column.fetchedAt)
      .filter((stamp): stamp is string => stamp !== null);
    if (stamps.length === 0) return null;
    return stamps.reduce((latest, stamp) => (stamp > latest ? stamp : latest));
  }, [columns]);

  const setInput = (index: number, value: string) => {
    setInputs((previous) => {
      const next = [...previous];
      next[index] = value;
      return next;
    });
  };

  const onCompare = () => {
    // The rules are the server's rules, applied in the browser first: an
    // empty, malformed or repeated input must not spend a provider unit.
    const parsed = parseBenchmarkInputs(inputs);
    if (isBenchmarkInputFailure(parsed)) {
      setValidationError(validationMessage(parsed.reason, t));
      return;
    }
    setValidationError(null);
    compare(parsed.inputs);
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{t("youtubeBenchmark.title", "YouTube channel benchmark")}</h1>
        <p className="text-sm text-muted-foreground">
          {t(
            "youtubeBenchmark.subtitle",
            "Compare up to three public YouTube channels side by side. Nothing you read here is stored.",
          )}
        </p>
      </div>

      {accountsLoading ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("youtubeBenchmark.loading", "Loading…")}
        </p>
      ) : accountsError !== undefined && accountsError !== null ? (
        <Alert role="alert">
          <AlertDescription className="space-y-2">
            <p>
              {t(
                "youtubeBenchmark.accountsError",
                "Postora could not read your connected accounts. Nothing was changed.",
              )}
            </p>
            <Button size="sm" variant="outline" onClick={() => onRetryAccounts?.()}>
              {t("youtubeBenchmark.retry", "Retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : accounts.length === 0 ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {t("youtubeBenchmark.noAccounts", "No YouTube channel is connected yet.")}
          </p>
          <Button asChild size="sm" variant="outline">
            <Link to="/profiles">{t("youtubeBenchmark.goToProfiles", "Open Profiles")}</Link>
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <YouTubeBenchmarkAccountPicker
            accounts={accounts}
            selectedId={activeAccountId}
            onSelect={setPickedAccountId}
          />

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="youtube-benchmark-input-0">
                {t("youtubeBenchmark.channel1", "Channel 1")}
              </Label>
              <Input
                id="youtube-benchmark-input-0"
                value={inputs[0] ?? ""}
                placeholder={t("youtubeBenchmark.channelPlaceholder", "@handle or UC… channel ID")}
                onChange={(event) => setInput(0, event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="youtube-benchmark-input-1">
                {t("youtubeBenchmark.channel2", "Channel 2 (optional)")}
              </Label>
              <Input
                id="youtube-benchmark-input-1"
                value={inputs[1] ?? ""}
                placeholder={t("youtubeBenchmark.channelPlaceholder", "@handle or UC… channel ID")}
                onChange={(event) => setInput(1, event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="youtube-benchmark-input-2">
                {t("youtubeBenchmark.channel3", "Channel 3 (optional)")}
              </Label>
              <Input
                id="youtube-benchmark-input-2"
                value={inputs[2] ?? ""}
                placeholder={t("youtubeBenchmark.channelPlaceholder", "@handle or UC… channel ID")}
                onChange={(event) => setInput(2, event.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" disabled={isComparing || activeAccountId === null} onClick={onCompare}>
              {isComparing
                ? t("youtubeBenchmark.comparing", "Comparing…")
                : t("youtubeBenchmark.compare", "Compare channels")}
            </Button>
          </div>

          {validationError ? (
            <p role="alert" className="text-sm text-destructive">
              {validationError}
            </p>
          ) : null}

          {columns.length > 0 ? (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                {t("youtubeBenchmark.fetchedAt", "Fetched at {{time}}", {
                  time: fetchedAt === null ? EMPTY_VALUE : formatFetchedAt(fetchedAt, locale),
                })}
              </p>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {columns.map((column) => (
                  <YouTubeBenchmarkColumnCard
                    key={column.input}
                    column={column}
                    onRetry={() => retry(column.input)}
                  />
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {t(
                  "youtubeBenchmark.attribution",
                  "Public channel data provided by YouTube API Services. Nothing is stored by Postora.",
                )}
              </p>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function formatFetchedAt(value: string, locale: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(parsed);
}
