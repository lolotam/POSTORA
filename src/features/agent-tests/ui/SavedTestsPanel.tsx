import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n";
import { Loader2, Play } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { compareRuns, displayRunStatus } from "../domain/evaluateTestCase";
import { TEST_INTENTS, testCaseInputSchema, STALE_RUN_MS, type CaseResult, type TestCase, type TestExpectation } from "../domain/types";
import { useAgentTestCases, useAgentTestRuns, useDeleteTestCase, useRunAllTests, useSaveTestCase } from "../application/useAgentTestSets";

interface CaseForm {
  message: string;
  intent: string;
  connector: string;
  contains: string;
  avoids: string;
  handoff: "" | "yes" | "no";
}

const emptyForm = (message = ""): CaseForm => ({
  message,
  intent: "",
  connector: "",
  contains: "",
  avoids: "",
  handoff: "",
});

function lines(value: string): string[] | undefined {
  const items = value.split("\n").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function expectationFromForm(form: CaseForm): TestExpectation {
  return {
    ...(form.intent ? { intent: form.intent as TestExpectation["intent"] } : {}),
    ...(form.connector.trim() ? { connector: form.connector.trim() } : {}),
    ...(lines(form.contains) ? { contains: lines(form.contains) } : {}),
    ...(lines(form.avoids) ? { avoids: lines(form.avoids) } : {}),
    ...(form.handoff === "yes" ? { escalates: true } : {}),
    ...(form.handoff === "no" ? { escalates: false } : {}),
  };
}

function formFromCase(testCase: TestCase): CaseForm {
  return {
    message: testCase.message,
    intent: testCase.expected.intent ?? "",
    connector: testCase.expected.connector ?? "",
    contains: (testCase.expected.contains ?? []).join("\n"),
    avoids: (testCase.expected.avoids ?? []).join("\n"),
    handoff: testCase.expected.escalates === true ? "yes" : testCase.expected.escalates === false ? "no" : "",
  };
}

function verdictLabel(verdict: CaseResult["verdict"], t: (key: string, fallback: string) => string): string {
  if (verdict === "passed") return t("test.saved.passed", "Passed");
  if (verdict === "failed") return t("test.saved.failed", "Failed");
  if (verdict === "errored") return t("test.saved.errored", "Errored");
  if (verdict === "indeterminate") return t("test.saved.indeterminate", "Indeterminate");
  return t("test.saved.noAssertions", "no assertions");
}

export function SavedTestsPanel({
  platform,
  accountId,
  prefillMessage,
  onPrefillHandled,
}: {
  platform: string;
  accountId?: string | null;
  prefillMessage?: string | null;
  onPrefillHandled?: () => void;
}) {
  const { t } = useTranslation("agent");
  const account = accountId ?? null;
  const casesQuery = useAgentTestCases(account, platform);
  const runsQuery = useAgentTestRuns(account, platform);
  const saveCase = useSaveTestCase(account, platform);
  const removeCase = useDeleteTestCase(account, platform);
  const runner = useRunAllTests(account, platform);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<CaseForm>(emptyForm());
  const [formError, setFormError] = useState(false);
  const scopeKey = `${account ?? ""}:${platform}`;
  const seenScope = useRef(scopeKey);

  useEffect(() => {
    if (seenScope.current === scopeKey) return;
    seenScope.current = scopeKey;
    setOpen(false);
    setEditingId(null);
    setForm(emptyForm());
    setFormError(false);
  }, [scopeKey]);

  useEffect(() => {
    if (!prefillMessage) return;
    setEditingId(null);
    setForm(emptyForm(prefillMessage));
    setFormError(false);
    setOpen(true);
    onPrefillHandled?.();
  }, [prefillMessage, onPrefillHandled]);

  const cases = casesQuery.data ?? [];
  const runs = runsQuery.data ?? [];
  const latestStored = runs[0] ?? null;
  const shownResults = runner.live?.results ?? latestStored?.results ?? null;
  const shownStatus = runner.live
    ? runner.live.status
    : latestStored
      ? displayRunStatus(latestStored.status, latestStored.startedAt, Date.now(), STALE_RUN_MS)
      : null;
  const completed = runs.filter((run) => run.status === "completed");
  const currentId = runner.live?.runId ?? (latestStored?.status === "completed" ? latestStored.id : null);
  const currentIndex = currentId ? completed.findIndex((run) => run.id === currentId) : -1;
  const previous = currentIndex >= 0 ? completed[currentIndex + 1] ?? null : null;
  const comparison = compareRuns(previous?.results ?? null, shownResults ?? []);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm());
    setFormError(false);
    setOpen(true);
  };

  const openEdit = (testCase: TestCase) => {
    setEditingId(testCase.id);
    setForm(formFromCase(testCase));
    setFormError(false);
    setOpen(true);
  };

  const submit = () => {
    const parsed = testCaseInputSchema.safeParse({
      message: form.message,
      expected: expectationFromForm(form),
    });
    if (!parsed.success) {
      setFormError(true);
      return;
    }
    const position = editingId
      ? cases.find((testCase) => testCase.id === editingId)?.position ?? cases.length
      : cases.length;
    saveCase.mutate(
      { id: editingId ?? undefined, message: parsed.data.message, expected: parsed.data.expected, position },
      { onSuccess: () => setOpen(false) },
    );
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>{t("test.saved.title", "Saved tests")}</CardTitle>
            <CardDescription>
              {t("test.saved.smoke", "Live smoke testing. Results can change when the store, the model, or triage changes.")}
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={openCreate} disabled={!account}>
              {t("test.saved.add", "Add test")}
            </Button>
            <Button
              type="button"
              onClick={() => void runner.run(cases)}
              disabled={!account || runner.running || cases.length === 0}
            >
              {runner.running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {t("test.saved.runAll", "Run all")}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!account && <p className="text-sm text-muted-foreground">{t("test.saved.noAccount", "Choose an account to save tests for its agent.")}</p>}
        {casesQuery.isError && <p className="text-sm text-destructive">{t("test.saved.loadFailed", "Could not load saved tests.")}</p>}
        {runner.progress && (
          <p className="text-sm" data-testid="saved-tests-progress">
            {t("test.saved.running", "Running {{current}}/{{total}}…", { current: runner.progress.current, total: runner.progress.total })}
          </p>
        )}
        {cases.length > 25 && (
          <p className="text-sm text-muted-foreground">{t("test.saved.cap", "Only the first {{max}} cases run.", { max: 25 })}</p>
        )}
        {account && cases.length === 0 && !casesQuery.isLoading && (
          <p className="text-sm text-muted-foreground">{t("test.saved.empty", "No saved tests yet.")}</p>
        )}
        <ul className="space-y-2">
          {cases.map((testCase) => (
            <li key={testCase.id} className="rounded-md border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="text-sm">{testCase.message}</p>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => openEdit(testCase)}>
                    {t("test.saved.edit", "Edit")}
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => removeCase.mutate(testCase.id)}>
                    {t("test.saved.delete", "Delete")}
                  </Button>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {!testCase.expectationValid && <Badge variant="destructive">{t("test.saved.invalidChecks", "invalid checks")}</Badge>}
                {testCase.expected.intent && (
                  <Badge variant="outline">{t("test.saved.badgeIntent", "intent: {{intent}}", { intent: testCase.expected.intent })}</Badge>
                )}
                {testCase.expected.connector && (
                  <Badge variant="outline">{t("test.saved.badgeConnector", "connector called: {{name}}", { name: testCase.expected.connector })}</Badge>
                )}
                {testCase.expected.contains && testCase.expected.contains.length > 0 && (
                  <Badge variant="outline">{t("test.saved.badgeContains", "contains {{count}}", { count: testCase.expected.contains.length })}</Badge>
                )}
                {testCase.expected.avoids && testCase.expected.avoids.length > 0 && (
                  <Badge variant="outline">{t("test.saved.badgeAvoids", "avoids {{count}}", { count: testCase.expected.avoids.length })}</Badge>
                )}
                {testCase.expected.escalates !== undefined && (
                  <Badge variant="outline">{t("test.saved.badgeHandoff", "handoff")}</Badge>
                )}
                {testCase.expectationValid && Object.keys(testCase.expected).length === 0 && (
                  <Badge variant="secondary">{t("test.saved.noAssertions", "no assertions")}</Badge>
                )}
              </div>
            </li>
          ))}
        </ul>

        {shownResults && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium">{t("test.saved.results", "Results")}</h3>
            {runner.live?.savedOk === false && (
              <p className="text-sm text-destructive">
                {t("test.saved.saveFailed", "Results could not be saved; this run will show as interrupted after reload")}
              </p>
            )}
            {shownStatus === "interrupted" && (
              <p className="text-sm text-muted-foreground">{t("test.saved.interrupted", "Interrupted")}</p>
            )}
            {shownStatus === "completed" && (
              <p className="text-sm text-muted-foreground">{t("test.saved.completedStatus", "Completed")}</p>
            )}
            {(comparison.newlyFailing.length > 0 || comparison.newlyPassing.length > 0) && (
              <p className="text-sm">
                {t("test.saved.newlyFailing", "Newly failing: {{count}}", { count: comparison.newlyFailing.length })}
                {" · "}
                {t("test.saved.newlyPassing", "Newly passing: {{count}}", { count: comparison.newlyPassing.length })}
              </p>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-2 pr-2">{t("test.saved.colCase", "Case")}</th>
                    <th className="py-2 pr-2">{t("test.saved.colResult", "Result")}</th>
                    <th className="py-2 pr-2">{t("test.saved.colReasons", "Reasons")}</th>
                    <th className="py-2 pr-2">{t("test.saved.reply", "Reply")}</th>
                    <th className="py-2 pr-2">{t("test.saved.intent", "Intent")}</th>
                    <th className="py-2 pr-2">{t("test.saved.tools", "Tools")}</th>
                    <th className="py-2">{t("test.saved.handoff", "Handoff")}</th>
                  </tr>
                </thead>
                <tbody>
                  {shownResults.map((result) => {
                    const testCase = cases.find((item) => item.id === result.case_id);
                    return (
                      <tr key={result.case_id} className="border-b align-top">
                        <td className="py-2 pr-2">{testCase?.message ?? result.case_id}</td>
                        <td className="py-2 pr-2">{verdictLabel(result.verdict, t)}</td>
                        <td className="py-2 pr-2">{result.reasons.join("; ")}</td>
                        <td className="py-2 pr-2">{result.reply_excerpt ?? ""}</td>
                        <td className="py-2 pr-2">{result.intent ? `${result.intent.choice} (${result.intent_status ?? ""})` : (result.intent_status ?? "")}</td>
                        <td className="py-2 pr-2">{result.tool_calls.join(", ")}</td>
                        <td className="py-2">{result.escalated ? t("test.saved.handoffYes", "Yes") : t("test.saved.handoffNo", "No")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {runs.some((run) => displayRunStatus(run.status, run.startedAt, Date.now(), STALE_RUN_MS) === "interrupted" && run.status === "running") && (
          <p className="text-sm text-muted-foreground">{t("test.saved.runningStatus", "A run that is still marked running after 30 minutes is shown as interrupted.")}</p>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? t("test.saved.edit", "Edit") : t("test.saved.add", "Add test")}</DialogTitle>
            <DialogDescription>
              {t("test.saved.standalone", "This runs as a new customer, without earlier messages.")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="saved-test-message">{t("test.saved.message", "Customer message")}</Label>
              <Textarea id="saved-test-message" value={form.message} onChange={(event) => setForm({ ...form, message: event.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="saved-test-intent">{t("test.saved.intent", "Intent")}</Label>
              <select
                id="saved-test-intent"
                className="flex h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={form.intent}
                onChange={(event) => setForm({ ...form, intent: event.target.value })}
              >
                <option value="">{t("test.saved.intentAny", "No intent check")}</option>
                {TEST_INTENTS.map((intent) => <option key={intent} value={intent}>{intent}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="saved-test-connector">{t("test.saved.connector", "Connector called")}</Label>
              <Input
                id="saved-test-connector"
                value={form.connector}
                placeholder={t("test.saved.connectorHint", "woocommerce_store or none")}
                onChange={(event) => setForm({ ...form, connector: event.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="saved-test-contains">{t("test.saved.contains", "Reply must contain")}</Label>
              <Textarea
                id="saved-test-contains"
                value={form.contains}
                placeholder={t("test.saved.containsHint", "One phrase per line")}
                onChange={(event) => setForm({ ...form, contains: event.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="saved-test-avoids">{t("test.saved.avoids", "Reply must avoid")}</Label>
              <Textarea
                id="saved-test-avoids"
                value={form.avoids}
                placeholder={t("test.saved.avoidsHint", "One phrase per line")}
                onChange={(event) => setForm({ ...form, avoids: event.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="saved-test-handoff">{t("test.saved.escalates", "Handoff")}</Label>
              <select
                id="saved-test-handoff"
                className="flex h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={form.handoff}
                onChange={(event) => setForm({ ...form, handoff: event.target.value as CaseForm["handoff"] })}
              >
                <option value="">{t("test.saved.handoffAny", "No handoff check")}</option>
                <option value="yes">{t("test.saved.handoffYes", "Yes")}</option>
                <option value="no">{t("test.saved.handoffNo", "No")}</option>
              </select>
            </div>
            {formError && <p className="text-sm text-destructive">{t("test.saved.formInvalid", "Check the message length and the limits on each check.")}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>{t("test.saved.cancel", "Cancel")}</Button>
            <Button type="button" onClick={submit} disabled={saveCase.isPending}>{t("test.saved.save", "Save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
