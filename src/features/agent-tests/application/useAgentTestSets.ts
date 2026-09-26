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
import { runSavedTests } from "./runSavedTests";
import type { CaseResult, RunStatus, TestCase, TestExpectation } from "../domain/types";

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
      if (input.id) return updateTestCase(input.id, { message: input.message, expected: input.expected });
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
    mutationFn: (id: string) => deleteTestCase(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: casesKey(user?.id, accountId, platform) });
    },
  });
}

export interface LiveRun {
  runId: string;
  status: RunStatus;
  results: CaseResult[];
}

export function useRunAllTests(accountId: string | null, platform: string) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [live, setLive] = useState<LiveRun | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setLive(null);
    return () => abortRef.current?.abort();
  }, [accountId, platform]);

  const run = async (cases: TestCase[]) => {
    if (!user || !accountId) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setProgress({ current: 1, total: Math.min(cases.length, 25) });
    try {
      const finished = await runSavedTests({
        cases,
        platform,
        accountId,
        signal: controller.signal,
        onProgress: (current, total) => setProgress({ current, total }),
        createRun: () => insertRun({ userId: user.id, socialAccountId: accountId, platform }),
        updateRun,
        deleteThreads: (conversationIds) => deleteRunThreads({ userId: user.id, platform, conversationIds }),
        runCase: (input) => runTestCase({ ...input, platform, socialAccountId: accountId }),
      });
      setLive({ runId: finished.id, status: finished.status, results: finished.results });
      await queryClient.invalidateQueries({ queryKey: runsKey(user.id, accountId, platform) });
    } catch (error) {
      console.error(`[agent-tests] run failed: ${error instanceof Error ? error.name : "Error"}`);
    } finally {
      setProgress(null);
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  return { run, progress, live, running: progress !== null };
}
