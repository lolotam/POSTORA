# Publishing timeout and retry follow-ups

Owner scope: fix timeout/retry behavior across social platforms after durable publishing requests, and keep platform notifications separate from backend changes.

## Shared acceptance rules

- Retry only the selected failed account; successful accounts remain untouched.
- A queued request is not a successful publish. Preserve the acceptance stamp and current request fencing.
- Bound transport by the actual remaining worker lifetime. An abort is not remote cancellation.
- An unanswered publishing request is an unknown outcome; never blindly resend it.
- Preserve an available provider operation/container ID and reconcile it before another publish.
- Retain failure, partial, unknown and provider-unsupported outcomes distinctly; never report fabricated success.

## Source inventory and delivery order

1. Threads: child preparation/checkpoint and publish-response recovery in this candidate; focused tests and actual entrypoint compilation, then normal review and CI. Production validation still required.
2. Instagram: retain the current reel/carousel resume and ambiguous-publish reconciliation. Existing regression suite runs with the Threads candidate. Review remaining direct fetches by stage before altering them.
3. TikTok: preserve publish-ID recording and its separate final-status poller; audit media upload and worker exhaustion without bypassing its review/consent contract.
4. YouTube: inspect resumable upload session persistence and terminal video-ID recording. Reuse a confirmed upload session rather than start another on an ambiguous response.
5. Facebook, LinkedIn, Pinterest, Reddit, X and Bluesky: inspect create/upload/publish boundaries separately. Current functions still contain direct fetch calls; their presence is an audit lead, not proof that every call is unbounded. Implement provider-specific reconciliation or explicit unknown/refused retry before imposing a publish timeout.

Each remaining platform gets a bounded patch and tests for successful response, definite refusal, transport loss, worker expiry, retry fencing, and no duplicate publish. Do not claim all-platform remediation from the Threads changes. Do not expand collection policy, secrets, paid integrations, migrations or production activation by implication.

## Evidence

The shared entrypoint already refuses spent workers for resumed, scheduled and stamped durable requests; existing accepted-request behavior must remain. Local static inventory alone does not demonstrate provider behavior. Close each platform only with current source tests, normal CI/review and an explicitly scoped live receipt where required.
