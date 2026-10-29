/**
 * Server-controlled credential mode for the protected Facebook User credential
 * authority.
 *
 * WHY THIS EXISTS
 *
 *   The Facebook User token lives in two places today: `account_metadata.user_token`
 *   on the Facebook/Instagram row (browser-readable, written by `facebook-oauth`)
 *   and, after the Phase 1 migration, `facebook_user_credentials` (service-only,
 *   owner-scoped, fenced by revision / connection_version / capability generation).
 *
 *   Those two worlds cannot be switched by a flag hidden in a request body or in
 *   account metadata: whoever can write that metadata can also write the mode.
 *   The mode therefore comes from `app_settings`, which only an admin or the
 *   service role can write, and the resolver below is the single place that
 *   decides which world a request runs in.
 *
 *   `app_settings` has two read policies: `app_settings_admin_select` (admin)
 *   and `Authenticated can read public settings`, which exposes keys matching
 *   `feature\_%`. The keys below deliberately do NOT start with `feature_`, so an
 *   ordinary authenticated browser session cannot even observe the mode. That
 *   matters: "server-only" has to mean "not readable by the client", not merely
 *   "not writable by the client".
 *
 * CREDENTIAL MODE vs COLLECTION ENABLED
 *
 *   These are two different switches and they are resolved from two different
 *   settings. They are never combined into one flag:
 *
 *     - credential mode decides WHERE a Facebook User secret is read from and
 *       written to (legacy metadata, or the protected authority).
 *     - collection enabled decides whether the Instagram insights collector may
 *       spend provider calls. It is off by default and has no reader in this
 *       slice, because the collector itself is a later slice.
 *
 *   Disabling collection must never move an account back to legacy credentials.
 *   That is why `resolveFacebookCredentialMode` takes exactly one value and
 *   never looks at the collection switch, and why `resolveInstagramCollectionEnabled`
 *   takes exactly one value and never looks at the mode.
 *
 * DEFAULTS
 *
 *   Credential mode defaults to `legacy` until the release cutover, so a
 *   deployment that has never been configured keeps today's behaviour. An
 *   unrecognised stored value is NOT treated as "legacy": it is refused
 *   explicitly, because silently downgrading a mis-typed "protected" would
 *   re-open the browser-readable metadata path that protected mode exists to
 *   close.
 *
 *   Collection is off by default and an unrecognised stored value is refused
 *   too, so a typo cannot enable paid provider work.
 */

export const FACEBOOK_CREDENTIAL_MODE_SETTING_KEY = "credential_facebook_user_mode";
export const INSTAGRAM_COLLECTION_ENABLED_SETTING_KEY = "collection_instagram_insights_enabled";

export type FacebookCredentialMode = "legacy" | "protected";

export type CredentialModeErrorCode = "CREDENTIAL_MODE_INVALID" | "COLLECTION_ENABLED_INVALID";

/**
 * A stored switch value that is neither absent nor one of the accepted values.
 * Callers turn this into a refusal; they must not fall back to a default.
 */
export class CredentialModeError extends Error {
  readonly code: CredentialModeErrorCode;
  readonly settingKey: string;

  constructor(code: CredentialModeErrorCode, settingKey: string) {
    super("Credential configuration is invalid.");
    this.name = "CredentialModeError";
    this.code = code;
    this.settingKey = settingKey;
  }
}

/**
 * The settings read failed, threw, or came back in a shape that is not a row.
 * This is not an absent setting. Callers must stop before provider work or writes.
 */
export class CredentialConfigurationError extends Error {
  readonly code = "CREDENTIAL_CONFIGURATION_UNAVAILABLE";

  constructor() {
    super("Credential configuration could not be read.");
    this.name = "CredentialConfigurationError";
  }
}

export const LIFECYCLE_PREREQUISITE_CODE = "lifecycle_prerequisite_missing";
export const LIFECYCLE_PREREQUISITE_STATUS = 503;
export const LIFECYCLE_PREREQUISITE_MESSAGE =
  "Protected Meta account changes are unavailable until the lifecycle contract is ready.";

