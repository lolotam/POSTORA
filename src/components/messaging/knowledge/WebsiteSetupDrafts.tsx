import { useState } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n";
import type { TFunction } from "i18next";
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

function draftFieldLabel(path: string, fallback: string, t: TFunction): string {
  switch (path) {
    case "business_profile.industry": return t("knowledge.businessType", fallback);
    case "business_profile.products": return t("knowledge.products", fallback);
    case "business_profile.policies.returns": return t("knowledge.policyReturns", fallback);
    case "business_profile.policies.shipping": return t("knowledge.policyShipping", fallback);
    case "business_profile.policies.warranty": return t("knowledge.policyWarranty", fallback);
    case "business_profile.policies.payment_methods": return t("knowledge.policyPayment", fallback);
    case "business_profile.policies.delivery": return t("knowledge.policyDelivery", fallback);
    case "business_profile.policies.booking": return t("knowledge.policyBooking", fallback);
    case "business_profile.policies.cancellation": return t("knowledge.policyCancellation", fallback);
    case "business_profile.policies.opening_hours": return t("knowledge.policyHours", fallback);
    case "business_profile.policies.menu": return t("knowledge.policyMenu", fallback);
    case "business_profile.policies.insurance": return t("knowledge.policyInsurance", fallback);
    case "business_profile.policies.service_area": return t("knowledge.policyServiceArea", fallback);
    case "business_profile.policies.leasing": return t("knowledge.policyLeasing", fallback);
    case "business_profile.faqs": return t("knowledge.faqs", fallback);
    case "business_profile.notes": return t("knowledge.notes", fallback);
    case "agent_behavior.tone": return t("identity.toneOfVoice", fallback);
    case "agent_behavior.response_length": return t("identity.replyLength", fallback);
    case "agent_behavior.goals": return t("knowledge.objectives", fallback);
    case "agent_behavior.greeting": return t("guardrails.openingMessage", fallback);
    case "agent_behavior.instruction_blocks": return t("knowledge.websiteInstructionBlocks", fallback);
    default: return fallback;
  }
}

function jobStatusLabel(status: WebsiteSetupJob["status"], t: TFunction): string {
  switch (status) {
    case "pending": return t("common:status.pending", "pending");
    case "processing": return t("common:status.processing", "processing");
    case "failed": return t("common:status.failed", "failed");
    case "ready": return t("knowledge.statusReady", "ready");
    case "applied": return t("knowledge.statusApplied", "applied");
  }
}

function DraftReview({ job, config, profile, blocked, onApply, applying }: {
  job: WebsiteSetupJob;
  config: AiAgentConfig | null;
  profile: BusinessProfile;
  blocked: boolean;
  onApply: (fields: string[], expectedVersion: string | null) => Promise<void>;
  applying: boolean;
}) {
  const { t } = useTranslation("agent");
  const [baseline] = useState(config?.updated_at ?? null);
  const [fields] = useState(() => draftFields(job.result!, profile, config?.agent_behavior ?? {}));
  const [selected, setSelected] = useState(() => fields.filter((field) => field.selected).map((field) => field.path));
  const changed = baseline !== (config?.updated_at ?? null);
  const coverage = job.result!.coverage;
  const coverageMode = coverage.mode === "page"
    ? t("knowledge.singlePage", "Single page only")
    : t("knowledge.websiteCrawl", "Website crawl");
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {coverage.pages === 1
          ? t("knowledge.coverageOne", "{{count}} page reviewed · {{mode}}", { count: coverage.pages, mode: coverageMode })
          : t("knowledge.coverageMany", "{{count}} pages reviewed · {{mode}}", { count: coverage.pages, mode: coverageMode })}
        {coverage.truncated && t("knowledge.partialCoverage", " · Partial coverage: some content was outside the extraction limit")}
      </p>
      <p className="text-sm">{t("knowledge.draftChoose", "Choose the fields to save. Existing values are kept unless you select their replacement.")}</p>
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
              {draftFieldLabel(field.path, field.label, t)}
              {field.suggestion && <Badge variant="secondary">{t("knowledge.suggestion", "Suggestion")}</Badge>}
            </label>
            {field.current && <div className="text-sm text-muted-foreground whitespace-pre-wrap"><strong>{t("knowledge.current", "Current:")}</strong> {field.current}</div>}
            <p className="text-sm whitespace-pre-wrap">{field.proposed || (field.suggestion ? t("knowledge.noSuggestion", "No suggestion") : t("knowledge.notFoundOnSite", "Not found on website"))}</p>
            {field.evidence.filter(sourceHref).map((url) => (
              <a key={url} href={url} target="_blank" rel="noopener noreferrer" className="block break-all text-xs text-primary underline">{url}</a>
            ))}
          </div>
        ))}
      </div>
      {changed && <p role="alert" className="text-sm text-destructive">{t("knowledge.settingsChanged", "Settings changed while you reviewed this draft. Reopen the review to compare with the latest values.")}</p>}
      {blocked && <p role="alert" className="text-sm text-destructive">{t("knowledge.saveDraftFirst", "Save your manual profile edits before applying this draft.")}</p>}
      <p className="text-xs text-muted-foreground">{t("knowledge.keepUnchanged", "Agent activation, access, handoff rules and limits stay as configured.")}</p>
      <Button disabled={blocked || changed || applying || selected.length === 0} onClick={() => void onApply(selected, baseline)}>
        {applying ? t("knowledge.saveSelected", "Saving selected fields…") : t("knowledge.applyFields", "Apply selected fields")}
      </Button>
    </div>
  );
}

