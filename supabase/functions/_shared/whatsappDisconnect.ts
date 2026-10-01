// One teardown for every WhatsApp connection mode. Before this module existed the
// product's only disconnect path (whatsapp-oauth) spoke solely to the Meta Graph
// API, so an Evolution QR account was deactivated in Postora while its Baileys
// session stayed linked and kept receiving (and auto-replying to) messages.
import { clearUndeliveredSafely } from "./evolutionQrAccount.ts";
import type { EvolutionApi } from "./evolutionApi.ts";

const GRAPH_API = "https://graph.facebook.com/v22.0";

export type WhatsAppDisconnectStep = "ok" | "failed" | "skipped";

export interface WhatsAppDisconnectResult {
  /** true once the local social_accounts row is deactivated — the only mandatory step. */
  deactivated: boolean;
  evolution: WhatsAppDisconnectStep;
  graph: WhatsAppDisconnectStep;
  warnings: string[];
}

export interface WhatsAppDisconnectInput {
  accountId: string;
  /** Scopes the deactivation the same way whatsapp-oauth always has. Legacy bridge
   *  rows may carry null, in which case the account id (a UUID primary key) is the
   *  scope on its own. */
  workspaceId: string | null;
  connectionMode: "cloud_api" | "coexistence" | "evolution_qr" | null;
  wabaId?: string | null;
  accessToken?: string | null;
}

// Structural types, not supabase-js generics: the module never needs the client,
// only the queries it issues, and a hand-written fake implementing exactly these
// shapes is what keeps the tests dependency-free.
export interface WhatsAppDisconnectSelect {
  eq(column: string, value: unknown): WhatsAppDisconnectSelect;
  maybeSingle(): Promise<{ data: unknown; error: unknown }>;
}

export interface WhatsAppDisconnectUpdate extends PromiseLike<{ error: unknown }> {
  eq(column: string, value: unknown): WhatsAppDisconnectUpdate;
}

export interface WhatsAppDisconnectAdmin {
  from(table: string): {
    select(columns: string): WhatsAppDisconnectSelect;
    update(values: Record<string, unknown>): WhatsAppDisconnectUpdate;
  };
}

