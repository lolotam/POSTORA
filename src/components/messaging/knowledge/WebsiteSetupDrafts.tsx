import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useWebsiteSetup } from "@/hooks/useWebsiteSetup";
import type { AiAgentConfig, AiAgentPlatform } from "@/hooks/useAiAgentConfig";
import type { AiKnowledgeSource } from "@/hooks/useAiKnowledge";
import type { BusinessProfile } from "@/lib/agentProfile";
import { draftFields, type WebsiteSetupJob } from "@/lib/websiteSetup";

interface WebsiteSetupDraftsProps {
  platform: AiAgentPlatform;
  accountId: string;
  sources: AiKnowledgeSource[];
  config: AiAgentConfig | null | undefined;
  configError: unknown;
  profile: BusinessProfile;
  profileDirty: boolean;
}

function sourceHref(url: string) {
  try { return new URL(url).protocol === "https:" ? url : undefined; }
  catch { return undefined; }
}

function DraftReview({ job, config, profile, blocked, onApply, applying }: {
  job: WebsiteSetupJob;
  config: AiAgentConfig | null;
  profile: BusinessProfile;
  blocked: boolean;
  onApply: (fields: string[], expectedVersion: string | null) => Promise<void>;
  applying: boolean;
}) {
  const [baseline] = useState(config?.updated_at ?? null);
  const [fields] = useState(() => draftFields(job.result!, profile, config?.agent_behavior ?? {}));
  const [selected, setSelected] = useState(() => fields.filter((field) => field.selected).map((field) => field.path));
  const changed = baseline !== (config?.updated_at ?? null);
  const coverage = job.result!.coverage;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {coverage.pages} page{coverage.pages === 1 ? "" : "s"} reviewed · {coverage.mode === "page" ? "Single page only" : "Website crawl"}
        {coverage.truncated && " · Partial coverage: some content was outside the extraction limit"}
      </p>
      <p className="text-sm">Choose the fields to save. Existing values are kept unless you select their replacement.</p>
      <div className="space-y-3">
        {fields.map((field) => (
          <div key={field.path} className="rounded-lg border p-3 space-y-2">
            <label className="flex items-center gap-2 font-medium text-sm">
              <Checkbox
                checked={selected.includes(field.path)}
                disabled={!field.proposed || field.proposed === field.current || applying || blocked || changed}
                onCheckedChange={(checked) => setSelected((previous) => checked === true
                  ? [...previous, field.path] : previous.filter((path) => path !== field.path))}
              />
              {field.label}
              {field.suggestion && <Badge variant="secondary">Suggestion</Badge>}
            </label>
            {field.current && <div className="text-sm text-muted-foreground whitespace-pre-wrap"><strong>Current:</strong> {field.current}</div>}
            <p className="text-sm whitespace-pre-wrap">{field.proposed || (field.suggestion ? "No suggestion" : "Not found on website")}</p>
            {field.evidence.filter(sourceHref).map((url) => (
              <a key={url} href={url} target="_blank" rel="noopener noreferrer" className="block break-all text-xs text-primary underline">{url}</a>
            ))}
          </div>
        ))}
      </div>
      {changed && <p role="alert" className="text-sm text-destructive">Settings changed while you reviewed this draft. Reopen the review to compare with the latest values.</p>}
      {blocked && <p role="alert" className="text-sm text-destructive">Save your manual profile edits before applying this draft.</p>}
      <p className="text-xs text-muted-foreground">Agent activation, access, handoff rules and limits stay as configured.</p>
      <Button disabled={blocked || changed || applying || selected.length === 0} onClick={() => void onApply(selected, baseline)}>
        {applying ? "Saving selected fields…" : "Apply selected fields"}
      </Button>
    </div>
  );
}

export function WebsiteSetupDrafts({ platform, accountId, sources, config, configError, profile, profileDirty }: WebsiteSetupDraftsProps) {
  const setup = useWebsiteSetup(platform, accountId);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [indexingError, setIndexingError] = useState<string | null>(null);
  const jobs = setup.error ? [] : setup.data ?? [];
  const runAction = async (action: () => Promise<unknown>, success: string) => {
    try { await action(); toast.success(success); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Website setup failed"); }
  };
  const reusableSources = sources.filter((source) => source.source_type === "website" && source.status === "ready"
    && !jobs.some((job) => job.source_id === source.id));
  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>Business and agent setup drafts</CardTitle>
        <CardDescription>Generated from website knowledge for the selected account. Review facts and suggestions before applying.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {indexingError && <p role="alert" className="text-sm text-destructive">{indexingError}</p>}
        {setup.isLoading && <p role="status">Loading setup drafts…</p>}
        {setup.error && <div role="alert" className="space-y-2">
          <p>Could not load setup drafts: {setup.error.message}</p>
          <Button variant="outline" onClick={() => void setup.refetch()}>Retry loading drafts</Button>
        </div>}
        {configError && <p role="alert">Could not load the current settings. Draft application is unavailable until they load.</p>}
        {!setup.isLoading && !setup.error && jobs.length === 0 && <p className="text-sm text-muted-foreground">No setup drafts yet. Scrape a website with setup generation enabled, or use indexed website knowledge below.</p>}
        {jobs.map((job) => (
          <section key={job.id} className="space-y-3 rounded-lg border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="font-medium">{sources.find((source) => source.id === job.source_id)?.file_name || "Website setup"}</h4>
              <Badge variant={job.status === "failed" ? "destructive" : "secondary"}>{job.status}</Badge>
            </div>
            {job.status === "pending" && <p role="status" className="text-sm">Waiting for website indexing and draft generation.</p>}
            {job.status === "processing" && <p role="status" className="text-sm">Extracting business details and preparing suggestions…</p>}
            {job.status === "failed" && <div className="space-y-2">
              <p role="alert" className="text-sm">{job.error || "Draft generation failed"}</p>
              <Button variant="outline" disabled={setup.retry.isPending} onClick={() => void runAction(() => setup.retry.mutateAsync(job.id), "Setup draft queued again")}>Retry setup generation</Button>
            </div>}
            {job.status === "applied" && <p className="text-sm">Reviewed fields were saved. You can edit them in Manual profile and Settings.</p>}
            {job.status === "ready" && job.result && <>
              <Button variant="outline" disabled={config === undefined || !!configError} onClick={() => setReviewId(reviewId === job.id ? null : job.id)}>
                {reviewId === job.id ? "Close review" : "Review generated setup"}
              </Button>
              {reviewId === job.id && config !== undefined && !configError && <DraftReview
                key={`${accountId}:${job.id}:${job.updated_at}`} job={job} config={config} profile={profile}
                blocked={profileDirty} applying={setup.apply.isPending}
                onApply={(fields, expectedVersion) => runAction(async () => {
                  const response = await setup.apply.mutateAsync({ job_id: job.id, fields, expected_config_updated_at: expectedVersion });
                  setIndexingError(response.profile_indexing?.status === "failed"
                    ? "Settings were saved, but profile indexing failed. Open Manual profile and use Save & index to retry. Website knowledge remains available."
                    : null);
                  setReviewId(null);
                }, "Selected business and agent settings saved")}
              />}
            </>}
          </section>
        ))}
        {!setup.error && reusableSources.map((source) => (
          <div key={source.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
            <span className="text-sm">{source.file_name}</span>
            <Button variant="outline" disabled={setup.request.isPending} onClick={() => void runAction(() => setup.request.mutateAsync(source.id), "Setup generation queued from existing knowledge")}>Generate setup from indexed website</Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
