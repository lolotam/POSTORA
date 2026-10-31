/**
 * TEST-ONLY support for the rollout integration suites.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The three adapters the rollout integration suites need and that no
 *   production module may own:
 *
 *   1. THE SQL ADAPTER. The production stores take an `rpc(name, args,
 *      signal)` seam. This module implements that seam against a REAL
 *      disposable Postgres: every call runs the accepted function inside the
 *      container with `docker exec ... psql`, under the role the real caller
 *      uses (`service_role` for the service stores, `authenticated` with the
 *      caller's own subject for the owner stores), and the answer is the
 *      function's own JSON - never a hand-written double.
 *
 *   2. THE DRIVER STUB. The composition roots build their clients with
 *      `@supabase/supabase-js`. The suites replace that one import with this
 *      stub, so the REAL `index.ts` composition - the real store factories,
 *      the real handler, the real route - runs against the real database
 *      without a PostgREST in the loop.
 *
 *   3. THE FAKE META TRANSPORT. The provider adapters leave the process
 *      through `fetch`. This module replaces `globalThis.fetch` with a fake
 *      that answers the Graph shapes the adapters read, records every
 *      request with its host, its target and its credential identity, and
 *      REFUSES every other host. There is no public egress.
 *
 * WHY A MISSING RUNTIME IS A FAILURE AND NOT A SKIP
 *
 *   A skipped integration suite is indistinguishable from a passing one in
 *   a CI log. The runtime is therefore resolved eagerly: when
 *   `ROLLOUT_IT_CONTAINER` or `ROLLOUT_IT_DB` is missing, the suite THROWS
 *   with a message that names both variables. There is no silent skip and
 *   no zero-test pass.
 *
 * WHY THIS IS TEST SUPPORT AND NOT PRODUCTION CODE
 *
 *   Nothing under `supabase/functions/**` that is not a `*.test.ts` file
 *   imports this module. It lives in `_shared` because BOTH collection
 *   features use it (the owner integration suite and the competitor
 *   integration suite), it contains no feature policy, and its name
 *   describes a stable technical capability: a disposable-SQL integration
 *   runtime.
 */

/** The environment variable that names the disposable Postgres container. */
export const ROLLOUT_IT_CONTAINER_ENV = "ROLLOUT_IT_CONTAINER";

/** The environment variable that names the migrated harness database. */
export const ROLLOUT_IT_DB_ENV = "ROLLOUT_IT_DB";

/** The optional environment variable that names the database role. */
export const ROLLOUT_IT_DB_USER_ENV = "ROLLOUT_IT_DB_USER";

/**
 * The integration runtime is not configured.
 *
 * The suite that raises it FAILS. It never skips.
 */
export class RolloutIntegrationRuntimeMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RolloutIntegrationRuntimeMissingError";
  }
}

/** A statement the database refused. The SQLSTATE is the contract. */
export class RolloutSqlError extends Error {
  readonly sqlstate: string;
  readonly detail: string;

  constructor(sqlstate: string, detail: string) {
    super(`The rollout integration statement failed with SQLSTATE ${sqlstate}.`);
    this.name = "RolloutSqlError";
    this.sqlstate = sqlstate;
    this.detail = detail;
  }
}

/** The role a statement runs as, and the subject it runs for. */
export interface RolloutRoleContext {
  readonly role: "service_role" | "authenticated";
  /** The owner a user-context statement runs for. Null for the service role. */
  readonly subject: string | null;
}

/** The service role context. */
export const SERVICE_ROLE: RolloutRoleContext = { role: "service_role", subject: null };

/** The user-context of one verified owner. */
export function authenticatedContext(subject: string): RolloutRoleContext {
  return { role: "authenticated", subject };
}

