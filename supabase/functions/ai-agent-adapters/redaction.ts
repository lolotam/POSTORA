import { redactSensitive } from "../_shared/logging.ts";

const REDACTED = "[REDACTED]";

function collectStrings(value: unknown, output: Set<string>): void {
  if (typeof value === "string") {
    if (value.length > 0) output.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, output);
  }
}

function credentialRepresentations(credentials: Record<string, unknown>): string[] {
  const values = new Set<string>();
  collectStrings(credentials, values);
  for (const value of [...values]) {
    values.add(encodeURIComponent(value));
    values.add(`Bearer ${value}`);
  }

  const key = credentials.consumer_key;
  const secret = credentials.consumer_secret;
  if (typeof key === "string" && typeof secret === "string") {
    try {
      const encoded = btoa(`${key}:${secret}`);
      values.add(encoded);
      values.add(`Basic ${encoded}`);
    } catch {
      // WooCommerce keys are ASCII; exact raw-value redaction still applies.
    }
  }
  return [...values].filter(Boolean).sort((left, right) => right.length - left.length);
}

function replaceCredentialValues(value: unknown, sensitiveValues: string[]): unknown {
  if (typeof value === "string") {
    return sensitiveValues.reduce(
      (safe, sensitive) => safe.replaceAll(sensitive, REDACTED),
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceCredentialValues(item, sensitiveValues));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        replaceCredentialValues(item, sensitiveValues),
      ]),
    );
  }
  return value;
}

export function redactConnectorOutput(
  value: unknown,
  credentials: Record<string, unknown>,
): unknown {
  const structurallyRedacted = redactSensitive(value);
  return replaceCredentialValues(
    structurallyRedacted,
    credentialRepresentations(credentials),
  );
}