export interface LifecycleRefusal {
  refused: true;
  status: typeof LIFECYCLE_PREREQUISITE_STATUS;
  errorCode: typeof LIFECYCLE_PREREQUISITE_CODE;
  error: string;
  flow: string;
  action: string;
}

export function isLifecycleRefusal(value: unknown): value is LifecycleRefusal {
  if (typeof value !== "object" || value === null) return false;
  const refusal = value as Partial<LifecycleRefusal>;
  return refusal.refused === true && refusal.errorCode === LIFECYCLE_PREREQUISITE_CODE;
}

function observableLabel(value: string): string {
  const cleaned = value.trim().toLowerCase().slice(0, 64);
  return /^[a-z0-9_-]+$/.test(cleaned) ? cleaned : "unknown";
}

/**
 * Logs and returns the one refusal used by every unsupported protected writer.
 * The log carries the flow and action only. It never carries tokens, provider
 * bodies, or credential-bearing URLs.
 */
export function refuseProtectedLifecycle(flow: string, action: string): LifecycleRefusal {
  console.error("[meta-credential] protected lifecycle refused", {
    event: LIFECYCLE_PREREQUISITE_CODE,
    flow: observableLabel(flow),
    action: observableLabel(action),
  });
  return {
    refused: true,
    status: LIFECYCLE_PREREQUISITE_STATUS,
    errorCode: LIFECYCLE_PREREQUISITE_CODE,
    error: LIFECYCLE_PREREQUISITE_MESSAGE,
    flow: observableLabel(flow),
    action: observableLabel(action),
  };
}

export interface CredentialClientError {
  status: number;
  error_code: string;
  error: string;
}

/** Stable client body for a configuration failure. Raw driver text is not copied. */
export function configurationClientError(error: unknown): CredentialClientError | null {
  if (error instanceof CredentialConfigurationError) {
    return { status: 503, error_code: error.code, error: error.message };
  }
  if (error instanceof CredentialModeError) {
    return { status: 503, error_code: error.code, error: error.message };
  }
  return null;
}

/**
 * Resolves the credential mode from the raw stored setting value.
 *
 * Absent (null/undefined) and an empty string both mean "never configured",
 * which is `legacy` until the release cutover. Anything else that is not
 * exactly `legacy` or `protected` is refused.
 */
export function resolveFacebookCredentialMode(raw: unknown): FacebookCredentialMode {
  if (raw === null || raw === undefined) return "legacy";

  if (typeof raw !== "string") {
    throw new CredentialModeError("CREDENTIAL_MODE_INVALID", FACEBOOK_CREDENTIAL_MODE_SETTING_KEY);
  }

  const value = raw.trim().toLowerCase();
  if (value === "") return "legacy";
  if (value === "legacy" || value === "protected") return value;

  throw new CredentialModeError("CREDENTIAL_MODE_INVALID", FACEBOOK_CREDENTIAL_MODE_SETTING_KEY);
}

/**
 * Resolves the collection switch from the raw stored setting value.
 *
 * Absent means off. A boolean is used as-is. The string forms are accepted
 * because `app_settings.value` is JSONB and older rows were written as text.
 * Every other value is refused instead of being read as "off", so a typo is
 * visible rather than silently disabling paid provider work.
 */
export function resolveInstagramCollectionEnabled(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false;
  if (typeof raw === "boolean") return raw;

  if (typeof raw === "string") {
    const value = raw.trim().toLowerCase();
    if (value === "") return false;
    if (value === "true") return true;
    if (value === "false") return false;
  }

  throw new CredentialModeError(
    "COLLECTION_ENABLED_INVALID",
    INSTAGRAM_COLLECTION_ENABLED_SETTING_KEY,
  );
}

export interface AppSettingLookupResult {
  found: boolean;
  value: unknown;
}

export type AppSettingLookup = (key: string) => Promise<AppSettingLookupResult>;

