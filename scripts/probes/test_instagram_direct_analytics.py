import json
import subprocess
import unittest
import urllib.parse
from unittest.mock import patch

import instagram_direct_analytics as direct
from test_meta_owned_analytics import JsonResponse, RecordingOpener

OWNER = "9f010000-0000-4000-8000-000000000001"
ACCOUNT = "9f020000-0000-4000-8000-000000000010"


class DirectProbeTests(unittest.TestCase):
    def account_read(self):
        return subprocess.CompletedProcess([], 0, json.dumps({"platform_user_id": "123", "access_token": "fixture-token"}), "")

    def test_identity_mismatch_refuses_all_insight_reads(self):
        for identity in ({"id": "999", "user_id": "123"}, {"user_id": "123"}, {"error": {"code": 190}}):
            opener = RecordingOpener([JsonResponse(identity)])
            with self.subTest(identity=identity), patch.object(direct.subprocess, "run", return_value=self.account_read()), \
                 patch.object(direct.shared.urllib.request, "build_opener", return_value=opener):
                report = direct.run_probe(OWNER, ACCOUNT, "v22.0")
            self.assertEqual(report["reason"], "direct_identity_unverified")
            self.assertEqual(report["providerCalls"], 1)
            self.assertEqual(report["observations"], [])
            self.assertNotIn("fixture-token", json.dumps(report))

    def test_direct_context_uses_canonical_host_and_preserves_zero_missing_and_failures(self):
        replies = [JsonResponse({"id": "123", "user_id": "456"}), JsonResponse({"data": [
            {"permission": "instagram_business_manage_insights", "status": "granted"},
            {"permission": "instagram_business_basic", "status": "declined"}]}), JsonResponse({"followers_count": 0})]
        for _ in range(4):
            replies.extend([JsonResponse({"data": [{"name": "reach", "total_value": {"value": 0}, "period": "day"}]}),
                            JsonResponse({"data": []}), JsonResponse({"error": {"code": 10, "message": "private details"}}, 400),
                            JsonResponse({"error": {"code": 190}}, 400)])
        replies.extend([JsonResponse({"data": [{"id": "789"}]}),
                        *[JsonResponse({"data": [{"name": metric, "values": [{"value": 0}], "period": "lifetime"}]}) for metric in direct.MEDIA_METRICS]])
        opener = RecordingOpener(replies)
        with patch.object(direct.subprocess, "run", return_value=self.account_read()), \
             patch.object(direct.shared.urllib.request, "build_opener", return_value=opener):
            report = direct.run_probe(OWNER, ACCOUNT, "v22.0")
        self.assertEqual(report["execution"], "finished")
        self.assertEqual(report["grantedScopes"]["scopes"], ["instagram_business_manage_insights"])
        self.assertEqual(report["profileObservation"]["measurements"], {"followers_count": 0})
        self.assertEqual([receipt["observation"] for receipt in report["observations"][:4]], ["present", "absent", "provider_error", "provider_error"])
        self.assertEqual(report["observations"][0]["measurements"][0]["value"], 0)
        self.assertEqual(report["observations"][2]["reason"], "permission_missing")
        self.assertEqual(report["observations"][3]["reason"], "reauth_required")
        self.assertTrue(report["listing"]["complete"])
        self.assertEqual(urllib.parse.urlparse(opener.requests[1][0].full_url).path, "/v22.0/me/permissions")
        for request, _ in opener.requests:
            parsed = urllib.parse.urlparse(request.full_url)
            self.assertEqual(parsed.hostname, "graph.instagram.com")
            self.assertNotIn("fixture-token", request.full_url)
            self.assertEqual(request.get_header("Authorization"), "Bearer fixture-token")
        self.assertNotIn("private details", json.dumps(report))

    def test_listing_rebuilds_origin_and_retains_incomplete_cursor_state(self):
        for paging in ({"next": "https://attacker.invalid/?access_token=private", "cursors": {"after": "cursor"}},
                       {"next": "https://attacker.invalid/", "cursors": {}}, {}, {"cursors": {"after": "end"}},
                       {"next": "", "cursors": {"after": "cursor"}}, {"next": None}, {"next": False},
                       {"next": 1}, None, []):
            page = {"data": [{"id": "789"}], "paging": paging}
            opener = RecordingOpener([JsonResponse(page), JsonResponse(page)])
            transport = direct.shared.ProbeTransport("graph.instagram.com", "v22.0", "fixture-token", opener)
            listing, first = direct.media_listing(transport, "123")
            self.assertEqual(first, "789")
            self.assertEqual(listing["complete"], isinstance(paging, dict) and "next" not in paging)
            self.assertNotIn("private", json.dumps(listing))
            if isinstance(paging, dict) and "next" in paging and paging.get("cursors", {}).get("after"):
                if paging.get("next"):
                    self.assertTrue(listing["pages"][-1]["repeatedCursor"])
                else:
                    self.assertTrue(listing["pages"][-1]["invalidContinuation"])
            for request, _ in opener.requests:
                self.assertEqual(urllib.parse.urlparse(request.full_url).hostname, "graph.instagram.com")

    def test_database_failures_and_bad_identity_refuse_before_network(self):
        for completed, reason in ((subprocess.CompletedProcess([], 0, "", ""), "account_unavailable"),
                                  (subprocess.CompletedProcess([], 1, "", "private"), "account_read_failed"),
                                  (subprocess.CompletedProcess([], 0, "invalid JSON", ""), "invalid_account_response"),
                                  (subprocess.CompletedProcess([], 0, "null", ""), "invalid_account_response"),
                                  (subprocess.CompletedProcess([], 0, '{"platform_user_id":"123"}', ""), "credential_unavailable"),
                                  (subprocess.CompletedProcess([], 0, '{"access_token":"fixture-token","platform_user_id":"messaging_alias"}', ""), "identity_unavailable")):
            with self.subTest(completed=completed), patch.object(direct.subprocess, "run", return_value=completed), \
                 patch.object(direct.shared.urllib.request, "build_opener") as network:
                report = direct.run_probe(OWNER, ACCOUNT, "v22.0")
            self.assertEqual(report["execution"], "failed")
            self.assertEqual(report["reason"], reason)
            network.assert_not_called()

    def test_database_timeout_stays_an_infrastructure_failure(self):
        with patch.object(direct.subprocess, "run", side_effect=subprocess.TimeoutExpired("docker", 10)), \
             patch.object(direct.shared.urllib.request, "build_opener") as network:
            report = direct.run_probe(OWNER, ACCOUNT, "v22.0")
        self.assertEqual(report["reason"], "account_read_failed")
        network.assert_not_called()


if __name__ == "__main__":
    unittest.main()
