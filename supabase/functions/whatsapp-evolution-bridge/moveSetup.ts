// "Bring over my setup" (plan 2026-10-01, BC3). Pure use-case layer: ownership is
// checked here against an owner-scoped lookup, then the service-role RPC
// move_whatsapp_account_setup / dismiss_whatsapp_setup_move does the real work.
// index.ts wires the deps and maps MoveSetupError.status onto the HTTP response.

export interface MoveSetupDeps {
  /** Null when the id is not a WhatsApp account owned by this user (any connection mode). */
  findOwnedWhatsAppAccount(userId: string, id: string): Promise<{ id: string } | null>;
  rpc(
    name: "move_whatsapp_account_setup" | "dismiss_whatsapp_setup_move",
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

export class MoveSetupError extends Error {
  constructor(message: string, public readonly status: 400 | 404 | 409 | 500) {
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
 * The mover's 22023 covers several owner-fixable validation failures (different
 * workspace, pending/retired rows, cross-user, missing connector choices); one
 * stable sentence is returned for all of them. 55006 means an order is being
 * sent right now and the move must be retried.
 */
function mapRpcError(code: string | undefined): MoveSetupError {
  if (code === "22023") {
    return new MoveSetupError(
      "These two connections can't share setup (different workspace or not finished connecting)",
      409,
    );
  }
  if (code === "55006") {
    return new MoveSetupError(
      "An order message is being sent right now. Try again in a minute.",
      409,
    );
  }
  return new MoveSetupError("Couldn't move the setup right now. Try again in a minute.", 500);
}

async function requireOwned(deps: MoveSetupDeps, userId: string, id: string): Promise<void> {
  const owned = await deps.findOwnedWhatsAppAccount(userId, id);
  if (!owned) throw new MoveSetupError("WhatsApp account not found", 404);
}

export async function moveSetup(
  deps: MoveSetupDeps,
  userId: string,
  params: MoveSetupParams,
): Promise<unknown> {
  await requireOwned(deps, userId, params.from);
  await requireOwned(deps, userId, params.to);
  if (params.from === params.to) {
    throw new MoveSetupError("Pick two different accounts", 400);
  }
  const { data, error } = await deps.rpc("move_whatsapp_account_setup", {
    p_from: params.from,
    p_to: params.to,
    p_mode: "interactive",
    p_choices: params.choices,
  });
  if (error) throw mapRpcError(error.code);
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
    throw new MoveSetupError("Couldn't dismiss the suggestion right now. Try again in a minute.", 500);
  }
  return { success: true };
}
