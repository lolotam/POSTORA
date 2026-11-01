#!/usr/bin/env python3
"""Read-only, server-side Facebook/Threads capability observations. Uses only Python stdlib."""
import argparse
from contextlib import contextmanager
import datetime as dt
import hashlib
import http.client
import json
import math
import re
import signal
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

DB_CONTAINER = "postorasupabase-supabase-j8axyh-supabase-db"
DB_DATABASE = "postgres"
FUNCTIONS_CONTAINER = "postorasupabase-supabase-j8axyh-supabase-edge-functions"
METRICS = {
    "facebook": {"account": ["page_media_view", "page_total_media_view_unique", "page_post_engagements", "page_follows"],
                 "post": ["post_media_view", "post_total_media_view_unique", "post_engaged_users"]},
    "threads": {"account": ["views", "likes", "replies", "reposts", "quotes", "followers_count"],
                "post": ["views", "likes", "replies", "reposts", "quotes", "shares"]},
}


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def finite_number(value):
    # Counts must remain exactly representable by the browser/Deno contract too.
    return type(value) in (int, float) and -9_007_199_254_740_991 <= value <= 9_007_199_254_740_991 and math.isfinite(value)


def reject_json_constant(_constant):
    raise ValueError("Nonstandard JSON numeric constant")


def safe_usage(headers):
    usage = {}
    for name in ("x-app-usage", "x-page-usage", "x-business-use-case-usage"):
        try:
            parsed = json.loads(headers.get(name, "{}"))
        except (ValueError, TypeError):
            continue
        if isinstance(parsed, dict) and parsed:
            usage[name] = {key: value for key, value in parsed.items()
                           if key in ("call_count", "total_cputime", "total_time") and finite_number(value)}
    retry_after = headers.get("retry-after", "")
    if re.fullmatch(r"[0-9]{1,7}", retry_after):
        usage["retryAfterSeconds"] = int(retry_after)
    api_version = headers.get("facebook-api-version", "")
    if re.fullmatch(r"v[0-9]{1,2}\.0", api_version):
        usage["observedApiVersion"] = api_version
    return usage


def metric_observation(payload, metric):
    """Keep every numeric provider bucket; never synthesize zero or sum unique reach."""
    rows = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        return {"observation": "provider_error", "reason": "provider_error", "probeFailure": "invalid_metric_response"}
    observations = []
    for row in rows:
        if not isinstance(row, dict) or row.get("name") != metric:
            continue
        row_start = len(observations)
        total = row.get("total_value")
        if isinstance(total, dict) and finite_number(total.get("value")):
            observations.append({"kind": "total_value", "value": total["value"]})
        points = row.get("values")
        for point in points if isinstance(points, list) else []:
            if not isinstance(point, dict) or not finite_number(point.get("value")):
                continue
            observation = {"kind": "bucket", "value": point["value"]}
            end_time = point.get("end_time")
            if isinstance(end_time, str):
                try:
                    observation["endTime"] = dt.datetime.fromisoformat(end_time.replace("Z", "+00:00")).isoformat()
                except ValueError:
                    pass
            observations.append(observation)
        period = row.get("period")
        if period in ("day", "week", "days_28", "lifetime"):
            for observation in observations[row_start:]:
                observation["providerPeriod"] = period
    return {"observation": "present" if observations else "absent", "measurements": observations}


def error_observation(status, payload):
    error = payload.get("error", {}) if isinstance(payload, dict) else {}
    error = error if isinstance(error, dict) else {}
    code = error.get("code")
    reason = "reauth_required" if code == 190 else "permission_missing" if code in (10, 200) else "provider_error"
    observation = {"observation": "provider_error", "reason": reason,
                   "providerCode": code if type(code) is int else None,
                   "providerSubcode": error.get("error_subcode") if type(error.get("error_subcode")) is int else None,
                   "throttled": status == 429 or code in (4, 17, 32, 613)}
    failure = payload.get("__probe_failure") if isinstance(payload, dict) else None
    if failure in ("invalid_json", "response_too_large", "http_protocol_error"):
        observation["probeFailure"] = failure
    return observation


