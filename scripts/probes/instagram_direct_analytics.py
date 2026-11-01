#!/usr/bin/env python3
"""Bounded read-only Instagram Login observations; never accepts Page-linked credentials."""
import argparse
import datetime as dt
import hashlib
import json
import re
import subprocess
import uuid

import meta_owned_analytics as shared

ACCOUNT_METRICS = ("reach", "views", "accounts_engaged", "total_interactions")
MEDIA_METRICS = ("views", "reach", "shares", "total_interactions")


def read_direct_account(owner_id, account_id):
    owner_id, account_id = str(uuid.UUID(owner_id)), str(uuid.UUID(account_id))
    # OAuth's direct writer owns these canonical columns. Messaging aliases are not insight IDs.
    query = f"""BEGIN READ ONLY; SELECT json_build_object('platform_user_id', platform_user_id,
        'access_token', access_token) FROM public.social_accounts
        WHERE user_id='{owner_id}' AND id='{account_id}' AND platform='instagram'
        AND is_active AND ig_auth_type='business_login'; COMMIT;"""
    completed = subprocess.run(["docker", "exec", shared.DB_CONTAINER, "psql", "-U", "postgres", "-d", shared.DB_DATABASE,
                                "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", query],
                               capture_output=True, text=True, timeout=10, check=False)
    if completed.returncode or not completed.stdout.strip():
        raise RuntimeError("Owned active Instagram Login account unavailable")
    account = json.loads(completed.stdout)
    if not isinstance(account, dict) or not isinstance(account.get("access_token"), str) or not account["access_token"]:
        raise RuntimeError("Direct credential unavailable")
    if not isinstance(account.get("platform_user_id"), str) or not re.fullmatch(r"[0-9]{1,40}", account["platform_user_id"]):
        raise RuntimeError("Direct insight identity unavailable")
    return account


def observation(status, payload, metric):
    return shared.metric_observation(payload, metric) if status == 200 and isinstance(payload, dict) and "error" not in payload else shared.error_observation(status, payload)


def direct_permissions(transport, subject):
    status, payload, usage = transport.get(subject, "permissions")
    rows = payload.get("data") if isinstance(payload, dict) else None
    if status != 200 or not isinstance(rows, list):
        return {"verified": False, "httpStatus": status, "usage": usage, **shared.error_observation(status, payload)}
    return {"verified": True, "httpStatus": status, "usage": usage, "scopes": sorted({row["permission"] for row in rows
            if isinstance(row, dict) and row.get("status") == "granted" and isinstance(row.get("permission"), str)
            and re.fullmatch(r"instagram_business_[a-z_]{1,70}", row["permission"])})}


def media_listing(transport, subject):
    pages, first_media, after, seen_ids, seen_cursors = [], None, None, set(), set()
    for _ in range(2):
        parameters = {"fields": "id,media_type,timestamp", "limit": 2}
        if after:
            parameters["after"] = after
        status, payload, usage = transport.get(subject, "media", parameters)
        rows = payload.get("data") if isinstance(payload, dict) else None
        if status != 200 or not isinstance(rows, list):
            pages.append({"httpStatus": status, "usage": usage, **shared.error_observation(status, payload)})
            break
        ids = [row["id"] for row in rows if isinstance(row, dict) and isinstance(row.get("id"), str) and re.fullmatch(r"[0-9]{1,40}", row["id"])]
        if len(ids) != len(rows):
            pages.append({"httpStatus": status, "observation": "provider_error", "probeFailure": "invalid_media_listing"})
            break
        first_media = first_media or (ids[0] if ids else None)
        paging = payload.get("paging")
        cursors = paging.get("cursors") if isinstance(paging, dict) else None
        next_cursor = cursors.get("after") if isinstance(cursors, dict) and paging.get("next") else None
        valid_cursor = isinstance(next_cursor, str) and 0 < len(next_cursor) <= 4096
        repeated = valid_cursor and next_cursor in seen_cursors
        pages.append({"httpStatus": status, "postCount": len(ids), "duplicatePostCount": len(ids) - len(set(ids) - seen_ids),
                      "hasContinuation": bool(isinstance(paging, dict) and paging.get("next")), "repeatedCursor": repeated,
                      "invalidContinuation": bool(isinstance(paging, dict) and paging.get("next")) and not valid_cursor, "usage": usage})
        seen_ids.update(ids)
        if not valid_cursor or repeated:
            break
        seen_cursors.add(next_cursor)
        after = next_cursor
    return {"pages": pages, "complete": bool(pages) and pages[-1].get("httpStatus") == 200
            and "probeFailure" not in pages[-1] and not pages[-1].get("hasContinuation", True)}, first_media


