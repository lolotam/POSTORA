import { useQuery } from "@tanstack/react-query";
import { fetchWorkspaceUsage } from "../../infrastructure/connectorsApi";
import { connectorKeys } from "./useConnectorConnections";

/** Per-tool call counts for a workspace over the last `days`. One query per
 *  (workspace, window), shared by every usage line on the page. */
export function useConnectorUsage(workspaceId: string | null, days = 30) {
  return useQuery({
    queryKey: connectorKeys.usage(workspaceId ?? "", days),
    queryFn: () => fetchWorkspaceUsage(workspaceId as string, days),
    enabled: workspaceId !== null,
  });
}