/** The disposable SQL runtime. */
export interface RolloutRuntime {
  readonly container: string;
  readonly database: string;
  /** Runs a script and returns its stdout. A refused statement throws. */
  exec(sql: string, context?: RolloutRoleContext): Promise<string>;
  /** Runs a statement that returns ONE jsonb value. */
  queryJson(sql: string, context?: RolloutRoleContext): Promise<unknown>;
  /** Runs a statement that returns a jsonb ROW set. */
  queryRows(sql: string, context?: RolloutRoleContext): Promise<unknown[]>;
  /**
   * Calls one accepted function with named arguments.
   *
   * The answer is the function's own JSON. A refusal THROWS a
   * `RolloutSqlError` with the SQLSTATE, because that is what the driver
   * envelope carries.
   */
  callRpc(
    name: string,
    args: Record<string, unknown>,
    context?: RolloutRoleContext,
  ): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// The SQL literal and the cast
// ---------------------------------------------------------------------------

/**
 * The casts this adapter knows.
 *
 * The cast comes from the DATABASE's own signature, never from the caller:
 * the argument list is looked up in `pg_proc` first, so the statement
 * always matches the accepted schema.
 */
const CASTS: Readonly<Record<string, string>> = {
  "text": "text",
  "uuid": "uuid",
  "integer": "integer",
  "int4": "integer",
  "bigint": "bigint",
  "int8": "bigint",
  "smallint": "smallint",
  "boolean": "boolean",
  "bool": "boolean",
  "jsonb": "jsonb",
  "json": "jsonb",
  "date": "date",
  "interval": "interval",
  "numeric": "numeric",
  "real": "real",
  "double precision": "double precision",
  "text[]": "text[]",
  "uuid[]": "uuid[]",
  "timestamp with time zone": "timestamptz",
  "timestamp without time zone": "timestamp",
  "time with time zone": "timetz",
  "time without time zone": "time",
};

/**
 * The cast for one declared parameter type.
 *
 * An unknown type is a loud failure: a silent fallback would let the
 * statement bind a value to the wrong type and hide a schema drift.
 */
function castFor(type: string): string {
  const normalized = type.trim().toLowerCase().replace(/\s+/g, " ");
  const cast = CASTS[normalized];
  if (cast === undefined) {
    throw new Error(
      `The rollout integration adapter does not know the SQL type '${type}'. ` +
        "The accepted schema changed and the adapter must be updated with it.",
    );
  }
  return cast;
}

/** One SQL literal, with the cast of the parameter it is bound to. */
function sqlLiteral(value: unknown, cast: string): string {
  if (value === null || value === undefined) return `NULL::${cast}`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("The rollout integration adapter refuses a non-finite number.");
    }
    return `${value}::${cast}`;
  }
  if (typeof value === "boolean") return `${value ? "TRUE" : "FALSE"}::${cast}`;
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'::${cast}`;
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::${cast}`;
}

// ---------------------------------------------------------------------------
// The function signature
// ---------------------------------------------------------------------------

/** One parameter of an accepted function. */
interface FunctionParameter {
  readonly name: string;
  readonly type: string;
}

/** One accepted function, as the database describes it. */
interface FunctionSignature {
  readonly parameters: readonly FunctionParameter[];
  readonly returnsSet: boolean;
  readonly returnsVoid: boolean;
}

/**
 * Splits `pg_get_function_identity_arguments` into its parameters.
 *
 * The split is parenthesis aware, so a type that carries parentheses is not
 * cut in half.
 */
function parseIdentityArguments(identity: string): FunctionParameter[] {
  const parameters: FunctionParameter[] = [];
  let depth = 0;
  let current = "";

  for (const character of identity) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      parameters.push(parseParameter(current));
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim() !== "") parameters.push(parseParameter(current));

  return parameters.filter((parameter) => parameter.name !== "");
}

function parseParameter(text: string): FunctionParameter {
  const trimmed = text.trim();
  const separator = trimmed.indexOf(" ");
  if (separator < 0) return { name: trimmed, type: "text" };
  return {
    name: trimmed.slice(0, separator).trim(),
    type: trimmed.slice(separator + 1).trim(),
  };
}

// ---------------------------------------------------------------------------
// The runtime
// ---------------------------------------------------------------------------

/** The container, the database and the psql invocation. */
function createRuntime(container: string, database: string, user: string): RolloutRuntime {
  const signatureCache = new Map<string, FunctionSignature[]>();

  async function runPsql(sql: string): Promise<string> {
    const command = new Deno.Command("docker", {
      args: [
        "exec",
        "-i",
        container,
        "psql",
        "-X",
        "-A",
        "-t",
        "-q",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        user,
        "-d",
        database,
        "-f",
        "-",
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });

    const child = command.spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(sql));
    await writer.close();

    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    const status = await child.status;

    if (!status.success) {
      throw new Error(
        `The rollout integration statement failed in ${container}/${database}.\n${stderr.trim()}`,
      );
    }
    return stdout;
  }

  /**
   * The prelude that makes a statement run as a caller.
   *
   * A statement WITHOUT a context runs as the connecting superuser, which
   * is what the fixtures need: the synthetic rows are written where RLS
   * does not apply. A statement WITH a context runs as the role the real
   * caller uses, so the grants and the RLS of that role are exercised.
   */
  function rolePrelude(context?: RolloutRoleContext): string {
    if (context === undefined) return "";
    const role = context.role;
    const subject = context.subject ?? "";
    return [
      `SET ROLE ${role};`,
      `SET request.jwt.claim.role = '${role}';`,
      `SET request.jwt.claim.sub = '${subject.replaceAll("'", "''")}';`,
    ].join("\n");
  }

  async function exec(sql: string, context?: RolloutRoleContext): Promise<string> {
    const prelude = rolePrelude(context);
    return await runPsql(prelude === "" ? sql : `${prelude}\n${sql}`);
  }

  /**
   * Reads one jsonb value.
   *
   * The statement must select exactly ONE jsonb column: `psql -A -t` renders
   * it as one line, and a jsonb text form never contains a raw newline.
   */
  async function queryJson(
    sql: string,
    context?: RolloutRoleContext,
  ): Promise<unknown> {
    const output = await exec(sql, context);
    const trimmed = output.trim();
    if (trimmed === "") return null;
    return JSON.parse(trimmed);
  }

  /** Reads a jsonb ROW set. Every row is one jsonb value. */
  async function queryRows(
    sql: string,
    context?: RolloutRoleContext,
  ): Promise<unknown[]> {
    const output = await exec(sql, context);
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));
  }

  async function signaturesOf(name: string): Promise<FunctionSignature[]> {
    const cached = signatureCache.get(name);
    if (cached !== undefined) return cached;

    const output = await exec(
      `SELECT coalesce(jsonb_agg(jsonb_build_object(` +
        `'identity', pg_get_function_identity_arguments(p.oid), ` +
        `'returns_set', p.proretset, ` +
        `'returns_void', (p.prorettype = 'void'::regtype) ` +
        `) ORDER BY pg_get_function_identity_arguments(p.oid)), '[]'::jsonb)::text ` +
        `FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace ` +
        `WHERE n.nspname = 'public' AND p.proname = '${name.replaceAll("'", "''")}';`,
    );

    const trimmed = output.trim();
    const rows = trimmed === "" ? [] : JSON.parse(trimmed);
    const signatures = (rows as Array<Record<string, unknown>>).map((row) => ({
      parameters: parseIdentityArguments(String(row.identity ?? "")),
      returnsSet: row.returns_set === true,
      returnsVoid: row.returns_void === true,
    }));

    signatureCache.set(name, signatures);
    return signatures;
  }

  function chooseSignature(
    signatures: readonly FunctionSignature[],
    args: Record<string, unknown>,
    name: string,
  ): FunctionSignature {
    if (signatures.length === 0) {
      throw new Error(
        `The accepted schema has no public function named '${name}'.`,
      );
    }

    const wanted = Object.keys(args);
    const matching = signatures.filter((signature) => {
      const names = signature.parameters.map((parameter) => parameter.name);
      return wanted.every((key) => names.includes(key));
    });

    if (matching.length === 0) {
      throw new Error(
        `The accepted schema has no overload of '${name}' that accepts ` +
          `(${wanted.join(", ")}).`,
      );
    }

    // The tightest overload that still accepts every argument wins.
    matching.sort((left, right) => left.parameters.length - right.parameters.length);
    return matching[0];
  }

  function buildCall(
    name: string,
    signature: FunctionSignature,
    args: Record<string, unknown>,
  ): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(args)) {
      const parameter = signature.parameters.find((candidate) => candidate.name === key);
      if (parameter === undefined) {
        throw new Error(
          `The accepted function '${name}' has no parameter named '${key}'.`,
        );
      }
      parts.push(`${key} => ${sqlLiteral(value, castFor(parameter.type))}`);
    }
    return `public.${name}(${parts.join(", ")})`;
  }

  async function callRpc(
    name: string,
    args: Record<string, unknown>,
    context: RolloutRoleContext = SERVICE_ROLE,
  ): Promise<unknown> {
    const signature = chooseSignature(await signaturesOf(name), args, name);
    const call = buildCall(name, signature, args);

    const body = signature.returnsVoid
      ? `PERFORM ${call};`
      : signature.returnsSet
      ? `INSERT INTO rollout_it_result(payload) ` +
        `SELECT coalesce(jsonb_agg(row_), '[]'::jsonb) FROM ${call} AS row_;`
      : `INSERT INTO rollout_it_result(payload) SELECT to_jsonb(${call});`;

    const script = [
      rolePrelude(context),
      "CREATE TEMP TABLE rollout_it_result(payload jsonb, state text, detail text);",
      "DO $rollout_it$",
      "BEGIN",
      "  BEGIN",
      `    ${body}`,
      "  EXCEPTION WHEN OTHERS THEN",
      "    INSERT INTO rollout_it_result(state, detail) VALUES (SQLSTATE, SQLERRM);",
      "  END;",
      "END",
      "$rollout_it$;",
      "SELECT jsonb_build_object(" +
        "'payload', payload, 'state', state, 'detail', detail)::text " +
        "FROM rollout_it_result;",
    ].join("\n");

    const output = await runPsql(script);
    const trimmed = output.trim();
    if (trimmed === "") {
      throw new Error(`The accepted function '${name}' returned no answer.`);
    }

    const envelope = JSON.parse(trimmed) as {
      payload: unknown;
      state: string | null;
      detail: string | null;
    };

    if (envelope.state !== null && envelope.state !== undefined) {
      throw new RolloutSqlError(envelope.state, envelope.detail ?? "");
    }
    return envelope.payload;
  }

  return { container, database, exec, queryJson, queryRows, callRpc };
}

