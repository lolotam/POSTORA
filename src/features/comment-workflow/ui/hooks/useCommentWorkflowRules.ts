import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { CommentWorkflowRuleInput } from "../../domain/rule";
import {
  createRule,
  deleteRule,
  fetchRules,
  fetchStats,
  updateRule,
} from "../../infrastructure/commentWorkflowApi";

const ROOT = ["comment-workflow"] as const;

export const commentWorkflowKeys = {
  rules: [...ROOT, "rules"] as const,
  stats: [...ROOT, "stats"] as const,
};

export function useCommentWorkflowRules() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: commentWorkflowKeys.rules });
    queryClient.invalidateQueries({ queryKey: commentWorkflowKeys.stats });
  };

  const { data: rules = [], isLoading, isError } = useQuery({
    queryKey: commentWorkflowKeys.rules,
    queryFn: fetchRules,
  });

  const create = useMutation({
    mutationFn: (input: CommentWorkflowRuleInput) => createRule(input),
    onSuccess: () => {
      invalidate();
      toast.success("Workflow created");
    },
    onError: (error: Error) => toast.error(`Could not create the workflow: ${error.message}`),
  });

  const update = useMutation({
    mutationFn: ({ id, ...input }: Partial<CommentWorkflowRuleInput> & { id: string }) =>
      updateRule(id, input),
    onSuccess: () => {
      invalidate();
      toast.success("Workflow updated");
    },
    onError: (error: Error) => toast.error(`Could not update the workflow: ${error.message}`),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteRule(id),
    onSuccess: () => {
      invalidate();
      toast.success("Workflow deleted");
    },
    onError: (error: Error) => toast.error(`Could not delete the workflow: ${error.message}`),
  });

  const setActive = useMutation({
    mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) => updateRule(id, { is_active }),
    onSuccess: invalidate,
    onError: (error: Error) => toast.error(`Could not change the workflow: ${error.message}`),
  });

  return { rules, isLoading, isError, create, update, remove, setActive };
}

export function useCommentWorkflowStats() {
  // Counters move whenever a comment lands, and nothing pushes them, so the pool re-reads on a
  // slow interval rather than looking stale until a reload.
  const { data = [], isLoading, isError } = useQuery({
    queryKey: commentWorkflowKeys.stats,
    queryFn: fetchStats,
    refetchInterval: 30_000,
  });

  const statsByRule = Object.fromEntries(
    data.filter((row) => row.rule_id !== null).map((row) => [row.rule_id as string, row]),
  );

  // isError is returned, not swallowed. A failed read leaves `data` empty, and rendering that
  // as zeros would tell someone their live funnels had never fired -- indistinguishable from
  // genuine inactivity, and the more alarming of the two readings.
  return { statsByRule, isLoading, isError };
}
