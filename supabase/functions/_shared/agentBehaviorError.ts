// Dependency-free so procedure config can throw it without importing agentBehavior.ts.
export class AgentBehaviorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentBehaviorError";
  }
}