/**
 * Resolves the disposable integration runtime.
 *
 * It THROWS when the runtime is not configured. The suites call it before
 * they declare anything, so a missing runtime is a failed suite rather than
 * a skipped one.
 */
export function resolveRolloutRuntime(): RolloutRuntime {
  const container = (Deno.env.get(ROLLOUT_IT_CONTAINER_ENV) ?? "").trim();
  const database = (Deno.env.get(ROLLOUT_IT_DB_ENV) ?? "").trim();
  const user = (Deno.env.get(ROLLOUT_IT_DB_USER_ENV) ?? "supabase_admin").trim();

  if (container === "" || database === "") {
    throw new RolloutIntegrationRuntimeMissingError(
      "The rollout integration runtime is missing: set " +
        `${ROLLOUT_IT_CONTAINER_ENV} to the disposable Postgres container and ` +
        `${ROLLOUT_IT_DB_ENV} to its migrated database. This suite FAILS ` +
        "without that runtime; it never skips and it never passes with zero tests.",
    );
  }

  return createRuntime(container, database, user);
}

// ---------------------------------------------------------------------------
// The suite lease
// ---------------------------------------------------------------------------

/** The table the suites use to serialise themselves. */
const LEASE_TABLE = "rollout_integration_lease";

/** How long a lease is honoured before it is considered abandoned. */
const LEASE_TTL = "15 minutes";

