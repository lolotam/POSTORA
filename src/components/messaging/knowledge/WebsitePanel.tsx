import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Placeholder until the Firecrawl slice lands (slice 4 of
 * docs/superpowers/plans/2026-09-05-agent-setup-restructure.md).
 *
 * The tab exists now rather than later so the shell it belongs to is reviewed
 * and shipped once, and so the empty state is an honest sentence rather than a
 * control that does nothing when clicked.
 */
export function WebsitePanel() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Scrape a website</CardTitle>
        <CardDescription>Pull your public pages into the agent&apos;s knowledge.</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Website scraping is being set up. It arrives in the next release.
        </p>
      </CardContent>
    </Card>
  );
}
