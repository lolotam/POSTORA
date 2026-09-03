import { Navigate, useSearchParams } from "react-router-dom";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { WorkflowPool, WorkflowRuleForm } from "@/features/comment-workflow";

type Tab = "pool" | "create";

/** Composition only. Everything it shows lives in the comment-workflow feature. */
export default function CommentWorkflowPage() {
  const { flags, isLoading } = useFeatureFlags();
  const [params, setParams] = useSearchParams();

  const tab: Tab = params.get("tab") === "create" ? "create" : "pool";
  const editingRuleId = params.get("rule");

  if (!isLoading && !flags.commentWorkflow) return <Navigate to="/automation" replace />;

  const go = (next: Tab, ruleId?: string) =>
    setParams(
      (previous) => {
        const updated = new URLSearchParams(previous);
        updated.set("tab", next);
        if (ruleId) updated.set("rule", ruleId);
        else updated.delete("rule");
        return updated;
      },
      { replace: true },
    );

  return (
    <DashboardLayout>
      <div className="w-full space-y-6 pb-12">
        <header className="space-y-1">
          <h1 className="text-2xl font-bold">Comment Workflow</h1>
          <p className="text-sm text-muted-foreground">
            Turn comments into conversations. A keyword under your post gets a public reply and,
            on Facebook and Instagram, one private message with your link.
          </p>
        </header>

        <Tabs value={tab} onValueChange={(next) => go(next as Tab)}>
          <TabsList>
            <TabsTrigger value="pool">Workflows</TabsTrigger>
            <TabsTrigger value="create">{editingRuleId ? "Edit workflow" : "Create workflow"}</TabsTrigger>
          </TabsList>

          <TabsContent value="pool" className="mt-4">
            <WorkflowPool onCreate={() => go("create")} onEdit={(id) => go("create", id)} />
          </TabsContent>

          <TabsContent value="create" className="mt-4">
            <WorkflowRuleForm ruleId={editingRuleId} onDone={() => go("pool")} />
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
