import { callEdgeApi } from "@/lib/messagingApi";

export function callAiKnowledgeApi(action: string, body: Record<string, unknown>) {
  return callEdgeApi("ai-knowledge-ingest", action, body);
}
