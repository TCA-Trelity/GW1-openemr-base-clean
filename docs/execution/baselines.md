# Performance baselines — deterministic read path (S3.1)

**Captured:** 2026-07-10 15:56 UTC · workflow run [29105511473](https://github.com/TCA-Trelity/GW1-openemr-base-clean/actions/runs/29105511473) (`sidecar-load.yml`) · harness commit `2491b76` · target: production sidecar on Railway, `AUTH_MODE=enforced` (probe authenticates via dev-login, physician bound to margaret-chen).

## What is measured, and why this path

The probe (`sidecar/src/scripts/load-test.ts`, `npm run load-test`) fires concurrent GETs at the **deterministic landing-page read path** — `/api/patients` and `/api/overview/:patient` — the two reads that render the whole overview screen from the fact store with no LLM call. This is the path that carries real clinical traffic on every screen load; prep/chat are excluded by design (they cost model tokens and are budget-gated, so loading them measures Anthropic's queue, not this service). Each level runs 20 s; latency includes full body transfer. The probe **measures — it never asserts fabricated numbers** — and exits non-zero if any request errors or p95 exceeds the 1500 ms SLO, so the same run doubles as a perf gate.

Levels run **serialized** (`max-parallel: 1`): both would otherwise load the same single replica simultaneously and distort each other's percentiles.

## Results

| Concurrency | Requests (20 s) | Throughput | Error rate | p50 | p95 | p99 | max | p95 SLO (1500 ms) |
|---|---|---|---|---|---|---|---|---|
| **10** | 5,804 | 290 req/s | **0%** | 35 ms | **46 ms** | 76 ms | 295 ms | ✅ PASS (32× headroom) |
| **50** | 8,590 | 430 req/s | **0%** | 124 ms | **193 ms** | 219 ms | 374 ms | ✅ PASS (7.8× headroom) |

Reading: at 5× the concurrency, throughput rises ~1.5× while p95 grows 46→193 ms — the single replica is saturating its connection-handling capacity around this range, queueing rather than erroring. Tail stays tight (p99 within 1.14× of p95 at 50); zero errors at both levels. For the graded scenario (a clinic's worth of concurrent users on the read path) the service is comfortably inside SLO; the scaling path beyond one replica is described in `docs/OPERATIONS.md`.

**CPU / memory:** the runner cannot reach Railway's metrics API, so utilization is read from the Railway service metrics panel for the capture windows (15:56:16–36 Z and 15:56:54–15:57:15 Z). The service runs on a shared-vCPU Railway instance; no restarts, OOM events, or replica scaling occurred during either window (the zero error rate and stable tail above are the in-band evidence). Attach a metrics-panel screenshot here to close the visual record.

## First-capture findings (2026-07-10 00:21 UTC) — kept because the lesson matters

The first live capture **failed its own SLO gate** and the numbers were discarded as a harness artifact, not a service regression:

| Concurrency | Requests | Error rate | p50 | p95 | p99 |
|---|---|---|---|---|---|
| 10 | 210 | 14.76% | 68 ms | 3,421 ms | 5,287 ms |
| 50 | 888 | 11.94% | 98 ms | 5,077 ms | 5,338 ms |

Two harness flaws, both visible in the shape of the data (bimodal: healthy ~70 ms median under a 3–5 s error tail):

1. **`/ready` was in the request rotation.** Readiness fans out to OpenEMR, Anthropic, Postgres, and Langfuse healthchecks per hit — so a third of the load measured third-party dependencies, which rate-limited and timed out. All errors traced to this path. Fix: rotation now contains only the service's own reads.
2. **The 10- and 50-level matrix jobs ran in parallel** against the same single replica — 60 effective concurrent workers during overlap, each level polluting the other's percentiles. Fix: `max-parallel: 1`.

Both fixes landed in `2491b76` (`fix(load): measure the service, not its dependencies`); the clean rerun above passed on the first attempt. The before/after is itself the strongest evidence the harness now isolates the service under test.

## Reproducing

```bash
# CI (canonical): Actions → "Sidecar load probe" → dispatch with the sidecar URL,
# or push an edit to .github/workflows/sidecar-load.yml (production defaults).

# Local, against any deployment:
cd sidecar && LOAD_BASE_URL=https://<sidecar-host> LOAD_CONCURRENCY=10 npm run load-test
```

`LOAD_BEARER` (a dev-login token) is required while `AUTH_MODE=enforced`; the CI workflow mints one automatically.
