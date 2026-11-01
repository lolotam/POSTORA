import io
import json
from pathlib import Path
import subprocess
import sys
import time
import unittest
import urllib.error
import urllib.parse
from unittest.mock import patch

import meta_owned_analytics as probe


class JsonResponse(io.BytesIO):
    def __init__(self, payload, status=200, headers=None):
        super().__init__(json.dumps(payload).encode())
        self.status = status
        self.headers = headers or {}


class RecordingOpener:
    """Replace provider HTTP only; the request builder and response decoder are real."""
    def __init__(self, responses):
        self.responses = iter(responses)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        response = next(self.responses)
        if isinstance(response, Exception):
            raise response
        return response


class CapabilityProbeTests(unittest.TestCase):
    def test_zero_and_all_daily_points_survive_without_invented_missing_values(self):
        payload = {"data": [{"name": "views", "values": [
            {"value": 0, "end_time": "2026-10-30T00:00:00Z"},
            {"value": 9, "end_time": "2026-10-31T00:00:00Z"},
            {"value": None}, {"value": True}, {"value": "5"}, {"value": float("nan")},
        ]}, {"name": "reach", "total_value": {"value": 7}}]}
        observed = probe.metric_observation(payload, "views")
        self.assertEqual(observed["observation"], "present")
        self.assertEqual([point["value"] for point in observed["measurements"]], [0, 9])
        self.assertEqual(probe.metric_observation(payload, "likes"), {"observation": "absent", "measurements": []})
        self.assertEqual(probe.metric_observation(payload, "reach")["measurements"], [{"kind": "total_value", "value": 7}])

    def test_error_and_usage_evidence_never_echoes_credentials_or_raw_messages(self):
        for code, reason in [(190, "reauth_required"), (10, "permission_missing"), (100, "provider_error"), (4, "provider_error")]:
            with self.subTest(code=code):
                observed = probe.error_observation(400, {"error": {"code": code, "message": "access_token=secret", "error_subcode": 463}})
                self.assertEqual(observed["reason"], reason)
                self.assertNotIn("secret", json.dumps(observed))
        usage = probe.safe_usage({"x-app-usage": '{"call_count":0,"token":"secret"}', "retry-after": "12", "unapproved-header": "secret"})
        self.assertEqual(usage, {"x-app-usage": {"call_count": 0}, "retryAfterSeconds": 12})

    def test_provider_http_uses_bearer_header_and_records_finite_failure(self):
        opener = RecordingOpener([JsonResponse({"data": []}), urllib.error.URLError("secret-url")])
        transport = probe.ProbeTransport("graph.threads.net", "v1.0", "synthetic-token", opener)
        self.assertEqual(transport.get("owner", "threads")[0], 200)
        request, timeout = opener.requests[0]
        self.assertNotIn("synthetic-token", request.full_url)
        self.assertEqual(request.get_header("Authorization"), "Bearer synthetic-token")
        self.assertGreater(timeout, 0)
        self.assertLessEqual(timeout, 5)
        self.assertEqual(transport.get("owner", "threads"), (0, {}, {}))

    def test_invalid_or_oversized_http_success_stays_a_failed_metric_read(self):
        for raw, failure in [(b"not-json", "invalid_json"), (b" " * 1_048_577, "response_too_large"),
                             (b'{"data":[{"name":"views","total_value":{"value":NaN}}]}', "invalid_json"),
                             (b'{"data":Infinity}', "invalid_json"), (b'{"data":-Infinity}', "invalid_json")]:
            with self.subTest(failure=failure):
                response = JsonResponse({})
                response.seek(0)
                response.truncate()
                response.write(raw)
                response.seek(0)
                transport = probe.ProbeTransport("graph.threads.net", "v1.0", "synthetic-token", RecordingOpener([response]))
                observation = next(probe.collect_observations(transport, "owner", "threads"))
                self.assertEqual(observation["httpStatus"], 200)
                self.assertEqual(observation["observation"], "provider_error")
                self.assertEqual(observation["probeFailure"], failure)
        self.assertEqual(probe.metric_observation({}, "views")["observation"], "provider_error")

    def test_oversized_numbers_never_overflow_or_enter_contract_measurements(self):
        enormous = 10 ** 400
        for number in (enormous, -enormous, 9_007_199_254_740_992, float("inf")):
            self.assertFalse(probe.finite_number(number))
            self.assertEqual(probe.metric_observation({"data": [{"name": "views", "total_value": {"value": number}}]}, "views")["measurements"], [])
        self.assertTrue(probe.finite_number(9_007_199_254_740_991))
        self.assertEqual(probe.safe_usage({"x-app-usage": json.dumps({"call_count": enormous})}), {"x-app-usage": {}})

    def test_linux_request_alarm_or_unsupported_live_cli_refusal(self):
        if hasattr(probe.signal, "setitimer"):
            previous_handler = probe.signal.getsignal(probe.signal.SIGALRM)
            with self.assertRaises(TimeoutError):
                with probe.request_deadline(0.02):
                    time.sleep(1)
            self.assertEqual(probe.signal.getitimer(probe.signal.ITIMER_REAL), (0.0, 0.0))
            self.assertEqual(probe.signal.getsignal(probe.signal.SIGALRM), previous_handler)
        else:
            completed = subprocess.run([sys.executable, str(Path(probe.__file__).resolve()),
                                        "--owner", "8f14e45f-ceea-4e7a-9b1c-2d3e4f5a6b7c",
                                        "--confirmed-account", "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d",
                                        "--platform", "threads", "--version", "v1.0"], capture_output=True, text=True, timeout=5)
            self.assertEqual(completed.returncode, 2)
            self.assertIn("POSIX server request timers", completed.stderr)

    def test_truncated_response_keeps_previous_observations_and_a_failure_receipt(self):
        class TruncatedResponse(JsonResponse):
            def read(self, _limit):
                raise probe.http.client.IncompleteRead(b"private-provider-body", 100)

        opener = RecordingOpener([JsonResponse({"data": [{"name": "views", "total_value": {"value": 0}}]}), TruncatedResponse({})])
        transport = probe.ProbeTransport("graph.threads.net", "v1.0", "synthetic-token", opener)
        receipts = probe.collect_observations(transport, "owner", "threads")
        first, interrupted = next(receipts), next(receipts)
        self.assertEqual(first["measurements"], [{"kind": "total_value", "value": 0}])
        self.assertEqual(interrupted["httpStatus"], 200)
        self.assertEqual(interrupted["observation"], "provider_error")
        self.assertEqual(interrupted["probeFailure"], "http_protocol_error")
        self.assertNotIn("private-provider-body", json.dumps(interrupted))

    def test_listing_rebuilds_fixed_origin_and_stops_on_repeated_cursor(self):
        page = {"data": [{"id": "post1"}], "paging": {"next": "https://attacker.invalid/?access_token=secret", "cursors": {"after": "cursor1"}}}
        opener = RecordingOpener([JsonResponse(page), JsonResponse(page)])
        transport = probe.ProbeTransport("graph.threads.net", "v1.0", "synthetic-token", opener)
        listing, post_id = probe.listing_probe(transport, "owner", "threads")
        self.assertEqual(post_id, "post1")
        self.assertEqual(len(opener.requests), 2)
        self.assertTrue(listing["pages"][-1]["repeatedCursor"])
        self.assertFalse(listing["complete"])
        for request, _ in opener.requests:
            self.assertEqual(urllib.parse.urlparse(request.full_url).hostname, "graph.threads.net")
        self.assertNotIn("secret", json.dumps(listing))

    def test_budget_refuses_additional_network_calls_and_preserves_yielded_receipts(self):
        opener = RecordingOpener([JsonResponse({"data": []})])
        transport = probe.ProbeTransport("graph.threads.net", "v1.0", "synthetic-token", opener)
        receipts = probe.collect_observations(transport, "owner", "threads")
        first = next(receipts)
        self.assertEqual(first["httpStatus"], 200)
        transport.deadline = 0
        with self.assertRaises(probe.ProbeBudgetExceeded):
            next(receipts)
        self.assertEqual(len(opener.requests), 1)
        transport.deadline = float("inf")
        transport.calls = 48
        with self.assertRaises(probe.ProbeBudgetExceeded):
            transport.get("owner")
        self.assertEqual(len(opener.requests), 1)

    def test_malformed_listing_or_declared_continuation_never_establishes_an_end(self):
        for payload in ({"data": [None]}, {"data": [{"id": "invalid/path"}]}, {"data": [], "paging": None},
                        {"data": [], "paging": {"next": ""}}, {"data": [], "paging": {"next": None}},
                        {"data": [], "paging": {"next": "https://attacker.invalid/"}}):
            with self.subTest(payload=payload):
                transport = probe.ProbeTransport("graph.threads.net", "v1.0", "fixture-token", RecordingOpener([JsonResponse(payload)]))
                listing, _ = probe.listing_probe(transport, "owner", "threads")
                self.assertFalse(listing["complete"])
        transport = probe.ProbeTransport("graph.threads.net", "v1.0", "fixture-token", RecordingOpener([JsonResponse({"data": []})]))
        self.assertTrue(probe.listing_probe(transport, "owner", "threads")[0]["complete"])

    def test_redirect_refuses_to_forward_authorization(self):
        request = probe.urllib.request.Request("https://graph.facebook.com/v22.0/me", headers={"Authorization": "Bearer synthetic-token"})
        self.assertIsNone(probe.NoRedirect().redirect_request(request, None, 302, "Found", {}, "https://attacker.invalid/"))

    def test_unavailable_or_invalid_approved_account_refuses_setup(self):
        owner = "8f14e45f-ceea-4e7a-9b1c-2d3e4f5a6b7c"
        account_id = "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d"
        for completed in [probe.subprocess.CompletedProcess([], 0, "", ""), probe.subprocess.CompletedProcess([], 1, "", "private-detail")]:
            with self.subTest(exit=completed.returncode), patch.object(probe.subprocess, "run", return_value=completed):
                with self.assertRaises(RuntimeError):
                    probe.read_account(owner, account_id, "threads")
        with patch.object(probe.subprocess, "run") as database:
            with self.assertRaises(ValueError):
                probe.read_account("invalid' SQL", account_id, "threads")
            database.assert_not_called()

    def test_scope_probe_requires_app_authenticated_debug_and_the_exact_owned_user(self):
        for fields, verified in [({}, True), ({"is_valid": False}, False), ({"user_id": "other"}, False),
                                 ({"scopes": None}, False), ({"scopes": ["bad scope!"]}, False)]:
            payload = {"data": {"is_valid": True, "user_id": "owner", "scopes": ["threads_basic", "threads_manage_insights"], **fields}}
            opener = RecordingOpener([JsonResponse(payload)])
            transport = probe.ProbeTransport("graph.threads.net", "v1.0", "fixture-token", opener)
            with self.subTest(fields=fields), patch.object(probe.subprocess, "run", return_value=probe.subprocess.CompletedProcess([], 0, "fixture-app\nfixture-secret\n", "")):
                receipt = probe.threads_granted_scopes(transport, "owner")
            self.assertEqual(receipt["verified"], verified)
            self.assertFalse(receipt["appIdReported"])
            request = opener.requests[0][0]
            self.assertEqual(urllib.parse.urlparse(request.full_url).path, "/v1.0/debug_token")
            self.assertEqual(request.get_header("Authorization"), "Bearer TH|fixture-app|fixture-secret")
            self.assertNotIn("fixture", json.dumps(receipt))

    def test_scope_probe_missing_app_credentials_and_refused_debugger_stay_unverified(self):
        opener = RecordingOpener([JsonResponse({"error": {"code": 10, "message": "fixture-secret"}}, 403)])
        transport = probe.ProbeTransport("graph.threads.net", "v1.0", "fixture-token", opener)
        with patch.object(probe.subprocess, "run", return_value=probe.subprocess.CompletedProcess([], 1, "", "private")):
            self.assertEqual(probe.threads_granted_scopes(transport, "owner"), {"verified": False, "reason": "app_debug_credential_unavailable"})
        self.assertEqual(opener.requests, [])
        with patch.object(probe.subprocess, "run", return_value=probe.subprocess.CompletedProcess([], 0, "fixture-app\nfixture-secret\n", "")):
            receipt = probe.threads_granted_scopes(transport, "owner")
        self.assertFalse(receipt["verified"])
        self.assertEqual(receipt["reason"], "permission_missing")
        self.assertNotIn("fixture", json.dumps(receipt))


if __name__ == "__main__":
    unittest.main()