export interface AppSettingQueryResult {
  data: unknown;
  error: { message?: string } | null | undefined;
}

/**
 * Preserves a missing driver error as `undefined`. The lookup rejects that.
 * Only an explicit `null` error is a completed read.
 */
export function appSettingReadResult(
  data: unknown,
  error: { message?: string } | null | undefined,
): AppSettingQueryResult {
  if (error === undefined) return { data, error: undefined };
  if (error === null) return { data, error: null };
  return { data, error: { message: error.message } };
}

type ClassifiedAppSettingRow =
  | { shape: "absent" }
  | { shape: "value"; value: unknown }
  | { shape: "malformed" };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * An absent row is exactly `data: null`. A present row is a plain object with
 * its own `value`. `undefined` data, a missing value, or an inherited value is
 * a failed read. JSON `null` and a blank string are real stored values.
 */
export function classifyAppSettingRow(data: unknown): ClassifiedAppSettingRow {
  if (data === null) return { shape: "absent" };
  if (!isPlainRecord(data) || !Object.hasOwn(data, "value") || data.value === undefined) {
    return { shape: "malformed" };
  }
  return { shape: "value", value: data.value };
}

function logConfigurationReadFailure(key: string): void {
  console.error("[credential-mode] configuration read failed", {
    event: "CREDENTIAL_CONFIGURATION_UNAVAILABLE",
    setting_key: key,
  });
}

/**
 * Adapts a settings read into the lookup the resolvers take.
 *
 * A returned driver error and a thrown transport error are both configuration
 * failures. Neither becomes the legacy default. Only a genuinely absent row
 * is `found: false`.
 */
export function createAppSettingLookup(
  read: (key: string) => Promise<AppSettingQueryResult>,
): AppSettingLookup {
  return async (key) => {
    let response: AppSettingQueryResult;
    try {
      response = await read(key);
    } catch (error) {
      if (error instanceof CredentialConfigurationError || error instanceof CredentialModeError) {
        throw error;
      }
      logConfigurationReadFailure(key);
      throw new CredentialConfigurationError();
    }

    // Own properties only. A prototype that carries `data` or `error` is not a
    // Supabase row, and `error: undefined` is not the absent-row null.
    if (
      !isPlainRecord(response) ||
      !Object.hasOwn(response, "data") ||
      !Object.hasOwn(response, "error") ||
      response.error !== null
    ) {
      logConfigurationReadFailure(key);
      throw new CredentialConfigurationError();
    }

    const classified = classifyAppSettingRow(response.data);
    if (classified.shape === "malformed") {
      logConfigurationReadFailure(key);
      throw new CredentialConfigurationError();
    }
    if (classified.shape === "absent") return { found: false, value: null };
    return { found: true, value: classified.value };
  };
}

export interface FacebookCredentialSettings {
  /** Where the Facebook User secret is read from and written to. */
  credentialMode: FacebookCredentialMode;
  /**
   * Whether the Instagram insights collector may spend provider calls. Read
   * from its own setting. It never changes `credentialMode`, and disabling it
   * never moves an account back to legacy credentials.
   */
  collectionEnabled: boolean;
}

/**
 * Reads both server-controlled switches. Each value is resolved by its own
 * resolver, so an invalid credential mode never silently becomes legacy and an
 * invalid collection value never silently becomes off.
 */
export async function loadFacebookCredentialSettings(
  lookup: AppSettingLookup,
): Promise<FacebookCredentialSettings> {
  const [modeRaw, collectionRaw] = await Promise.all([
    lookup(FACEBOOK_CREDENTIAL_MODE_SETTING_KEY),
    lookup(INSTAGRAM_COLLECTION_ENABLED_SETTING_KEY),
  ]);

  return {
    credentialMode: resolveFacebookCredentialMode(modeRaw.found ? modeRaw.value : null),
    collectionEnabled: resolveInstagramCollectionEnabled(
      collectionRaw.found ? collectionRaw.value : null,
    ),
  };
}
