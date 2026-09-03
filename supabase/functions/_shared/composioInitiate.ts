// Minting a connect link, once, for both doors that mint one.
//
// WHY THIS IS SHARED AND NOT A COPY
// ---------------------------------
// Two doors create a Composio connection: the app door (`composio-connect`,
// a signed-in workspace member clicking "Connect") and the partner door
// (`POST /v1/connectors/{type}/connect-link`, a key acting for its
// workspace). The MECHANICS are identical and security-relevant in every
// step — a pending row written before the outbound call, an HMAC state
// carrying the connection id, the workspace and a nonce, a hard TTL, and a
// failure path that marks the row `failed` so a half-created connection can
// never look connectable. Two implementations of that would drift, and the
// half that drifted would be the one nobody looked at.
//
// WHAT IS **NOT** SHARED, DELIBERATELY
// ------------------------------------
// Authorisation. The app door proves workspace MEMBERSHIP; the partner door
// proves the KEY's workspace. Neither check belongs here — a shared function
// that "also checks the caller" would have to be told which kind of caller it
// has, which is exactly the branch that gets a default and then gets it wrong.
// Each door authorises first and calls this afterwards, with a workspace id it
// has already earned the right to act for (spec D2: never from a request body).
//
// TELEMETRY. The ledger row's `source` and `partner_key_id` are the caller's
// facts, so they arrive as a parameter. Only refusals and failures are written
// here, which is the behaviour the app door has had since Slice B; the partner
// door writes its own `success` row, because it is the only door §8.2 requires
// one from.
import {
  ComposioError,
  composioClientFromEnv,
  type ComposioClient,
} from "./composioClient.ts";
import { composioBinding, isComposioType } from "./connectorRegistry.ts";
import { newNonce, signConnectState } from "./composioState.ts";
import {
  recordConnectorCall,
  type ConnectorCallMeta,
  type ConnectorCallOutcome,
  type ConnectorCallSource,
} from "./connectorTelemetry.ts";

/**
 * How long a signed connect state stays valid.
 *
 * Ten minutes is the whole OAuth round trip: long enough for a human to read a
 * consent screen, short enough that a state captured from a browser history or
 * a referrer log is dead before it is useful.
 */
export const COMPOSIO_CONNECT_STATE_TTL_SECONDS = 10 * 60;

/** Per-connector-type auth config ids arrive as environment variables. */
export const COMPOSIO_AUTH_CONFIG_PREFIX = "COMPOSIO_AUTH_CONFIG_";

/** The ONE spelling of the env var name. Two spellings is a connector that
 *  works in one door and reports `connector_unavailable` in the other. */
export function composioAuthConfigFor(
  connectorType: string,
  getEnv: (name: string) => string | undefined,
): string | undefined {
  return getEnv(`${COMPOSIO_AUTH_CONFIG_PREFIX}${connectorType.toUpperCase()}`)
    ?.trim() || undefined;
}

/**
 * What minting a link needs, and nothing more.
 *
 * Narrower than `composio-connect`'s own dependency bag on purpose: that bag
 * also carries the callback, revoke and schema-refresh ports, and a `_shared`
 * module that demanded them would make the partner door build five closures it
 * can never call. `ComposioConnectDependencies` satisfies this structurally,
 * so the app door passes itself.
 */
export interface ComposioInitiateDependencies {
  composio: ComposioClient | null;
  stateSecret: string;
  callbackUrl: string;
  now: () => number;
  newId: () => string;
  authConfigFor: (connectorType: string) => string | undefined;
  insertConnection: (row: Record<string, unknown>) => Promise<void>;
  updateConnection: (id: string, values: Record<string, unknown>) => Promise<void>;
  recordCall: (
    meta: ConnectorCallMeta,
    outcome: ConnectorCallOutcome,
  ) => Promise<void>;
}

/** The door-specific half of a ledger row. */
export interface InitiateTelemetry {
  source: ConnectorCallSource;
  partnerKeyId?: string | null;
  requestId?: string | null;
}

export interface ConnectLink {
  connection_id: string;
  redirect_url: string;
  expires_at: string;
}

/**
 * A refusal with the stable code both doors map to their own envelope.
 *
 * It carries an HTTP status because the two codes here happen to have the same
 * status on both surfaces; a door that ever disagreed would map by code, not
 * by reading this field.
 */
export class ComposioInitiateError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
    this.name = "ComposioInitiateError";
  }
}

/** The default ports over an admin Supabase client, for a door that has one
 *  and no reason to build its own. */
