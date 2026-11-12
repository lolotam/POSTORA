// Cron entrypoint for the WhatsApp disconnect watcher (spec
// 2026-11-13-whatsapp-disconnect-alerts-design.md). The watcher is the authority on whether an
// Evolution WhatsApp session is gone: it polls Evolution directly, so it works even when the
// connection.update webhook never fires.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyCronAuth } from "../_shared/cron-auth.ts";
import { restrictedCorsHeaders } from "../_shared/cors.ts";
import { createEvolutionApi } from "../_shared/evolutionApi.ts";
import { extractState } from "../whatsapp-evolution-bridge/qr.ts";
import { runWatch, type Episode, type WatchCandidate } from "./run.ts";

/**
 * A candidate polled less than this many minutes ago is skipped: the cron runs every five
 * minutes, so a candidate that was just checked must not be polled again.
 */
const POLL_FRESHNESS_MINUTES = 5;

/** The instance row the candidate query returns. */
interface CandidateRow {
  social_account_id: string;
  instance_name: string;
  last_polled_at: string | null;
}

Deno.serve(async (req) => {
  const corsHeaders = restrictedCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const cronAuth = verifyCronAuth(req);
  if (!cronAuth.ok) return cronAuth.response;

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      console.error("[whatsapp-disconnect-watch] Supabase configuration missing");
      return new Response(
        JSON.stringify({ error: "watcher not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const admin = createClient(supabaseUrl, serviceRoleKey);
    const api = createEvolutionApi();

    const summary = await runWatch({
      /**
       * The poll time lives on the instance row, so the query starts there. PostgREST can
       * order by the top level table's column but not by an embedded resource's column, and
       * the instance row IS the top level table here. The account side filters ride on the
       * embedded social_accounts row, which is a one-to-one foreign key from the instance.
       */
      async listCandidates(limit: number): Promise<WatchCandidate[]> {
        const { data, error } = await admin
          .from("whatsapp_evolution_instances")
          .select("social_account_id, instance_name, last_polled_at, social_accounts!inner(id)")
          .eq("social_accounts.platform", "whatsapp")
          .eq("social_accounts.connection_mode", "evolution_qr")
          .eq("social_accounts.is_active", true)
          .not("social_accounts.platform_user_id", "like", "pending_%")
          .not("social_accounts.platform_user_id", "like", "retired_%")
          .is("social_accounts.account_metadata->whatsapp_user_disconnected_at", null)
          .order("last_polled_at", { ascending: true, nullsFirst: true })
          .limit(limit);
        if (error) throw error;

        const cutoff = Date.now() - POLL_FRESHNESS_MINUTES * 60_000;
        const candidates: WatchCandidate[] = [];
        for (const row of (data ?? []) as CandidateRow[]) {
          if (row.last_polled_at !== null) {
            const polledAt = Date.parse(row.last_polled_at);
            // An unreadable poll time is treated as never polled: the account is checked.
            if (Number.isFinite(polledAt) && polledAt > cutoff) continue;
          }
          candidates.push({ id: row.social_account_id, instance_name: row.instance_name });
        }
        return candidates;
      },
      async readState(instanceName: string): Promise<string | null> {
        try {
          return extractState(await api.connectionState(instanceName));
        } catch {
          // An unreachable Evolution is not evidence about the account.
          return null;
        }
      },
      async observe(accountId: string, state: string, terminal: boolean): Promise<Episode | null> {
        const { data, error } = await admin.rpc("observe_whatsapp_disconnect_state", {
          p_account_id: accountId,
          p_state: state,
          p_terminal: terminal,
        });
        if (error) throw error;
        return (data as Episode | null) ?? null;
      },
      async clear(accountId: string): Promise<void> {
        const { error } = await admin.rpc("clear_whatsapp_disconnect_episode", {
          p_account_id: accountId,
        });
        if (error) throw error;
      },
      async markFlagged(accountId: string, reason: string): Promise<void> {
        const { error } = await admin
          .from("social_accounts")
          .update({ needs_reauth: true, last_refresh_error: reason })
          .eq("id", accountId);
        if (error) throw error;
      },
      async dispatchAlert(accountId: string): Promise<void> {
        // The same service-role bearer relationship refresh-tokens has with
        // send-token-failure-alert: the sender is an internal function, never a browser one.
        const response = await fetch(
          `${supabaseUrl}/functions/v1/send-whatsapp-disconnect-alert`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${serviceRoleKey}`,
            },
            body: JSON.stringify({ account_id: accountId }),
          },
        );
        if (!response.ok) {
          throw new Error(`alert dispatch failed with status ${response.status}`);
        }
      },
      async markPolled(instanceName: string, at: Date): Promise<void> {
        const { error } = await admin
          .from("whatsapp_evolution_instances")
          .update({ last_polled_at: at.toISOString() })
          .eq("instance_name", instanceName);
        if (error) throw error;
      },
      now: () => new Date(),
    });

    console.log(`[whatsapp-disconnect-watch] ${JSON.stringify(summary)}`);
    return new Response(
      JSON.stringify({ ok: true, ...summary }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    // Raw provider errors stay in the log; the response is generic.
    console.error(
      "[whatsapp-disconnect-watch] run failed:",
      error instanceof Error ? error.message : String(error),
    );
    return new Response(
      JSON.stringify({ error: "watcher run failed" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
