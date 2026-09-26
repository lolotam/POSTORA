import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import {
  deleteRunThreads,
  deleteTestCase,
  insertRun,
  insertTestCase,
  listTestCases,
  listTestRuns,
  runTestCase,
  updateRun,
  updateTestCase,
} from "../infrastructure/testCasesApi";
import { runSavedTests } from "../application/runSavedTests";
import { MAX_CASES_PER_RUN, type CaseResult, type RunStatus, type TestCase, type TestExpectation } from "../domain/types";

function casesKey(userId: string | undefined, accountId: string | null, platform: string) {
  return ["ai-agent-test-cases", userId, accountId, platform] as const;
}

function runsKey(userId: string | undefined, accountId: string | null, platform: string) {
  return ["ai-agent-test-runs", userId, accountId, platform] as const;
}

export function useAgentTestCases(accountId: string | null, platform: string) {
  const { user } = useAuth();
  return useQuery({
    queryKey: casesKey(user?.id, accountId, platform),
    queryFn: () => listTestCases(accountId!, platform),
    enabled: !!user && !!accountId,
  });
}

export function useAgentTestRuns(accountId: string | null, platform: string) {
  const { user } = useAuth();
  return useQuery({
    queryKey: runsKey(user?.id, accountId, platform),
    queryFn: () => listTestRuns(accountId!, platform),
    enabled: !!user && !!accountId,
  });
}

export function useSaveTestCase(accountId: string | null, platform: string) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id?: string; message: string; expected: TestExpectation; position: number }) => {
      if (!user || !accountId) throw new Error("NotSignedIn");
      if (input.id) {
        return updateTestCase(input.id, {
          message: input.message,
          expected: input.expected,
          socialAccountId: accountId,
          platform,
        });
      }
      return insertTestCase({
        userId: user.id,
        socialAccountId: accountId,
        platform,
        message: input.message,
        expected: input.expected,
        position: input.position,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: casesKey(user?.id, accountId, platform) });
    },
  });
}

export function useDeleteTestCase(accountId: string | null, platform: string) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => {
      if (!accountId) throw new Error("NotSignedIn");
      return deleteTestCase(id, { socialAccountId: accountId, platform });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: casesKey(user?.id, accountId, platform) });
    },
  });
}

export interface LiveRun {
  runId: string;
  status: RunStatus;
  results: CaseResult[];
  savedOk: boolean;
}

export function useRunAllTests(accountId: string | null, platform: string) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [live, setLive] = useState<LiveRun | null>(null);
  const [error, setError] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // Account changes and later runs bump this so an older run cannot write their state.
  const invocationRef = useRef(0);
  const accountKey = `${accountId ?? ""}:${platform}`;
  const accountKeyRef = useRef(accountKey);
  accountKeyRef.current = accountKey;

  useEffect(() => {
    invocationRef.current += 1;
    setLive(null);
    setProgress(null);
    setError(false);
    return () => abortRef.current?.abort();
  }, [accountId, platform]);

  const run = async (cases: TestCase[]) => {
    if (!user || !accountId) return;
    const invocation = ++invocationRef.current;
    const startedKey = `${accountId}:${platform}`;
    const controller = new AbortController();
    abortRef.current = controller;
    const current = () => invocationRef.current === invocation && accountKeyRef.current === startedKey;
    setError(false);
    setProgress({ current: 1, total: Math.min(cases.length, MAX_CASES_PER_RUN) });
    try {
      const finished = await runSavedTests({
        cases,
        platform,
        accountId,
        signal: controller.signal,
        onProgress: (done, total) => {
          if (current()) setProgress({ current: done, total });
        },
        createRun: () => insertRun({ userId: user.id, socialAccountId: accountId, platform }),
        updateRun,
        deleteThreads: (conversationIds) => deleteRunThreads({ userId: user.id, platform, conversationIds }),
        runCase: (input) => runTestCase({ ...input, platform, socialAccountId: accountId }),
      });
      if (!current()) return;
      setLive({
        runId: finished.id,
        status: finished.status,
        results: finished.results,
        savedOk: finished.savedOk,
      });
      await queryClient.invalidateQueries({ queryKey: runsKey(user.id, accountId, platform) });
    } catch (caught) {
      console.error(`[agent-tests] run failed: ${caught instanceof Error ? caught.name : "Error"}`);
      if (current()) setError(true);
    } finally {
      if (current()) setProgress(null);
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  return { run, progress, live, running: progress !== null, error };
}