export function composioInitiateDependencies(
  // deno-lint-ignore no-explicit-any
  admin: any,
  options: {
    getEnv?: (name: string) => string | undefined;
    now?: () => number;
    newId?: () => string;
  } = {},
): ComposioInitiateDependencies {
  const getEnv = options.getEnv ?? ((name: string) => Deno.env.get(name));
  return {
    composio: composioClientFromEnv(getEnv),
    stateSecret: getEnv("COMPOSIO_STATE_SECRET") ?? "",
    callbackUrl: getEnv("COMPOSIO_CALLBACK_URL") ?? "",
    now: options.now ?? Date.now,
    // Wrapped: randomUUID is a Crypto method and throws "Illegal invocation"
    // when called detached from its receiver.
    newId: options.newId ?? (() => crypto.randomUUID()),
    authConfigFor: (connectorType) => composioAuthConfigFor(connectorType, getEnv),
    async insertConnection(row) {
      const { error } = await admin.from("connector_connections").insert(row);
      if (error) throw new Error("connector_database_error");
    },
    async updateConnection(id, values) {
      const { error } = await admin.from("connector_connections").update({
        ...values,
        updated_at: new Date().toISOString(),
      }).eq("id", id);
      if (error) throw new Error("connector_database_error");
    },
    recordCall: (meta, outcome) => recordConnectorCall(admin, meta, outcome),
  };
}

/**
 * Create a pending connection and the provider link that completes it.
 *
 * The order is load-bearing and is the reason this is one function:
 *
 *   1. refuse a type that cannot be connected — before any row exists;
 *   2. refuse a missing client, auth config, state secret or callback — with a
 *      `refused` ledger row and still no row (spec D11);
 *   3. INSERT the pending row, so the id inside the signed state is a row the
 *      callback can find;
 *   4. sign the state and call the provider;
 *   5. on failure, mark the row `failed` and clear its nonce, so the state
 *      that was already handed out can never activate anything.
 *
 * Swapping 3 and 4 would hand out a state naming a row that does not exist;
 * skipping 5 would leave a row a replayed state could still complete.
 */
export async function initiateComposioConnection(
  deps: ComposioInitiateDependencies,
  input: {
    workspaceId: string;
    connectorType: string;
    /** The human this link is attributed to; null when a key mints it and the
     *  key has no creator on record. */
    initiatedBy: string | null;
    /** Carried in the signed state so the callback can home a YouTube channel
     *  on the profile tab the user started from. Only the app door sets it. */
    socialProfileId?: string | null;
  },
  telemetry: InitiateTelemetry,
): Promise<ConnectLink> {
  if (!isComposioType(input.connectorType)) {
    throw new ComposioInitiateError("connector_type_not_connectable", 400);
  }
  const binding = composioBinding(input.connectorType)!;
  const authConfigId = deps.authConfigFor(input.connectorType);

  const ledger = (
    extra: Partial<ConnectorCallMeta>,
    outcome: ConnectorCallOutcome,
  ) =>
    deps.recordCall({
      workspaceId: input.workspaceId,
      connectorType: input.connectorType,
      authStrategy: "composio_oauth",
      actionName: "connect_link",
      source: telemetry.source,
      partnerKeyId: telemetry.partnerKeyId ?? null,
      requestId: telemetry.requestId ?? null,
      ...extra,
    }, outcome);

  if (!deps.composio || !authConfigId || !deps.stateSecret || !deps.callbackUrl) {
    await ledger({}, { status: "refused", errorCode: "connector_unavailable" });
    throw new ComposioInitiateError("connector_unavailable", 503);
  }

  const connectionId = deps.newId();
  const nonce = newNonce();
  const expiresAtSeconds = Math.floor(deps.now() / 1_000) +
    COMPOSIO_CONNECT_STATE_TTL_SECONDS;
  await deps.insertConnection({
    id: connectionId,
    workspace_id: input.workspaceId,
    connector_type: input.connectorType,
    toolkit: binding.toolkit,
    auth_strategy: "composio_oauth",
    composio_auth_config_id: authConfigId,
    status: "initiated",
    state_nonce: nonce,
    initiated_by: input.initiatedBy,
  });

  const state = await signConnectState({
    connectionId,
    workspaceId: input.workspaceId,
    nonce,
    exp: expiresAtSeconds,
    ...(input.socialProfileId ? { socialProfileId: input.socialProfileId } : {}),
  }, deps.stateSecret);
  const callbackUrl = new URL(deps.callbackUrl);
  callbackUrl.searchParams.set("state", state);

  try {
    const link = await deps.composio.initiateConnection({
      workspaceId: input.workspaceId,
      authConfigId,
      callbackUrl: callbackUrl.toString(),
    });
    return {
      connection_id: connectionId,
      redirect_url: link.redirectUrl,
      expires_at: new Date(expiresAtSeconds * 1_000).toISOString(),
    };
  } catch (error) {
    // The code, never the body: spec §11 forbids a vendor body reaching a
    // customer or a partner, and this one is going into a ledger row that the
    // Hub renders.
    const errorCode = error instanceof ComposioError
      ? error.code
      : "composio_unavailable";
    await deps.updateConnection(connectionId, {
      status: "failed",
      failure_code: errorCode,
      state_nonce: null,
    });
    await ledger({ connectionId }, { status: "failed", errorCode });
    throw new ComposioInitiateError("connector_unavailable", 503);
  }
}
