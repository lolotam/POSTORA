export const MESSAGE_AUTOMATION_HANDLERS = ["internal", "n8n", "off"] as const;
export const COMMENT_AUTOMATION_HANDLERS = ["off", "internal", "n8n"] as const;

export type AutomationHandler = (typeof MESSAGE_AUTOMATION_HANDLERS)[number];
export type CommentAutomationHandler = (typeof COMMENT_AUTOMATION_HANDLERS)[number];

function readKey(metadata: unknown, key: string): unknown {
  if (!metadata || typeof metadata !== "object") return undefined;
  return (metadata as Record<string, unknown>)[key];
}

// Messages: "internal" (rules → AI agent) is the historical default.
export function resolveAutomationHandler(metadata: unknown): AutomationHandler {
  const value = readKey(metadata, "automation_handler");
  return (MESSAGE_AUTOMATION_HANDLERS as readonly unknown[]).includes(value) ? value as AutomationHandler : "internal";
}

// Comments: nothing automates comments unless the user opts in, so "off" is the default.
export function resolveCommentAutomationHandler(metadata: unknown): CommentAutomationHandler {
  const value = readKey(metadata, "comment_automation_handler");
  return (COMMENT_AUTOMATION_HANDLERS as readonly unknown[]).includes(value) ? value as CommentAutomationHandler : "off";
}