class ProbeBudgetExceeded(Exception):
    pass


@contextmanager
def request_deadline(seconds):
    # Injectable HTTP tests run on Windows too; the live CLI requires POSIX timers.
    if not hasattr(signal, "setitimer"):
        yield
        return
    if signal.getitimer(signal.ITIMER_REAL)[0] > 0:
        raise RuntimeError("Probe cannot replace an existing request timer")

    def expired(_number, _frame):
        raise TimeoutError("Provider request deadline reached")

    previous_handler = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)


class ProbeTransport:
    def __init__(self, host, version, token, opener=None):
        self.base_url = f"https://{host}/{version}"
        self.token = token
        self.opener = opener or urllib.request.build_opener(NoRedirect())
        self.deadline = time.monotonic() + 120
        self.calls = 0

    def get(self, subject, edge="", parameters=None, bearer=None):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0 or self.calls >= 48:
            raise ProbeBudgetExceeded()
        if not re.fullmatch(r"[A-Za-z0-9_]+", subject) or not re.fullmatch(r"[a-z_]*", edge):
            raise ValueError("Invalid provider subject or edge")
        suffix = f"/{edge}" if edge else ""
        url = f"{self.base_url}/{subject}{suffix}?{urllib.parse.urlencode(parameters or {})}"
        request = urllib.request.Request(url, headers={"Authorization": f"Bearer {bearer or self.token}"})
        self.calls += 1
        try:
            with request_deadline(min(5, remaining)):
                try:
                    response = self.opener.open(request, timeout=min(5, remaining))
                except urllib.error.HTTPError as error:
                    response = error
                with response:
                    try:
                        raw = response.read(1_048_577)
                    except http.client.HTTPException:
                        return response.status, {"error": {}, "__probe_failure": "http_protocol_error"}, safe_usage(response.headers)
                    if len(raw) > 1_048_576:
                        return response.status, {"error": {}, "__probe_failure": "response_too_large"}, safe_usage(response.headers)
                    try:
                        payload = json.loads(raw, parse_constant=reject_json_constant)
                    except (ValueError, UnicodeError):
                        payload = {"error": {}, "__probe_failure": "invalid_json"}
                    return response.status, payload, safe_usage(response.headers)
        except (urllib.error.URLError, TimeoutError, OSError):
            return 0, {}, {}
        except http.client.HTTPException:
            return 0, {"error": {}, "__probe_failure": "http_protocol_error"}, {}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Credentials never follow redirects, even to another Meta host.
        return None


def read_account(owner_id, account_id, platform):
    owner_id, account_id = str(uuid.UUID(owner_id)), str(uuid.UUID(account_id))
    if platform not in METRICS:
        raise ValueError("Unsupported platform")
    query = f"""BEGIN READ ONLY; SELECT json_build_object('platform_user_id', platform_user_id,
        'access_token', access_token) FROM public.social_accounts
        WHERE user_id='{owner_id}' AND id='{account_id}' AND platform='{platform}' AND is_active; COMMIT;"""
    read = subprocess.run(["docker", "exec", DB_CONTAINER, "psql", "-U", "postgres", "-d", DB_DATABASE,
                           "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", query],
                          capture_output=True, text=True, timeout=10, check=False)
    if read.returncode:
        raise RuntimeError("Account read failed")
    if not read.stdout.strip():
        raise RuntimeError("Approved account not found")
    account = json.loads(read.stdout)
    if not isinstance(account.get("access_token"), str) or not account["access_token"]:
        raise RuntimeError("Account credential unavailable")
    if not isinstance(account.get("platform_user_id"), str) or not re.fullmatch(r"[A-Za-z0-9_]+", account["platform_user_id"]):
        raise RuntimeError("Account provider identity unavailable")
    return account


