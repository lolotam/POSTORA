import {
  aggregateUsage,
  formatUsageLine,
  usageRowsForType,
  useConnectorUsage,
  useConnectorWorkspace,
} from "@/features/connectors";

interface ConnectorUsageLineProps {
  /** Owning workspace; null while it is still unknown. */
  workspaceId: string | null;
  /** Usage for one configured tool. */
  toolId?: string;
  /** Usage for every tool of one connector type — what a connection card
   *  spans, since one connection can back several tools. */
  connectorType?: string;
  days?: number;
}

/**
 * "142 calls · 30 d · p50 640 ms" under a connector (spec §9.1). Every line on
 * the page shares one `workspace_connector_usage` query per (workspace,
 * window), so the count of lines never becomes a count of requests.
 */
export function ConnectorUsageLine({ workspaceId, toolId, connectorType, days = 30 }: ConnectorUsageLineProps) {
  const usage = useConnectorUsage(workspaceId, days);
  // An unresolved or failed read is not "no calls": say nothing rather than
  // state a number that is not known to be true.
  if (workspaceId === null || usage.isLoading || usage.error) return null;

  const rows = usage.data ?? [];
  const row = toolId !== undefined
    ? rows.find((candidate) => candidate.tool_id === toolId)
    : aggregateUsage(usageRowsForType(rows, connectorType ?? ""));

  return (
    <p className="text-[11px] text-muted-foreground" data-testid="connector-usage-line">
      {formatUsageLine(row, days)}
    </p>
  );
}

/**
 * The usage line for a tool whose workspace is not already known — the
 * Settings overview lists tools from several accounts, and usage is scoped
 * per workspace. One workspace lookup per account, shared by the cache.
 */
export function ToolUsageLine({
  accountId,
  toolId,
  days = 30,
}: {
  accountId: string | null;
  toolId: string;
  days?: number;
}) {
  const { workspaceId } = useConnectorWorkspace(accountId);
  return <ConnectorUsageLine workspaceId={workspaceId} toolId={toolId} days={days} />;
}