def direct_observations(transport, subject):
    end = dt.datetime.now(dt.timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    for days in (7, 14, 30, 90):
        start = end - dt.timedelta(days=days)
        for metric in ACCOUNT_METRICS:
            status, payload, usage = transport.get(subject, "insights", {"metric": metric, "period": "day", "metric_type": "total_value",
                "since": int(start.timestamp()), "until": int(end.timestamp())})
            yield {"level": "account", "metric": metric, "requestedSince": start.isoformat(), "requestedUntil": end.isoformat(),
                   "httpStatus": status, "usage": usage, **observation(status, payload, metric)}
    listing, media_id = media_listing(transport, subject)
    yield {"listing": listing}
    if media_id:
        for metric in MEDIA_METRICS:
            status, payload, usage = transport.get(media_id, "insights", {"metric": metric})
            yield {"level": "post", "metric": metric, "httpStatus": status, "usage": usage, **observation(status, payload, metric)}


def run_probe(owner_id, account_id, version):
    report = {"scope": "read-only-direct-login-observation", "platform": "instagram", "credentialContext": "business_login",
              "requestedApiVersion": version, "startedAt": shared.utc_now(), "capabilityVerification": "incomplete",
              "providerBucketTimezone": None, "earliestRetainedDateVerified": False, "maximumWindowVerified": False,
              "observations": []}
    transport = None
    try:
        account = read_direct_account(owner_id, account_id)
        transport = shared.ProbeTransport("graph.instagram.com", version, account["access_token"])
        status, identity, usage = transport.get("me", parameters={"fields": "id,user_id,username,account_type"})
        matched = status == 200 and isinstance(identity, dict) and identity.get("id") == account["platform_user_id"]
        report["identity"] = {"httpStatus": status, "matchesCanonicalId": matched, "usage": usage}
        if not matched:
            report.update(execution="failed", reason="direct_identity_unverified")
        else:
            report["targetSha256"] = hashlib.sha256(f"{owner_id}:{account_id}".encode()).hexdigest()
            report["grantedScopes"] = direct_permissions(transport, account["platform_user_id"])
            status, profile, usage = transport.get(account["platform_user_id"], parameters={"fields": "followers_count,media_count"})
            report["profileObservation"] = {"httpStatus": status, "observedAt": shared.utc_now(), "usage": usage}
            if status == 200 and isinstance(profile, dict) and "error" not in profile:
                report["profileObservation"]["measurements"] = {metric: profile[metric] for metric in ("followers_count", "media_count")
                                                                if shared.finite_number(profile.get(metric))}
            else:
                report["profileObservation"].update(shared.error_observation(status, profile))
            for receipt in direct_observations(transport, account["platform_user_id"]):
                if "listing" in receipt:
                    report["listing"] = receipt["listing"]
                else:
                    report["observations"].append(receipt)
            report["execution"] = "finished"
    except shared.ProbeBudgetExceeded:
        report["execution"] = "budget_exhausted"
    except (RuntimeError, ValueError, subprocess.SubprocessError, OSError):
        report.update(execution="failed", reason="probe_setup_failed")
    if transport:
        report["providerCalls"] = transport.calls
    report["finishedAt"] = shared.utc_now()
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--owner", required=True, type=uuid.UUID)
    parser.add_argument("--confirmed-account", required=True, type=uuid.UUID)
    parser.add_argument("--version", required=True, choices=["v22.0"])
    args = parser.parse_args()
    if not hasattr(shared.signal, "setitimer"):
        parser.error("Live probes require the Postora POSIX server request timers")
    report = run_probe(str(args.owner), str(args.confirmed_account), args.version)
    print(json.dumps(report, allow_nan=False, indent=2))
    return 0 if report["execution"] == "finished" else 1


if __name__ == "__main__":
    raise SystemExit(main())
