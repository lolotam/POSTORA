// Confirmation gate for the destructive MCP tools.
//
// The refusal is made HERE, in the handler, and not by the input schema: a
// schema that rejects anything but `true` refuses the call before it is ever
// handled, so the refusal leaves no trace. Every refusal has to write a log
// row (AGENTS.md rule 4), which means the decision has to happen in code we
// own and can record.
//
// The schema therefore accepts an optional boolean and the handler decides:
// `confirm: true` runs the tool, anything else is refused and recorded.
//
// The database client and the hashing function are injected so the gate owns
// no client of its own and can be exercised without a database or a network.

import { z } from "npm:zod@4.1.12";

export const confirmField = z.boolean().optional().describe(
  "Must be true to run. Confirms you intend this irreversible action.",
);

export interface ConfirmGateDeps {
  admin: any;
  sha256Hex: (text: string) => Promise<string>;
}

export interface ConfirmRefusal {
  code: "CONFIRMATION_REQUIRED";
  message: string;
}

const REFUSAL_MESSAGE = "Set confirm: true to run this action.";

function refusal(): ConfirmRefusal {
  return { code: "CONFIRMATION_REQUIRED", message: REFUSAL_MESSAGE };
}

/**
 * Refuse a destructive call that did not carry `confirm: true`.
 *
 * - `confirm === true` -> null: the call may run, and nothing is read or
 *   written. A confirmed call must not pay for a log lookup.
 * - anything else -> the refusal, after a best-effort durable log.
 *
 * The log names the tool and the code only. The arguments, the API key and
 * its hash stay out of it.
 *
 * A failed lookup, a missing owner, a failed insert or a thrown error are
 * all logged on the edge and then answered with the same refusal: the gate
 * never throws, and it never lets a broken log turn into a broken answer.
 */
export async function refuseUnconfirmed(
  deps: ConfirmGateDeps,
  request: { apiKey: string; tool: string; confirm: unknown },
): Promise<ConfirmRefusal | null> {
  if (request.confirm === true) return null;

  try {
    const apiKeyHash = await deps.sha256Hex(request.apiKey);
    const { data: profile, error } = await deps.admin
      .from("profiles")
      .select("id")
      .eq("api_key_hash", apiKeyHash)
      .maybeSingle();

    if (error) {
      console.error(`[mcp] ${request.tool} refused: owner lookup failed`);
      return refusal();
    }
    if (!profile) {
      console.error(`[mcp] ${request.tool} refused: owner not found`);
      return refusal();
    }

    const { error: insertError } = await deps.admin.from("system_logs").insert({
      source: "mcp",
      category: "edge",
      level: "warn",
      message: `${request.tool} refused: CONFIRMATION_REQUIRED`,
      user_id: profile.id,
      metadata: { tool: request.tool, code: "CONFIRMATION_REQUIRED" },
    });
    if (insertError) {
      console.error(`[mcp] ${request.tool} refused: log insert failed`);
    }
  } catch {
    console.error(`[mcp] ${request.tool} refused: unexpected error`);
  }

  return refusal();
}
