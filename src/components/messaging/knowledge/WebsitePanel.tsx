import { useState } from "react";
import { Globe, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface WebsiteScrapeInput {
  url: string;
  mode: "page" | "site";
  limit: number;
  scope: "account" | "all";
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
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<"page" | "site">("page");
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [scope, setScope] = useState<"account" | "all">("account");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const trimmed = url.trim();
    // Only the two rules the user can fix instantly. Everything else -- private
    // hosts, credentials, length -- is the server's, deliberately: duplicating
    // that list in two places is how the two drift apart and one starts
    // accepting what the other refuses.
    if (!trimmed) {
      setError("Enter the address of the page you want to scrape.");
      return;
    }
    if (!trimmed.startsWith("https://")) {
      setError("The address must start with https://");
      return;
    }
    setError(null);
    onSubmit({ url: trimmed, mode, limit, scope: accountId ? scope : "all" });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="h-5 w-5" /> Scrape a website
        </CardTitle>
        <CardDescription>
          Pull your public pages into the agent&apos;s knowledge. Progress appears in the sources
          list below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor="scrape-url">Website address</Label>
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
          <Label>What to scrape</Label>
          <RadioGroup
            value={mode}
            onValueChange={(value) => setMode(value as "page" | "site")}
            className="gap-2"
          >
            <label className="flex cursor-pointer items-center gap-2.5 rounded-md border p-2.5 text-sm">
              <RadioGroupItem value="page" id="scrape-mode-page" aria-label="This page only" />
              <span>This page only</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2.5 rounded-md border p-2.5 text-sm">
              <RadioGroupItem value="site" id="scrape-mode-site" aria-label="Whole site" />
              <span>Whole site</span>
            </label>
          </RadioGroup>
        </div>

        {mode === "site" && (
          <div className="space-y-1.5">
            <Label htmlFor="scrape-limit">Maximum pages</Label>
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
              Each page is scraped and indexed separately — a large site costs credits and takes a
              few minutes.
            </p>
          </div>
        )}

        {accountId && (
          <div className="space-y-1.5">
            <Label htmlFor="scrape-scope">Available to</Label>
            <Select value={scope} onValueChange={(value) => setScope(value as "account" | "all")}>
              <SelectTrigger id="scrape-scope" className="w-full max-w-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="account">
                  {selectedAccountLabel ? `Only ${selectedAccountLabel}` : "Only this account"}
                </SelectItem>
                <SelectItem value="all">All accounts</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        <Button onClick={submit} disabled={submitting}>
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Start scraping &amp; indexing
        </Button>
      </CardContent>
    </Card>
  );
}
