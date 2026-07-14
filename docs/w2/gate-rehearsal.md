# Hard-gate rehearsal: three injected regressions, three caught

**Requirement:** D.7 (REQ S4/R6, deliverable D5) — *"Graders will inject a regression to
test the gate — treat it as a hard gate."* This document is the rehearsal: three
deliberately-injected regressions, one per failure style, each caught by a different
rubric category through its intended tier. Everything below is verbatim output from
`npm run gate-rehearsal` (sidecar), which is committed and repeatable — the same three
faults can be re-injected on any clone in one command.

## How it works

`sidecar/eval/rehearsal/` holds three small patches against the shipped pipeline and a
runner (`run-rehearsal.sh`, wired as `npm run gate-rehearsal`). For each leg the runner:

1. applies the fault patch to a clean tree,
2. runs the full eval suite + category gate (`npm run eval`),
3. reverses the patch (always — even if the run crashes),
4. **fails unless** the eval exited non-zero *and* the expected category is the one
   flagged.

The runner itself exits non-zero if any injected regression slips through, so the
rehearsal is CI-runnable evidence, not a one-off transcript.

| Leg | Fault (patch) | What it simulates | Category expected to catch it | Tier exercised |
|---|---|---|---|---|
| A | `a-citation-drop.patch` — `factsOf`'s citation builder returns `[]` | A refactor that persists extracted facts **without citations** | `citation_present` | **Safety: any newly-failing case fails the build** |
| B | `b-schema-retry-skip.patch` — the validation-feedback retry is deleted | A "simplification" that quietly weakens schema enforcement recovery | `schema_valid` | **Quality: >5-point drop vs baseline AND below absolute threshold** |
| C | `c-phi-log-leak.patch` — the full extraction payload is logged | A debug log line that ships PHI into the log stream | `no_phi_in_logs` | **Safety: any newly-failing case fails the build** |

## Leg A — dropped citations (safety, per-case)

```
=== rehearsal leg A: inject a-citation-drop.patch — expect the gate to flag citation_present ===
 FAIL  eval/extraction.eval.ts > extraction goldens — citation_present > every persisted fact carries a per-field citation back to the source document
 FAIL  eval/extraction.eval.ts > extraction goldens — citation_present > a quote NOT in the document lands unverified with NO location — never citable geometry
category gate (tiered — safety per-case, quality >5%-vs-baseline or threshold):
  - citation_present: FAIL 11/13 — safety tier: 2 failing case(s) — any failure fails the build
  => GATE FAIL
rehearsal leg A: OK — gate failed and flagged citation_present
```

No percentage math applies: two newly-failing safety cases fail the build outright.

## Leg B — weakened schema enforcement (quality, baseline math)

```
=== rehearsal leg B: inject b-schema-retry-skip.patch — expect the gate to flag schema_valid ===
 FAIL  eval/extraction.eval.ts > extraction goldens — schema_valid > invalid first output triggers ONE feedback retry, then completes
category gate (tiered — safety per-case, quality >5%-vs-baseline or threshold):
  - schema_valid: FAIL 4/5 — pass rate 80.0% regressed >5 points vs baseline 100.0%; pass rate 80.0% below absolute threshold 90%
  => GATE FAIL
rehearsal leg B: OK — gate failed and flagged schema_valid
```

This is the tiered quality math working as designed: the drop is measured against the
**committed** baseline (`eval/baseline.json`) and against the category's absolute
threshold — both trip here, and either alone fails the gate.

## Leg C — PHI in the logs (safety, per-case)

```
=== rehearsal leg C: inject c-phi-log-leak.patch — expect the gate to flag no_phi_in_logs ===
category gate (tiered — safety per-case, quality >5%-vs-baseline or threshold):
  - no_phi_in_logs: FAIL 1/3 — safety tier: 2 failing case(s) — any failure fails the build
  => GATE FAIL
rehearsal leg C: OK — gate failed and flagged no_phi_in_logs
```

The D.5 log-capture sweep (planted name/DOB/family/allergy canaries over real pipeline
runs) is what catches this — a single leaked canary anywhere in the captured log stream
is a safety failure no baseline forgives.

## Result

```
=== rehearsal PASSED: all three injected regressions were caught by the gate ===
```

## Where the gate runs

The same `npm run eval` gate fires in three places, so an injected regression is caught
at whichever boundary it first crosses:

1. **Pre-push git hook** (`.githooks/pre-push`, installed via `npm run hooks:install`)
   — blocks the push when the outgoing range touches `sidecar/**`.
2. **CI on pull_request** (`.github/workflows/evals.yml`) — the PR-blocking leg
   (0.5 DONE 2026-07-13: `Run eval suite` is a required check on `main`).
3. **Locally on demand** — `npm run eval`; `npm run gate-rehearsal` re-runs this
   entire rehearsal.

Re-baselining is deliberate by design: a legitimate distribution change requires
`npm run eval:baseline` and a **committed** `eval/baseline.json` diff that a reviewer
sees — the gate cannot be moved silently.