/**
 * Acquires the suite lease.
 *
 * The two integration suites share ONE disposable database, and the rollout
 * policy is a global row. Without a lease, `deno test` - which runs test
 * FILES in parallel - would let one suite write the policy while the other
 * drains against it. The lease makes that impossible, and it EXPIRES, so a
 * crashed suite never blocks the next one.
 */
export async function acquireRolloutLease(
  runtime: RolloutRuntime,
  holder: string,
): Promise<void> {
  const quoted = holder.replaceAll("'", "''");
  const create = `CREATE TABLE IF NOT EXISTS public.${LEASE_TABLE} (` +
    `id integer PRIMARY KEY, ` +
    `holder text NOT NULL, ` +
    `acquired_at timestamptz NOT NULL DEFAULT now());`;

  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      // The table is (re)created on every attempt: the suite that released
      // the lease may have removed it while this one was waiting.
      await runtime.exec(create);
      const owner = await runtime.queryJson(
        `WITH claimed AS (` +
          `INSERT INTO public.${LEASE_TABLE} (id, holder, acquired_at) ` +
          `VALUES (1, '${quoted}', now()) ` +
          `ON CONFLICT (id) DO UPDATE ` +
          `SET holder = EXCLUDED.holder, acquired_at = now() ` +
          `WHERE public.${LEASE_TABLE}.acquired_at < now() - interval '${LEASE_TTL}' ` +
          `RETURNING holder` +
          `) SELECT to_jsonb(claimed.holder) FROM claimed;`,
      );
      if (owner === quoted) return;
    } catch {
      // A statement that failed changed nothing. The lease is retried.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    "The rollout integration lease could not be acquired: another suite " +
      "holds the disposable database.",
  );
}

