import type { YouTubeBenchmarkSuccess } from "../domain/types";

// The port the query hook depends on (ARCHITECTURE.md §4: application never
// imports infrastructure; the adapter arrives as this interface).
export interface YouTubeBenchmarkGateway {
  /**
   * Reads the public figures of one to three named channels.
   *
   * `accountId` is the caller's OWN native YouTube connection: it supplies
   * the read-only credential and is never a lookup target. The channels are
   * the handles or channel ids the creator typed.
   */
  lookupChannels(params: { accountId: string; channels: string[] }): Promise<YouTubeBenchmarkSuccess>;
}