export function WebsiteSetupDrafts({ platform, accountId, sources, config, configError, profile, profileDirty }: WebsiteSetupDraftsProps) {
  const { t } = useTranslation("agent");
  const setup = useWebsiteSetup(platform, accountId);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [indexingError, setIndexingError] = useState<string | null>(null);
  const jobs = setup.error ? [] : setup.data ?? [];
  const runAction = async (action: () => Promise<unknown>, success: string) => {
    try { await action(); toast.success(success); }
    catch (error) { toast.error(error instanceof Error ? error.message : t("toast.setupFailed", "Website setup failed")); }
  };
  const reusableSources = sources.filter((source) => source.source_type === "website" && source.status === "ready"
    && !jobs.some((job) => job.source_id === source.id));
  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>{t("knowledge.draftTitle", "Business and agent setup drafts")}</CardTitle>
        <CardDescription>{t("knowledge.draftDescription", "Generated from website knowledge for the selected account. Review facts and suggestions before applying.")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {indexingError && <p role="alert" className="text-sm text-destructive">{indexingError}</p>}
        {setup.isLoading && <p role="status">{t("knowledge.loadDrafts", "Loading setup drafts…")}</p>}
        {setup.error && <div role="alert" className="space-y-2">
          <p>{t("knowledge.draftLoadError", "Could not load setup drafts: {{message}}", { message: setup.error.message })}</p>
          <Button variant="outline" onClick={() => void setup.refetch()}>{t("knowledge.retryDrafts", "Retry loading drafts")}</Button>
        </div>}
        {configError && <p role="alert">{t("knowledge.loadSettingsError", "Could not load the current settings. Draft application is unavailable until they load.")}</p>}
        {!setup.isLoading && !setup.error && jobs.length === 0 && <p className="text-sm text-muted-foreground">{t("knowledge.draftEmpty", "No setup drafts yet. Scrape a website with setup generation enabled, or use indexed website knowledge below.")}</p>}
        {jobs.map((job) => (
          <section key={job.id} className="space-y-3 rounded-lg border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="font-medium">{sources.find((source) => source.id === job.source_id)?.file_name || t("knowledge.websiteFallback", "Website setup")}</h4>
              <Badge variant={job.status === "failed" ? "destructive" : "secondary"}>{jobStatusLabel(job.status, t)}</Badge>
            </div>
            {job.status === "pending" && <p role="status" className="text-sm">{t("knowledge.waitingJob", "Waiting for website indexing and draft generation.")}</p>}
            {job.status === "processing" && <p role="status" className="text-sm">{t("knowledge.processingJob", "Extracting business details and preparing suggestions…")}</p>}
            {job.status === "failed" && <div className="space-y-2">
              <p role="alert" className="text-sm">{job.error || t("knowledge.draftFailed", "Draft generation failed")}</p>
              <Button variant="outline" disabled={setup.retry.isPending} onClick={() => void runAction(() => setup.retry.mutateAsync(job.id), t("toast.draftQueuedAgain", "Setup draft queued again"))}>{t("knowledge.retrySetup", "Retry setup generation")}</Button>
            </div>}
            {job.status === "applied" && <p className="text-sm">{t("knowledge.readyHint", "Reviewed fields were saved. You can edit them in Manual profile and Settings.")}</p>}
            {job.status === "ready" && job.result && <>
              <Button variant="outline" disabled={config === undefined || !!configError} onClick={() => setReviewId(reviewId === job.id ? null : job.id)}>
                {reviewId === job.id ? t("knowledge.closeReview", "Close review") : t("knowledge.reviewDraft", "Review generated setup")}
              </Button>
              {reviewId === job.id && config !== undefined && !configError && <DraftReview
                key={`${accountId}:${job.id}:${job.updated_at}`} job={job} config={config} profile={profile}
                blocked={profileDirty} applying={setup.apply.isPending}
                onApply={(fields, expectedVersion) => runAction(async () => {
                  const response = await setup.apply.mutateAsync({ job_id: job.id, fields, expected_config_updated_at: expectedVersion });
                  setIndexingError(response.profile_indexing?.status === "failed"
                    ? t("toast.profileIndexingFailed", "Settings were saved, but profile indexing failed. Open Manual profile and use Save & index to retry. Website knowledge remains available.")
                    : null);
                  setReviewId(null);
                }, t("toast.selectedSaved", "Selected business and agent settings saved"))}
              />}
            </>}
          </section>
        ))}
        {!setup.error && reusableSources.map((source) => (
          <div key={source.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
            <span className="text-sm">{source.file_name}</span>
            <Button variant="outline" disabled={setup.request.isPending} onClick={() => void runAction(() => setup.request.mutateAsync(source.id), t("toast.setupQueuedFromKnowledge", "Setup generation queued from existing knowledge"))}>{t("knowledge.generateSetupFromSite", "Generate setup from indexed website")}</Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