/**
 * Releases the suite lease.
 *
 * The lease table is removed with it, so the disposable database is left
 * exactly as it was found.
 */
export async function releaseRolloutLease(
  runtime: RolloutRuntime,
  holder: string,
): Promise<void> {
  try {
    await runtime.exec(
      `DELETE FROM public.${LEASE_TABLE} WHERE id = 1 AND holder = '${
        holder.replaceAll("'", "''")
      }';`,
    );
    await runtime.exec(`DROP TABLE IF EXISTS public.${LEASE_TABLE};`);
  } catch {
    // The lease EXPIRES on its own, so a release that could not run is not a
    // failure of the suite. It is only a reason for the next suite to wait.
  }
}

// ---------------------------------------------------------------------------
// The driver stub
// ---------------------------------------------------------------------------

/** The driver error the production code reads: the SQLSTATE and nothing else. */
export interface RolloutDriverError {
  readonly code: string;
  readonly message: string;
  readonly details: string | null;
  readonly hint: string | null;
}

/** The envelope the production code reads. */
export interface RolloutDriverEnvelope {
  readonly data: unknown;
  readonly error: RolloutDriverError | null;
}

/** The identity a statement runs as. */
export interface RolloutBridgeContext {
  readonly role: "service_role" | "authenticated";
  readonly subject: string | null;
}

/** The bridge the driver stub calls into. */
export interface RolloutBridge {
  rpc(
    name: string,
    args: Record<string, unknown>,
    context: RolloutBridgeContext,
  ): Promise<RolloutDriverEnvelope>;
  selectOne(
    table: string,
    columns: string,
    filters: ReadonlyArray<readonly [string, unknown]>,
    context: RolloutBridgeContext,
  ): Promise<RolloutDriverEnvelope>;
  selectMany(
    table: string,
    columns: string,
    filters: ReadonlyArray<readonly [string, unknown]>,
    idColumn: string | null,
    ids: readonly unknown[] | null,
    limit: number | null,
    context: RolloutBridgeContext,
  ): Promise<RolloutDriverEnvelope>;
  insert(
    table: string,
    row: Record<string, unknown>,
    context: RolloutBridgeContext,
  ): Promise<RolloutDriverEnvelope>;
  claims(token: string): Promise<RolloutDriverEnvelope>;
}

/** The configuration the driver stub reads to decide the identity. */
export interface RolloutBridgeConfig {
  readonly serviceRoleKey: string;
  /** The verified bearer of every owner the suite drives. */
  readonly bearerSubjects: Readonly<Record<string, string>>;
  /**
   * The hook that runs BEFORE a statement.
   *
   * It is how a scenario changes the world BETWEEN two statements of the
   * production path, without touching the production code.
   */
  readonly onRpc?: (name: string) => void | Promise<void>;
}

const BRIDGE_GLOBAL = "__postoraRolloutIntegrationBridge";
const CONFIG_GLOBAL = "__postoraRolloutIntegrationConfig";

/**
 * The stub source.
 *
 * It replaces exactly one import: `@supabase/supabase-js`. It implements
 * the small surface the two composition roots use - `rpc`, `from(...).select
 * (...).eq(...).in(...).limit(...).maybeSingle()`, `from(...).insert(...)`
 * and `auth.getClaims` - and every one of them reaches the real database
 * through the bridge.
 */
const STUB_SOURCE = `
const bridge = () => globalThis.${BRIDGE_GLOBAL};
const config = () => globalThis.${CONFIG_GLOBAL};

async function beforeRpc(name) {
  const hook = config().onRpc;
  if (typeof hook === "function") await hook(name);
}

function contextFor(key, headers) {
  const cfg = config();
  if (key === cfg.serviceRoleKey) {
    return { role: "service_role", subject: null };
  }
  const authorization = headers && headers.Authorization ? headers.Authorization : "";
  const subject = cfg.bearerSubjects[authorization];
  return { role: "authenticated", subject: subject === undefined ? null : subject };
}

export function createClient(url, key, options) {
  const headers = options && options.global && options.global.headers
    ? options.global.headers
    : {};
  const context = contextFor(key, headers);

  const from = (table) => {
    let columns = "*";
    const filters = [];
    let idColumn = null;
    let ids = null;
    let limit = null;

    const builder = {
      select(next) { columns = next; return builder; },
      eq(column, value) { filters.push([column, value]); return builder; },
      in(column, values) { idColumn = column; ids = values; return builder; },
      limit(value) { limit = value; return builder; },
      async maybeSingle() {
        return await bridge().selectOne(table, columns, filters, context);
      },
      async insert(row) {
        return await bridge().insert(table, row, context);
      },
      then(resolve, reject) {
        return bridge()
          .selectMany(table, columns, filters, idColumn, ids, limit, context)
          .then(resolve, reject);
      },
    };
    return builder;
  };

  return {
    auth: {
      async getClaims(token) { return await bridge().claims(token); },
    },
    rpc(name, args) {
      return beforeRpc(name).then(() => bridge().rpc(name, args || {}, context));
    },
    from,
  };
}
`;

