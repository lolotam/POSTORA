import { useState } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n";
import { Globe, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface WebsiteScrapeInput {
  url: string;
  mode: "page" | "site";
  limit: number;
  scope: "account" | "all";
  generate_setup: boolean;
}

export interface WebsitePanelProps {
  accountId: string | null;
  selectedAccountLabel: string | null;
  submitting: boolean;
  onSubmit: (input: WebsiteScrapeInput) => void;
}

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;

export function WebsitePanel({
  accountId,
  selectedAccountLabel,
  submitting,
  onSubmit,
}: WebsitePanelProps) {
  const { t } = useTranslation("agent");
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<"page" | "site">("page");
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [scope, setScope] = useState<"account" | "all">("account");
  const [error, setError] = useState<string | null>(null);
  const [generateSetup, setGenerateSetup] = useState(true);

  const pageOnly = t("knowledge.scrapePageOnly", "This page only");
  const wholeSite = t("knowledge.scrapeWholeSite", "Whole site");

  const submit = () => {
    const trimmed = url.trim();
    // Only the two rules the user can fix instantly. Everything else -- private
    // hosts, credentials, length -- is the server's, deliberately: duplicating
    // that list in two places is how the two drift apart and one starts
    // accepting what the other refuses.
    if (!trimmed) {
      setError(t("knowledge.scrapeNeedUrl", "Enter the address of the page you want to scrape."));
      return;
    }
    if (!trimmed.startsWith("https://")) {
      setError(t("knowledge.scrapeHttps", "The address must start with https://"));
      return;
    }
    setError(null);
    onSubmit({ url: trimmed, mode, limit, scope: accountId ? scope : "all", generate_setup: !!accountId && generateSetup });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="h-5 w-5" /> {t("knowledge.scrapeTitle", "Scrape a website")}
        </CardTitle>
        <CardDescription>
          {t("knowledge.scrapeDescription", "Pull your public pages into the agent's knowledge. Progress appears in the sources list below.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor="scrape-url">{t("knowledge.scrapeAddress", "Website address")}</Label>
          <Input
            id="scrape-url"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              setError(null);
            }}
            placeholder="https://yourwebsite.com"
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="space-y-2">
          <Label>{t("knowledge.scrapeWhat", "What to scrape")}</Label>
          <RadioGroup
            value={mode}
            onValueChange={(value) => setMode(value as "page" | "site")}
            className="gap-2"
          >
            <label className="flex cursor-pointer items-center gap-2.5 rounded-md border p-2.5 text-sm">
              <RadioGroupItem value="page" id="scrape-mode-page" aria-label={pageOnly} />
              <span>{pageOnly}</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2.5 rounded-md border p-2.5 text-sm">
              <RadioGroupItem value="site" id="scrape-mode-site" aria-label={wholeSite} />
              <span>{wholeSite}</span>
            </label>
          </RadioGroup>
        </div>

        {mode === "site" && (
          <div className="space-y-1.5">
            <Label htmlFor="scrape-limit">{t("knowledge.scrapeMaxPages", "Maximum pages")}</Label>
            <Input
              id="scrape-limit"
              type="number"
              min={MIN_LIMIT}
              max={MAX_LIMIT}
              value={limit}
              onChange={(event) => setLimit(Number(event.target.value))}
              className="w-full max-w-[10rem]"
            />
            <p className="text-xs text-muted-foreground">
              {t("knowledge.scrapeLimitHint", "Each page is scraped and indexed separately — a large site costs credits and takes a few minutes.")}
            </p>
          </div>
        )}

        {accountId && (
          <div className="space-y-1.5">
            <Label htmlFor="scrape-scope">{t("knowledge.uploadAvailableTo", "Available to")}</Label>
            <Select value={scope} onValueChange={(value) => setScope(value as "account" | "all")}>
              <SelectTrigger id="scrape-scope" className="w-full max-w-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="account">
                  {selectedAccountLabel
                    ? t("knowledge.onlyAccount", "Only {{account}}", { account: selectedAccountLabel })
                    : t("knowledge.onlyThisAccount", "Only this account")}
                </SelectItem>
                <SelectItem value="all">{t("knowledge.allAccounts", "All accounts")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        {accountId ? (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium">
              <Checkbox checked={generateSetup} onCheckedChange={(checked) => setGenerateSetup(checked === true)} />
              {t("knowledge.generateSetup", "Generate business and agent setup")}
            </label>
            <p className="text-sm text-muted-foreground">
              {t("knowledge.reviewHint", "Review extracted business details and suggested replies before saving to {{account}}.", {
                account: selectedAccountLabel || t("knowledge.thisAccount", "this account"),
              })}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("knowledge.scrapeSelectAccount", "Select a connected account to generate and apply business and agent settings. You can still index website knowledge here.")}
          </p>
        )}

        <Button onClick={submit} disabled={submitting}>
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t("knowledge.scrapeStart", "Start scraping & indexing")}
        </Button>
      </CardContent>
    </Card>
  );
}