def facebook_granted_scopes(transport):
    secrets = subprocess.run(["docker", "exec", FUNCTIONS_CONTAINER, "printenv", "FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET"],
                             capture_output=True, text=True, timeout=10, check=False)
    lines = secrets.stdout.splitlines()
    if secrets.returncode or len(lines) != 2 or not all(lines):
        return {"verified": False}
    status, payload, _ = transport.get("debug_token", parameters={"input_token": transport.token}, bearer="|".join(lines))
    token_data = payload.get("data") if isinstance(payload, dict) else None
    if status != 200 or not isinstance(token_data, dict):
        return {"verified": False, "httpStatus": status}
    scopes = token_data.get("scopes")
    return {"verified": True, "isValid": token_data.get("is_valid") is True,
            "scopes": [scope for scope in scopes if isinstance(scope, str) and re.fullmatch(r"[a-z_]{1,80}", scope)] if isinstance(scopes, list) else []}


def threads_granted_scopes(transport, expected_user_id):
    # Threads' permission listing failed live; its app-authenticated debugger reports the actual grant.
    secrets = subprocess.run(["docker", "exec", FUNCTIONS_CONTAINER, "printenv", "THREADS_APP_ID", "THREADS_APP_SECRET"],
                             capture_output=True, text=True, timeout=10, check=False)
    parts = secrets.stdout.splitlines()
    if secrets.returncode or len(parts) != 2 or not all(parts):
        return {"verified": False, "reason": "app_debug_credential_unavailable"}
    status, payload, _ = transport.get("debug_token", parameters={"input_token": transport.token}, bearer="TH|" + "|".join(parts))
    token_data = payload.get("data") if isinstance(payload, dict) else None
    if status != 200 or not isinstance(token_data, dict):
        return {"verified": False, "httpStatus": status, **error_observation(status, payload)}
    scopes = token_data.get("scopes")
    valid_scopes = isinstance(scopes, list) and all(isinstance(scope, str) and re.fullmatch(r"[a-z_]{1,80}", scope) for scope in scopes)
    valid = token_data.get("is_valid") is True
    matches = token_data.get("user_id") == expected_user_id
    return {"verified": valid and matches and valid_scopes, "httpStatus": status, "isValid": valid,
            "matchesCanonicalId": matches, "appIdReported": "app_id" in token_data,
            "scopes": sorted(set(scopes)) if valid_scopes else None}


def listing_probe(transport, subject, platform):
    edge = "posts" if platform == "facebook" else "threads"
    pages, first_post, after = [], None, None
    seen_ids = set()
    for _ in range(2):
        parameters = {"fields": "id,timestamp" if platform == "threads" else "id,created_time", "limit": 2}
        if after:
            parameters["after"] = after
        status, payload, usage = transport.get(subject, edge, parameters)
        rows = payload.get("data") if isinstance(payload, dict) else None
        if status != 200 or not isinstance(rows, list):
            pages.append({"httpStatus": status, **error_observation(status, payload), "usage": usage})
            break
        ids = [row.get("id") for row in rows if isinstance(row, dict) and isinstance(row.get("id"), str)]
        if len(ids) != len(rows) or any(not re.fullmatch(r"[A-Za-z0-9_]{1,200}", subject_id) for subject_id in ids):
            pages.append({"httpStatus": status, "observation": "provider_error", "probeFailure": "invalid_listing"})
            break
        if first_post is None and ids:
            first_post = ids[0]
        paging = payload.get("paging")
        if "paging" in payload and not isinstance(paging, dict):
            pages.append({"httpStatus": status, "observation": "provider_error", "probeFailure": "invalid_paging"})
            break
        cursors = paging.get("cursors") if isinstance(paging, dict) else None
        has_next = isinstance(paging, dict) and "next" in paging
        next_after = cursors.get("after") if isinstance(cursors, dict) and has_next else None
        valid_next = has_next and isinstance(paging["next"], str) and bool(paging["next"].strip())
        valid_cursor = valid_next and isinstance(next_after, str) and 0 < len(next_after) <= 4096
        repeated = bool(after and next_after == after)
        duplicates = len(ids) - len(set(ids) - seen_ids)
        seen_ids.update(ids)
        pages.append({"httpStatus": status, "postCount": len(ids), "duplicatePostCount": duplicates,
                      "hasContinuation": has_next, "invalidContinuation": has_next and not valid_cursor,
                      "repeatedCursor": repeated, "usage": usage})
        if not valid_cursor or repeated:
            break
        after = next_after
    return {"pages": pages, "complete": bool(pages) and pages[-1].get("httpStatus") == 200
            and not pages[-1].get("hasContinuation", True)
            and all(page.get("duplicatePostCount", 1) == 0 for page in pages)}, first_post


