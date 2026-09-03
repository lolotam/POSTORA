export const PARTNER_API_BASE_URL = "https://api.postora.cloud/functions/v1/partner-api/v1";

export interface CredentialsFileInput {
  name: string;
  environment: string;
  key: string;
  keyPrefix: string;
  scopes: string[];
  workspaceId: string;
  socialAccountId: string;
  createdAt: string;
}

/** The JSON the success view lets the admin download. Built once, from the
 *  same values shown on screen; never re-read from anywhere. */
export function buildCredentialsFile(input: CredentialsFileInput): string {
  return JSON.stringify(
    {
      name: input.name,
      environment: input.environment,
      key: input.key,
      key_prefix: input.keyPrefix,
      scopes: input.scopes,
      workspace_id: input.workspaceId,
      social_account_id: input.socialAccountId,
      base_url: PARTNER_API_BASE_URL,
      header: "x-postora-key",
      created_at: input.createdAt,
    },
    null,
    2,
  );
}
