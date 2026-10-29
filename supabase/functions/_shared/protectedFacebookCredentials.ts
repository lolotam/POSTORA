/**
 * Protected-mode credential reads.
 *
 * These rules sit between an Edge Function and the read adapter in
 * `facebookUserCredentialStore.ts`. They take ports, so the same code runs
 * against the real adapter and against a fake port in a hermetic test.
 *
 * A protected account's Facebook User token comes from the owner-scoped read
 * and from nowhere else. There is no `account_metadata` fallback and no Page
 * token fallback. A missing credential, a failed read, a malformed payload,
 * or an unknown login classification is a typed refusal.
 *
 * OAuth connect and token refresh are not implemented here. Those writes need
 * atomic lifecycle SQL that this deployment does not have yet. The route
 * modules refuse them before any provider call.
 */

import {
  CredentialStoreError,
  type FacebookUserCredentialPort,
  type InstagramAccountCapabilityPort,
} from "./facebookUserCredentialStore.ts";

export interface ProtectedCredentialDeps {
  credentials: FacebookUserCredentialPort;
  capabilities: InstagramAccountCapabilityPort;
}

const KNOWN_CREDENTIAL_KIND = "facebook_user";
const PAGE_LINKED_LOGIN = "page_linked";

/**
 * Resolves the Facebook User token for a protected reader.
 *
 * The token is returned only when the read matches the requested account, the
 * credential kind is the known Facebook User kind, and an Instagram account is
 * page-linked. A direct-login account is refused. The Page token is not a
 * substitute.
 */
export async function resolveProtectedUserToken(
  deps: ProtectedCredentialDeps,
  input: { userId: string; socialAccountId: string },
): Promise<{ token: string; credentialId: string; revision: number }> {
  const binding = await deps.credentials.readAccountCredential({
    userId: input.userId,
    socialAccountId: input.socialAccountId,
  });

  if (binding.socialAccountId !== input.socialAccountId) {
    throw new CredentialStoreError(
      "invalid_contract",
      "the credential read did not match the requested account",
    );
  }

  if (!binding.found) {
    throw new CredentialStoreError(
      "not_found",
      "the account owns no protected Facebook User credential",
    );
  }

  if (
    binding.credentialKind !== KNOWN_CREDENTIAL_KIND ||
    !binding.token ||
    !binding.credentialId ||
    binding.revision === null
  ) {
    throw new CredentialStoreError(
      "invalid_contract",
      "the protected credential read was incomplete",
    );
  }

  if (binding.platform === "instagram") {
    const capability = await deps.capabilities.readCapability({
      userId: input.userId,
      socialAccountId: input.socialAccountId,
    });
    if (capability.socialAccountId !== input.socialAccountId) {
      throw new CredentialStoreError(
        "invalid_contract",
        "the capability read did not match the requested account",
      );
    }
    if (capability.loginKind !== PAGE_LINKED_LOGIN) {
      throw new CredentialStoreError(
        "refused",
        "the Instagram account is not a page-linked Facebook User credential",
      );
    }
  }

  return {
    token: binding.token,
    credentialId: binding.credentialId,
    revision: binding.revision,
  };
}