def collect_observations(transport, subject, platform):
    today = dt.datetime.now(dt.timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    for days in (7, 14, 30, 90):
        since = today - dt.timedelta(days=days)
        for metric in METRICS[platform]["account"]:
            parameters = {"metric": metric, "since": int(since.timestamp()), "until": int(today.timestamp())}
            if platform == "facebook":
                parameters["period"] = "day"
            status, payload, usage = transport.get(subject, "insights" if platform == "facebook" else "threads_insights", parameters)
            decoded = metric_observation(payload, metric) if status == 200 and isinstance(payload, dict) and "error" not in payload else error_observation(status, payload)
            yield {"metric": metric, "level": "account", "requestedSince": since.isoformat(), "requestedUntil": today.isoformat(),
                   "httpStatus": status, "usage": usage, **decoded}
    listing, post_id = listing_probe(transport, subject, platform)
    yield {"listing": listing}
    if post_id:
        for metric in METRICS[platform]["post"]:
            status, payload, usage = transport.get(post_id, "insights", {"metric": metric})
            decoded = metric_observation(payload, metric) if status == 200 and isinstance(payload, dict) and "error" not in payload else error_observation(status, payload)
            yield {"metric": metric, "level": "post", "httpStatus": status, "usage": usage, **decoded}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--owner", required=True, type=uuid.UUID)
    parser.add_argument("--confirmed-account", required=True, type=uuid.UUID)
    parser.add_argument("--platform", required=True, choices=sorted(METRICS))
    parser.add_argument("--version", required=True, help="Explicit pinned provider version, e.g. v22.0 or v1.0")
    args = parser.parse_args()
    if not hasattr(signal, "setitimer"):
        parser.error("Live probes require the Postora POSIX server request timers")
    if not re.fullmatch(r"v[0-9]{1,2}\.0", args.version):
        parser.error("Expected pinned API version")
    report = {"scope": "read-only-capability-observation", "platform": args.platform, "requestedApiVersion": args.version,
              "startedAt": utc_now(), "capabilityVerification": "incomplete", "providerBucketTimezone": None,
              "earliestRetainedDateVerified": False, "maximumWindowVerified": False}
    transport = None
    try:
        account = read_account(str(args.owner), str(args.confirmed_account), args.platform)
        transport = ProbeTransport("graph.facebook.com" if args.platform == "facebook" else "graph.threads.net", args.version,
                                   account["access_token"], urllib.request.build_opener(NoRedirect()))
        report["targetSha256"] = hashlib.sha256(f"{args.owner}:{args.confirmed_account}".encode()).hexdigest()
        report["grantedScopes"] = facebook_granted_scopes(transport) if args.platform == "facebook" else threads_granted_scopes(transport, account["platform_user_id"])
        report["observations"] = []
        for observation in collect_observations(transport, account["platform_user_id"], args.platform):
            if "listing" in observation:
                report["listing"] = observation["listing"]
            else:
                report["observations"].append(observation)
        report["execution"] = "finished"
    except ProbeBudgetExceeded:
        report["execution"] = "budget_exhausted"
    except (RuntimeError, ValueError, subprocess.SubprocessError, OSError):
        report["execution"] = "failed"
        report["reason"] = "probe_setup_failed"
    if transport is not None:
        report["providerCalls"] = transport.calls
    report["finishedAt"] = utc_now()
    print(json.dumps(report, allow_nan=False, indent=2))
    return 0 if report["execution"] == "finished" else 1


if __name__ == "__main__":
    raise SystemExit(main())
