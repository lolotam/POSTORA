// "Bring over my setup" (plan 2026-10-01, BC3). Pure use-case layer: ownership is
// checked here against an owner-scoped lookup, then the service-role RPC
// move_whatsapp_account_setup / dismiss_whatsapp_setup_move does the real work.
// index.ts wires the deps and maps MoveSetupError.code onto the { error: "<code>" }
// response body.

export interface MoveSetupDeps {
  /** Null when the id is not a WhatsApp account owned by this user (any connection mode). */
  findOwnedWhatsAppAccount(userId: string, id: string): Promise<{ id: string } | null>;
  rpc(
    name: "move_whatsapp_account_setup" | "dismiss_whatsapp_setup_move",
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

export class MoveSetupError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 | 500,
    public readonly code: string,
  ) {
    super(message);
    this.name = "MoveSetupError";
  }
}

interface MoveSetupParams {
  from: string;
  to: string;
  choices?: Record<string, unknown>;
}

interface DismissSetupMoveParams {
  from: string;
  to: string;
}

/**
 * The mover refuses owner-fixable states with 22023 whose message names the
 * reason (the message IS the code). Only the stable code is surfaced here —
 * the banner owns the human copy for each.
 */
const MOVER_REFUSAL_CODES = [
  "accounts_not_compatible",
  "connector_name_clash",
  "store_connector_left_behind",
  "replaced_connector_has_store_webhook",
] as const;

function mapMoveRpcError(error: { code?: string; message?: string } | null): MoveSetupError {
  if (error?.code === "55006") {
    return new MoveSetupError(
      "An order message is being sent right now. Try again in a minute.",
      409,
      "order_in_flight",
    );
  }
  if (error?.code === "22023" && typeof error.message === "string") {
    for (const code of MOVER_REFUSAL_CODES) {
      if (error.message.includes(code)) {
        return new MoveSetupError(code, 409, code);
      }
    }
  }
  // Everything else is not owner-fixable from here. The database text is logged
  // server-side only (it carries no user data); the owner gets one stable sentence.
  console.error(
    "[moveSetup] move_whatsapp_account_setup failed:",
    error?.message ?? "unknown rpc error",
  );
  return new MoveSetupError("Couldn't move the setup right now. Try again in a minute.", 500, "move_failed");
}

async function requireOwned(deps: MoveSetupDeps, userId: string, id: string): Promise<void> {
  const owned = await deps.findOwnedWhatsAppAccount(userId, id);
  if (!owned) throw new MoveSetupError("WhatsApp account not found", 404, "account_not_found");
}

export async function moveSetup(
  deps: MoveSetupDeps,
  userId: string,
  params: MoveSetupParams,
): Promise<unknown> {
  await requireOwned(deps, userId, params.from);
  await requireOwned(deps, userId, params.to);
  if (params.from === params.to) {
    throw new MoveSetupError("Pick two different accounts", 400, "from_to_same");
  }
  const { data, error } = await deps.rpc("move_whatsapp_account_setup", {
    p_from: params.from,
    p_to: params.to,
    p_mode: "interactive",
    p_choices: params.choices ?? {},
  });
  if (error) throw mapMoveRpcError(error);
  return data;
}

export async function dismissSetupMove(
  deps: MoveSetupDeps,
  userId: string,
  params: DismissSetupMoveParams,
): Promise<{ success: true }> {
  await requireOwned(deps, userId, params.from);
  await requireOwned(deps, userId, params.to);
  const { error } = await deps.rpc("dismiss_whatsapp_setup_move", {
    p_to: params.to,
    p_from: params.from,
  });
  if (error) {
    // Never echo the database text back; the owner only needs to know it failed.
    throw new MoveSetupError(
      "Couldn't dismiss the suggestion right now. Try again in a minute.",
      500,
      "dismiss_failed",
    );
  }
  return { success: true };
}
