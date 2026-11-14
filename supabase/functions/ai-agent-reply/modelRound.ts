/** One existing configured chain per round. A failed candidate never becomes
 * selected; the caller keeps the same transcript/tools for its next tier. */
export async function selectAgentCompletion<T>(options: {
  tiers: number;
  budget(): number;
  attempt(index: number, budgetMs: number): Promise<T>;
  failed(index: number, cause: unknown): Promise<void>;
}): Promise<{ completion: T; index: number } | { error: unknown }> {
  let lastError: unknown = null;
  for (let index = 0; index < options.tiers; index++) {
    const budget = options.budget();
    if (budget <= 0) {
      lastError = new Error("request budget exhausted before this model was tried");
      await options.failed(index, lastError);
      break;
    }
    try { return { completion: await options.attempt(index, budget), index }; }
    catch (cause) { lastError = cause; await options.failed(index, cause); }
  }
  return { error: lastError };
}