/** The global the bridge and its configuration are published on. */
interface RolloutGlobals {
  [BRIDGE_GLOBAL]?: RolloutBridge;
  [CONFIG_GLOBAL]?: RolloutBridgeConfig;
}

/** A table or column name the production code uses. */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * Refuses an identifier that is not a plain lower-case name.
 *
 * The production code names its tables and columns from closed unions, so a
 * name that does not match is a contract drift and not a value to escape.
 */
function identifier(value: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new Error(`The rollout integration adapter refuses the identifier '${value}'.`);
  }
  return value;
}

/** One SQL literal for a filter value. */
function filterLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("The rollout integration adapter refuses a non-finite number.");
    }
    return String(value);
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
}

/** The role context of a bridge call. */
function contextOf(context: RolloutBridgeContext): RolloutRoleContext {
  if (context.role === "service_role") return SERVICE_ROLE;
  if (context.subject === null || context.subject === "") {
    throw new Error(
      "The rollout integration bridge refuses an authenticated statement " +
        "without a subject: the owner would be unidentified.",
    );
  }
  return authenticatedContext(context.subject);
}

/**
 * Builds the bridge that drives the real database.
 *
 * Every call it receives ends up as a statement against the disposable
 * Postgres, under the role the real caller uses. A refused statement
 * becomes the driver error envelope the production code reads: the SQLSTATE
 * and nothing else.
 */
export function createRolloutBridge(runtime: RolloutRuntime): RolloutBridge {
  function errorEnvelope(error: unknown): RolloutDriverEnvelope {
    if (error instanceof RolloutSqlError) {
      return {
        data: null,
        error: {
          code: error.sqlstate,
          message: error.detail,
          details: null,
          hint: null,
        },
      };
    }
    throw error;
  }

  function whereClause(
    filters: ReadonlyArray<readonly [string, unknown]>,
  ): string {
    if (filters.length === 0) return "";
    const parts = filters.map(([column, value]) =>
      `${identifier(column)} = ${filterLiteral(value)}`
    );
    return ` WHERE ${parts.join(" AND ")}`;
  }

  return {
    async rpc(name, args, context) {
      try {
        const data = await runtime.callRpc(name, args, contextOf(context));
        return { data, error: null };
      } catch (error) {
        return errorEnvelope(error);
      }
    },

    async selectOne(table, columns, filters, context) {
      try {
        const rows = await runtime.queryRows(
          `SELECT to_jsonb(picked) FROM (SELECT ${columns} FROM public.${
            identifier(table)
          }${whereClause(filters)} LIMIT 2) AS picked;`,
          contextOf(context),
        );
        if (rows.length === 0) return { data: null, error: null };
        if (rows.length > 1) {
          return {
            data: null,
            error: {
              code: "PGRST116",
              message: "The statement returned more than one row.",
              details: null,
              hint: null,
            },
          };
        }
        return { data: rows[0], error: null };
      } catch (error) {
        return errorEnvelope(error);
      }
    },

    async selectMany(table, columns, filters, idColumn, ids, limit, context) {
      try {
        const parts: string[] = [];
        for (const [column, value] of filters) {
          parts.push(`${identifier(column)} = ${filterLiteral(value)}`);
        }
        if (idColumn !== null && ids !== null && ids.length > 0) {
          parts.push(
            `${identifier(idColumn)} IN (${ids.map((value) => filterLiteral(value)).join(", ")})`,
          );
        }
        const where = parts.length === 0 ? "" : ` WHERE ${parts.join(" AND ")}`;
        const bounded = limit === null ? "" : ` LIMIT ${Math.trunc(limit)}`;
        const rows = await runtime.queryRows(
          `SELECT to_jsonb(picked) FROM (SELECT ${columns} FROM public.${
            identifier(table)
          }${where}${bounded}) AS picked;`,
          contextOf(context),
        );
        return { data: rows, error: null };
      } catch (error) {
        return errorEnvelope(error);
      }
    },

    async insert(table, row, context) {
      try {
        const columns = Object.keys(row);
        const values = columns.map((column) => filterLiteral(row[column]));
        const written = await runtime.queryJson(
          `WITH inserted AS (` +
            `INSERT INTO public.${identifier(table)} ` +
            `(${columns.map(identifier).join(", ")}) ` +
            `VALUES (${values.join(", ")}) RETURNING 1` +
            `) SELECT count(*)::int FROM inserted;`,
          contextOf(context),
        );
        if (written === 0) {
          return {
            data: null,
            error: {
              code: "23502",
              message: "The statement inserted no row.",
              details: null,
              hint: null,
            },
          };
        }
        return { data: null, error: null };
      } catch (error) {
        return errorEnvelope(error);
      }
    },

    async claims(token) {
      // The suite never verifies a real signature: the bearer is a synthetic
      // string and the suite drives the SERVICE path, which does not read
      // claims at all.
      const subject = token.trim();
      if (subject === "") {
        return {
          data: null,
          error: {
            code: "401",
            message: "The bearer is empty.",
            details: null,
            hint: null,
          },
        };
      }
      return {
        data: { claims: { sub: subject, role: "authenticated" } },
        error: null,
      };
    },
  };
}

