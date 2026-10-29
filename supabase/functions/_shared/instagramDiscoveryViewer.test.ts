import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  pickBusinessDiscoveryViewer,
  type ViewerCandidate,
} from "./instagramDiscoveryViewer.ts";

Deno.test("pickBusinessDiscoveryViewer - returns null for empty or invalid list", () => {
  assertEquals(pickBusinessDiscoveryViewer([]), null);
});

Deno.test("pickBusinessDiscoveryViewer - rejects non-instagram or inactive accounts", () => {
  const accounts: ViewerCandidate[] = [
    {
      id: "1",
      user_id: "user-1",
      platform: "facebook",
      platform_user_id: "fb-1",
      access_token: "tok-1",
      is_active: true,
      ig_auth_type: "facebook_page",
    },
    {
      id: "2",
      user_id: "user-1",
      platform: "instagram",
      platform_user_id: "ig-1",
      access_token: "tok-2",
      is_active: false,
      ig_auth_type: "facebook_page",
    },
    {
      id: "3",
      user_id: "user-1",
      platform: "instagram",
      platform_user_id: "ig-2",
      access_token: "tok-3",
      is_active: true,
      needs_reauth: true,
      ig_auth_type: "facebook_page",
    },
  ];

  assertEquals(pickBusinessDiscoveryViewer(accounts), null);
});

Deno.test("pickBusinessDiscoveryViewer - rejects direct Instagram business login accounts", () => {
  const accounts: ViewerCandidate[] = [
    {
      id: "direct-1",
      user_id: "user-1",
      platform: "instagram",
      platform_user_id: "ig-direct",
      access_token: "tok-direct",
      is_active: true,
      ig_auth_type: "business_login",
    },
  ];

  assertEquals(pickBusinessDiscoveryViewer(accounts), null);
});

Deno.test("pickBusinessDiscoveryViewer - rejects accounts that explicitly lack instagram_manage_insights", () => {
  const accounts: ViewerCandidate[] = [
    {
      id: "lacking-1",
      user_id: "user-1",
      platform: "instagram",
      platform_user_id: "ig-page",
      access_token: "tok-page",
      is_active: true,
      ig_auth_type: "facebook_page",
      account_metadata: {
        granted_scopes: ["instagram_basic", "pages_show_list"],
      },
    },
  ];

  assertEquals(pickBusinessDiscoveryViewer(accounts), null);
});

Deno.test("pickBusinessDiscoveryViewer - prefers accounts with instagram_manage_insights over unknown scopes", () => {
  const accountUnknown: ViewerCandidate = {
    id: "unknown-1",
    user_id: "user-1",
    platform: "instagram",
    platform_user_id: "ig-unknown",
    access_token: "tok-unknown",
    is_active: true,
    ig_auth_type: "facebook_page",
    connected_at: "2026-10-28T12:00:00Z",
  };

  const accountPreferred: ViewerCandidate = {
    id: "preferred-1",
    user_id: "user-1",
    platform: "instagram",
    platform_user_id: "ig-pref",
    access_token: "tok-pref",
    is_active: true,
    ig_auth_type: "facebook_page",
    account_metadata: {
      granted_scopes: ["instagram_manage_insights"],
    },
    connected_at: "2026-10-25T12:00:00Z", // Older, but has preferred scope
  };

  const chosen = pickBusinessDiscoveryViewer([accountUnknown, accountPreferred]);
  assertEquals(chosen?.id, "preferred-1");
});

Deno.test("pickBusinessDiscoveryViewer - tie-breaks by newest connected_at", () => {
  const accountOld: ViewerCandidate = {
    id: "old-1",
    user_id: "user-1",
    platform: "instagram",
    platform_user_id: "ig-old",
    access_token: "tok-old",
    is_active: true,
    ig_auth_type: "facebook_page",
    account_metadata: {
      granted_scopes: ["instagram_manage_insights"],
    },
    connected_at: "2026-10-20T12:00:00Z",
  };

  const accountNew: ViewerCandidate = {
    id: "new-1",
    user_id: "user-1",
    platform: "instagram",
    platform_user_id: "ig-new",
    access_token: "tok-new",
    is_active: true,
    ig_auth_type: "facebook_page",
    account_metadata: {
      granted_scopes: ["instagram_manage_insights"],
    },
    connected_at: "2026-10-28T12:00:00Z",
  };

  const chosen = pickBusinessDiscoveryViewer([accountOld, accountNew]);
  assertEquals(chosen?.id, "new-1");
});
