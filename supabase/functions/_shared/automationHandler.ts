export type AutomationHandler = "internal" | "n8n";

export function resolveAutomationHandler(metadata: unknown): AutomationHandler {
  if (!metadata || typeof metadata !== "object") return "internal";
  return (metadata as Record<string, unknown>).automation_handler === "n8n" ? "n8n" : "internal";
}
