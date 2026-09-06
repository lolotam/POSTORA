// Turns the sweep outcome recorded on whatsapp_evolution_instances.last_sync_outcome into
// the toast the setup page shows after "Sync past chats".

export interface SyncOutcomeView {
  finished_at: string;
  error?: string;
  chatsImported?: number;
  messagesWritten?: number;
  chatsAwaitingLid?: number;
  chatsLidResolved?: number;
  truncated?: boolean;
}

export interface SyncOutcomeToast {
  title: string;
  description: string;
  variant: "default" | "destructive";
}

export function describeSyncOutcome(outcome: SyncOutcomeView): SyncOutcomeToast {
  if (outcome.error) return { title: "Import failed", description: outcome.error, variant: "destructive" };
  const parts = [`${outcome.chatsImported ?? 0} chats, ${outcome.messagesWritten ?? 0} messages.`];
  if (outcome.truncated) parts.push("Run again to continue.");
  if ((outcome.chatsAwaitingLid ?? 0) > 0) {
    parts.push(`${outcome.chatsAwaitingLid} chats are waiting for a first message from the contact.`);
  }
  return {
    title: outcome.truncated ? "Partial import" : "Chats imported",
    description: parts.join(" "),
    variant: "default",
  };
}