export interface WhatsAppDisconnectDeps {
  admin: WhatsAppDisconnectAdmin;
  // Only the two calls the teardown needs, so a test double (or a future lighter
  // client) does not have to satisfy the whole Evolution surface. Optional because
  // a Meta-only disconnect must not require Evolution env vars to exist.
  evolution?: Pick<EvolutionApi, "logout" | "deleteInstance">;
  fetcher?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

function warningText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** What one remote teardown attempt produced. Returned rather than written through a
 *  shared array so neither helper takes an output argument. */
interface StepOutcome {
  step: WhatsAppDisconnectStep;
  warnings: string[];
}

async function logoutEvolutionSession(
  input: WhatsAppDisconnectInput,
  deps: WhatsAppDisconnectDeps,
): Promise<StepOutcome> {
  // The instance name is stored, not derived: it embeds the account id today, but
  // deriving it here would break the moment provisioning changes the convention.
  const { data: instanceRow, error: instanceError } = await deps.admin
    .from("whatsapp_evolution_instances")
    .select("instance_name")
    .eq("social_account_id", input.accountId)
    .maybeSingle();
  if (instanceError) throw instanceError;

  const instanceName = (instanceRow as { instance_name?: string } | null)?.instance_name;
  if (!instanceName) {
    // No instance row means there is nothing remote to tear down (a provisioning
    // failure or an already-removed instance) — the account must still deactivate.
    return {
      step: "skipped",
      warnings: ["No Evolution instance row found; remote session, if any, was not logged out"],
    };
  }
  if (!deps.evolution) {
    return {
      step: "failed",
      warnings: ["Evolution API client unavailable; remote session may still be live"],
    };
  }

  const warnings: string[] = [];
  // Best effort on purpose: an unreachable Evolution server must never leave the
  // user unable to disconnect locally. The failed steps are reported, not raised.
  try {
    await deps.evolution.logout(instanceName);
  } catch (e) {
    warnings.push(`Evolution logout failed: ${warningText(e)}`);
  }
  try {
    await deps.evolution.deleteInstance(instanceName);
  } catch (e) {
    warnings.push(`Evolution instance delete failed: ${warningText(e)}`);
  }
  const step: WhatsAppDisconnectStep = warnings.length === 0 ? "ok" : "failed";

  // Recorded even when the remote calls failed: 'close' is the truth about the
  // session from this point on, and a stale 'open' would keep the QR screen polling
  // a session nothing will ever report on again. A failure to record it is a
  // warning, not a blocker — the deactivation is what matters.
  const { error: stateError } = await deps.admin
    .from("whatsapp_evolution_instances")
    .update({ last_connection_state: "close", last_qr: null })
    .eq("social_account_id", input.accountId);
  if (stateError) {
    warnings.push(`Evolution instance row not updated: ${warningText(stateError)}`);
  }

  return { step, warnings };
}

async function unsubscribeWabaWebhook(
  input: WhatsAppDisconnectInput,
  deps: WhatsAppDisconnectDeps,
): Promise<StepOutcome> {
  // Historical behaviour: the Graph call was always conditional on both ids, and its
  // absence never blocked the deactivation.
  if (!input.wabaId || !input.accessToken) return { step: "skipped", warnings: [] };

  try {
    const fetcher = deps.fetcher ?? fetch;
    const res = await fetcher(`${GRAPH_API}/${input.wabaId}/subscribed_apps`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${input.accessToken}` },
    });
    if (res.ok) return { step: "ok", warnings: [] };
    return { step: "failed", warnings: [`Graph unsubscribe returned status ${res.status}`] };
  } catch (e) {
    return { step: "failed", warnings: [`Graph unsubscribe failed: ${warningText(e)}`] };
  }
}

/**
 * Puts a Meta-hosted account back the way `disconnectWhatsAppAccount` found it:
 * re-subscribe this app to the WABA, then reactivate the row.
 *
 * Disconnecting deletes the WABA webhook subscription, and nothing restored it.
 * The only reconnect the product offered was Embedded Signup, which cannot help
 * an already-onboarded number — Meta lists numbers *available to onboard*, so a
 * number already owned by a WABA simply never appears and the operator is left
 * staring at an empty picker with a live, healthy number and no messages.
 *
 * Evolution QR accounts are not reconnectable this way: their session is gone
 * once logged out and the operator has to scan a new QR.
 */
export async function reconnectWhatsAppAccount(
  input: WhatsAppDisconnectInput,
  deps: WhatsAppDisconnectDeps,
): Promise<WhatsAppDisconnectResult> {
  if (input.connectionMode === "evolution_qr") {
    throw new Error("Direct QR accounts reconnect by scanning a new QR code, not by resubscribing");
  }
  if (!input.wabaId || !input.accessToken) {
    throw new Error("Reconnect needs the account's WABA id and access token");
  }

  const warnings: string[] = [];
  let graph: WhatsAppDisconnectStep = "failed";
  try {
    const fetcher = deps.fetcher ?? fetch;
    const res = await fetcher(`${GRAPH_API}/${input.wabaId}/subscribed_apps`, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.accessToken}` },
    });
    if (res.ok) {
      graph = "ok";
    } else {
      warnings.push(`Graph resubscribe returned status ${res.status}`);
    }
  } catch (e) {
    warnings.push(`Graph resubscribe failed: ${warningText(e)}`);
  }

  // Unlike disconnect, the remote step is NOT best effort. Reactivating a row
  // whose webhook subscription is still missing produces an account that looks
  // connected and silently receives nothing -- the exact state this function
  // exists to get out of.
  if (graph !== "ok") {
    throw new Error(
      `Could not resubscribe to WhatsApp webhooks; account left disconnected. ${warnings.join(" ")}`,
    );
  }

  const reactivation = input.workspaceId !== null
    ? deps.admin.from("social_accounts").update({ is_active: true })
      .eq("id", input.accountId)
      .eq("workspace_id", input.workspaceId)
    : deps.admin.from("social_accounts").update({ is_active: true })
      .eq("id", input.accountId);
  const { error: reactivateError } = await reactivation;
  if (reactivateError) throw reactivateError;

  // The reconnect already succeeded, so a held store-order flag can now be released.
  // Best effort: this module's admin contract predates rpc, and a failed clear must
  // never turn a completed reconnect into an error for the user.
  try {
    await clearUndeliveredSafely(deps.admin, input.accountId);
  } catch {
    console.error(`[whatsapp-disconnect] account ${input.accountId}: undelivered flag clear failed`);
  }

  return { deactivated: false, evolution: "skipped", graph, warnings };
}

export async function disconnectWhatsAppAccount(
  input: WhatsAppDisconnectInput,
  deps: WhatsAppDisconnectDeps,
): Promise<WhatsAppDisconnectResult> {
  const isEvolution = input.connectionMode === "evolution_qr";
  const remote = isEvolution
    ? await logoutEvolutionSession(input, deps)
    : await unsubscribeWabaWebhook(input, deps);

  // The one mandatory step. Everything above can fail without blocking it, and its
  // own failure is the only one raised: a silent no-op here is exactly the
  // half-disconnect this module exists to make impossible.
  const deactivation = input.workspaceId !== null
    ? deps.admin.from("social_accounts").update({ is_active: false })
      .eq("id", input.accountId)
      .eq("workspace_id", input.workspaceId)
    : deps.admin.from("social_accounts").update({ is_active: false })
      .eq("id", input.accountId);
  const { error: deactivateError } = await deactivation;
  if (deactivateError) throw deactivateError;

  return {
    deactivated: true,
    evolution: isEvolution ? remote.step : "skipped",
    graph: isEvolution ? "skipped" : remote.step,
    warnings: remote.warnings,
  };
}
