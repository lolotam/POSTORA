import type { QueryClient } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { refetchSocialQueries } from "../oauthUtils";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {},
}));

const expectedQueryKeys = [
  ["all_social_accounts"],
  ["social_accounts"],
  ["social_accounts_by_profile"],
  ["social_profiles"],
  ["accounts-needing-reauth"],
  ["connection_health"],
  ["admin-token-health"],
  ["admin-refresh-history"],
];

it("refetches every social account and token-health query after OAuth", () => {
  const refetchQueries = vi.fn();
  const queryClient = { refetchQueries } as unknown as QueryClient;

  refetchSocialQueries(queryClient);

  expect(refetchQueries).toHaveBeenCalledTimes(expectedQueryKeys.length);
  expect(refetchQueries.mock.calls).toEqual(
    expectedQueryKeys.map((queryKey) => [{ queryKey }]),
  );
});
