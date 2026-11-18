# Postora CI critical path and measurement

Waleed owns the measurement and two-week report. Track rollout and the **2026-12-02** Kuwait-time checkpoint in [Postora issue #438](https://github.com/lolotam/POSTORA/issues/438). If CI rolls out later, set the final comparison due date to 14 calendar days after rollout and post the rollout status at the checkpoint.

## Before rollout

Five distinct successful code PRs, all first attempts on GitHub-hosted `ubuntu-24.04`. Wall time starts at the CI run creation timestamp and ends at the last check completion in the named cohort. Runner time sums job start-to-finish durations and excludes queue time. These are measured job minutes, not billing records.

| CI run | Core gate wall time | Core runner minutes | Both browser checks ran | Runner minutes including browser checks |
| --- | ---: | ---: | --- | ---: |
| [44113995137](https://github.com/lolotam/POSTORA/actions/runs/44113995137) | 11m 56s | 27.78 | Yes | 35.48 |
| [43919780933](https://github.com/lolotam/POSTORA/actions/runs/43919780933) | 13m 57s | 36.62 | Yes | 46.82 |
| [43861731716](https://github.com/lolotam/POSTORA/actions/runs/43861731716) | 12m 20s | 31.45 | No | — |
| [43697917412](https://github.com/lolotam/POSTORA/actions/runs/43697917412) | 11m 17s | 28.87 | Yes | 38.95 |
| [43670153330](https://github.com/lolotam/POSTORA/actions/runs/43670153330) | 13m 14s | 34.90 | Yes | 44.55 |

Core medians (`n=5`) are **12m 20s** and **31.45 aggregate runner minutes**. For the browser-inclusive cohort (`n=4`), medians are **12m 35s** and **41.75 aggregate runner minutes**. Browser jobs finished ahead of the core CI gate in all four.

The latest 30 CI pull-request runs at baseline were 22 successes, four failures, and four cancellations, all attempt 1. This reliability cohort includes repeated pushes to the same PR and is separate from the five-run timing cohort. No historical per-job peak resource readings were available in the Actions job summaries. Runner labels match. Per-run image revision and dependency-cache warmth were not established, so the baseline has that comparability limit. There is no explicit package-cache step in the affected jobs on the baseline workflow. The GitHub branch APIs reported no branch protection or effective rules for main when sampled. The named checks below remain Postora's merge criteria, implemented as workflow outcomes.

## Change and applicability

- Build and typecheck already start as independent matrix jobs. Both path-filtered browser jobs already run independently of the main build, using isolated SQL and Auth and their existing fixture safety steps. Their order and triggers stay intact.
- Deno was the last core job in three runs, and Vitest in two. In [the newest sample](https://github.com/lolotam/POSTORA/actions/runs/44113995137), the isolated analytics deadline step occupied 285 of the Deno job's 712 seconds. It uses synthetic dependencies and standalone Deno imports, so it can run on its own runner alongside the remaining Deno suites. Both must be successful for **Deno service proxy and MCP**.
- Vitest's two isolated shards partition the original file inventory. Both must be successful for **npm run test**. Each shard records runner memory before execution and the test process's peak RSS via GNU time. Peak process RSS is an indicator, not total worker-tree memory. Check pass/fail/retry evidence and spot-check runner logs after rollout. Extra runners, repeat setup and the two aggregation jobs can increase runner minutes even as wall time falls.
- The Postgres job shares one migrated disposable database across its integration steps. It is not on the measured critical path and splitting it would repeat setup or change isolation assumptions.
- The Actions workflows do not build multiple Docker targets or a pre-merge staging image. The repository Dockerfile has a builder stage and one final nginx image. The database pull/service is not an image build. Shared-stage reuse across targets and two-build memory validation do not apply. Moving an image build to main would lose pre-merge image validation if such a gate is introduced. It requires a separate impact review and applicable approval. Existing image release and deployment paths are unchanged.

## After rollout

Record the rollout SHA/date and update the tracker due date. Use five successful first-attempt code PR runs on distinct branches with the same runner class and equivalent checks. Keep main and reruns separate. Keep path-filtered browser runs in the expanded cohort only and separate clearly different image/cache conditions. Record missing metadata and any timing differences that change which job is last. Include all observations, including errors, cancellations, timeouts, OOM signals and retries, in the reliability cohort separately from successful timing runs.

After two weeks, report sample sizes, baseline and rollout medians, and rollout minus baseline in seconds/minutes and percent. Include the cost and reliability tradeoffs and any resource pressure you can substantiate. Report available samples and limitations if the window yields fewer than five comparable runs.