/**
 * Publishes the bridge and its configuration on the global object.
 *
 * The driver stub is a separate bundle, so it cannot import this module.
 * The global is the seam, and it is removed again by the returned function.
 */
export function installRolloutBridge(
  bridge: RolloutBridge,
  config: RolloutBridgeConfig,
): () => void {
  const globals = globalThis as RolloutGlobals;
  globals[BRIDGE_GLOBAL] = bridge;
  globals[CONFIG_GLOBAL] = config;
  return () => {
    delete globals[BRIDGE_GLOBAL];
    delete globals[CONFIG_GLOBAL];
  };
}

/**
 * The esbuild plugin that replaces the Supabase driver with the stub.
 *
 * The plugin is shaped like the ones the neighbouring handler suites use,
 * so the bundling contract of the repository stays the same.
 */
export function rolloutDriverStubPlugin(): Record<string, unknown> {
  return {
    name: "rollout-integration-driver",
    setup(esbuild: {
      onResolve: (
        options: { filter: RegExp },
        callback: (args: { path: string }) => unknown,
      ) => void;
      onLoad: (
        options: { filter: RegExp; namespace: string },
        callback: () => unknown,
      ) => void;
    }) {
      esbuild.onResolve({ filter: /.*/ }, (args: { path: string }) => {
        const path = args.path;
        if (path.includes("@supabase/supabase-js") || path.includes("esm.sh/@supabase")) {
          return { path: "rollout-driver", namespace: "rollout-stub" };
        }
        if (path.startsWith("npm:")) {
          return { path, external: true };
        }
        return undefined;
      });
      esbuild.onLoad({ filter: /.*/, namespace: "rollout-stub" }, () => ({
        contents: STUB_SOURCE,
        loader: "js",
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// The fake Meta transport
// ---------------------------------------------------------------------------

/** One recorded provider request. */
export interface RecordedProviderCall {
  readonly host: string;
  readonly kind: "profile" | "account_day" | "media_window" | "media_insight" | "business_discovery";
  /** The account, the media or the viewer the request addressed. */
  readonly target: string;
  /** The credential identity the request carried. It is never a real token. */
  readonly accessToken: string;
  /**
   * The handle a business discovery request asked for.
   *
   * It is the identity of the COMPETITOR the request was about, which is
   * not the identity of the viewer that carried it.
   */
  readonly handle: string | null;
}

/** The hook the rollback scenarios use to change the policy mid-flight. */
export type ProviderCallHook = (call: RecordedProviderCall) => void | Promise<void>;

/**
 * The fake Meta transport.
 *
 * It answers the Graph shapes the adapters read, records every request and
 * refuses every host that is not a Graph host. There is no public egress:
 * a request to any other host fails the test loudly instead of leaving the
 * machine.
 */
export class FakeMetaTransport {
  readonly calls: RecordedProviderCall[] = [];
  #originalFetch: typeof fetch | null = null;
  #hook: ProviderCallHook | null = null;
  #mediaCursor: string | null = null;

  /**
   * The cursor the media window offers.
   *
   * A cursor makes the adapter ask for a SECOND page, and the permit for
   * that second page is asked again. That is the place where a removal can
   * be observed BETWEEN two requests without a write in between.
   */
  setMediaCursor(cursor: string | null): void {
    this.#mediaCursor = cursor;
  }

  /** Installs the fake over `globalThis.fetch`. */
  install(): void {
    if (this.#originalFetch !== null) return;
    this.#originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      this.#handle(input, init)) as typeof fetch;
  }

  /** Removes the fake and puts the original transport back. */
  restore(): void {
    if (this.#originalFetch === null) return;
    globalThis.fetch = this.#originalFetch;
    this.#originalFetch = null;
  }

  /** Installs the hook that runs after a request was recorded. */
  setHook(hook: ProviderCallHook | null): void {
    this.#hook = hook;
  }

  /** Forgets every recorded request. */
  reset(): void {
    this.calls.length = 0;
    this.#hook = null;
    this.#mediaCursor = null;
  }

  /** The recorded requests that addressed one target. */
  callsFor(target: string): RecordedProviderCall[] {
    return this.calls.filter((call) => call.target === target);
  }

  /** The recorded requests that carried one credential identity. */
  callsWithCredential(accessToken: string): RecordedProviderCall[] {
    return this.calls.filter((call) => call.accessToken === accessToken);
  }

  async #handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const raw = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const url = new URL(raw);

    if (url.hostname !== "graph.facebook.com" && url.hostname !== "graph.instagram.com") {
      throw new Error(
        `The rollout integration transport refuses to leave the machine: ${url.hostname}`,
      );
    }

    const segments = url.pathname.split("/").filter((part) => part !== "");
    const target = segments[1] ?? "";
    const edge = segments[2] ?? "";
    const accessToken = url.searchParams.get("access_token") ?? "";

    let kind: RecordedProviderCall["kind"];
    if (edge === "insights") {
      kind = url.searchParams.get("metric_type") === "total_value"
        ? "account_day"
        : "media_insight";
    } else if (edge === "media") {
      kind = "media_window";
    } else if (url.searchParams.get("fields")?.includes("business_discovery") === true) {
      kind = "business_discovery";
    } else {
      kind = "profile";
    }

    const call: RecordedProviderCall = {
      host: url.hostname,
      kind,
      target,
      accessToken,
      handle: kind === "business_discovery" ? readDiscoveryHandle(url) : null,
    };
    this.calls.push(call);

    if (this.#hook !== null) await this.#hook(call);

    return new Response(JSON.stringify(this.#bodyFor(kind, target, url)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  #bodyFor(
    kind: RecordedProviderCall["kind"],
    target: string,
    url: URL,
  ): Record<string, unknown> {
    switch (kind) {
      case "profile":
        return { followers_count: 120, media_count: 0 };
      case "account_day":
        return {
          data: [
            { name: "reach", total_value: { value: 11 } },
            { name: "views", total_value: { value: 22 } },
            { name: "accounts_engaged", total_value: { value: 3 } },
            { name: "total_interactions", total_value: { value: 7 } },
          ],
        };
      case "media_insight":
        return {
          data: [
            { name: "reach", values: [{ value: 5 }] },
            { name: "views", values: [{ value: 6 }] },
          ],
        };
      case "media_window":
        return this.#mediaCursor === null
          ? { data: [] }
          : {
            data: [],
            paging: {
              cursors: { after: this.#mediaCursor },
              next:
                `https://graph.facebook.com/v22/${target}/media?after=${this.#mediaCursor}`,
            },
          };
      case "business_discovery": {
        const handle = readDiscoveryHandle(url) ?? target;
        return {
          business_discovery: {
            id: `ig-target-${handle}`,
            username: handle,
            name: `Synthetic ${handle}`,
            followers_count: 42,
            media_count: 0,
            media: { data: [], paging: {} },
          },
        };
      }
    }
  }
}

/** The handle a business discovery request asked for. */
function readDiscoveryHandle(url: URL): string | null {
  const fields = url.searchParams.get("fields") ?? "";
  const match = /username\(([^)]*)\)/.exec(fields);
  return match === null ? null : match[1]!;
}
