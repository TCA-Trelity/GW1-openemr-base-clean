# CT6 — Recurring error-analysis habit: findings log + walkthrough skill + optional trace-fetch script

REQ: R7 (observability actually used, not just emitted) · Depends on: Langfuse keys already live (USER-ACTIONS item 3 ✅); network egress for the optional script (item 9, or run from the laptop) · Band: merged-plan Track 2 (CT) · Priority: P2 (per merged-plan.md)

> **PARKED — post-submission-crunch.** Track 2's sequencing: "CT6 and CT7
> wait until after the submission crunch." Nothing here is grader-facing.

## Why

This is the one genuine gap the course-technique review found: the project
measures everything (traces, scores, ledger) but has no *human habit* of
reading real recent interactions and acting on the first thing that went
wrong in each. The habit is three cheap artifacts: a running log with a
forcing-function template (first failure only; explicit disposition), a
walkthrough skill so any future session runs the ritual identically, and an
optional read-only script that pulls recent traces so the ritual doesn't
start with 10 minutes of Langfuse clicking.

## Existing seams you MUST reuse (verified)

- `docs/execution/error-analysis.md` — **does not exist yet** (verified); this ticket creates it. Home matches the other living execution docs (`baselines.md`, `eval-results.md`, `observability.md`).
- `.claude/skills/` layout — mirror `chesterton/SKILL.md`'s frontmatter (`name:` + `description:`), same as CT5. If CT5 landed first, cross-link its skill; do not merge the two (push-time vs review-time rituals).
- Langfuse config seams (`sidecar/src/config.ts:37-42`): `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` — the script reads the SAME variable names (locally via env; on Railway they are already set on the sidecar service).
- Script home + idiom: `sidecar/src/scripts/` (verified residents: `register-oauth.ts`, `verify-pgvector.ts`, `w2-baselines.ts`, `load-test.ts`) — manual tsx-run operator scripts, package.json script entries in `sidecar/package.json:10-28`.
- Trace vocabulary to search by (docs/execution/observability.md "What the sidecar emits"): one trace per prep run keyed by correlation ID; graph turns show `supervisor` spans; outcome scores `run_success`, `citations_failed`, `facts_blocked`.
- Network reality (merged-plan header + USER-ACTIONS item 9): the executing sandbox's proxy DENIES `cloud.langfuse.com` (CONNECT 403, verified 2026-07-15). The script must therefore (a) fail with a clear egress message, and (b) be runnable from the user's laptop clone (item 0) or in-session once item 9 lands.
- Privacy rules for the LOG file (G18/P5, requirements.md:661-664 + tickets/README standing rule 6): ids, hashes, counts, stage names — never document text, patient identifiers, or extracted clinical values. The log is a committed repo file; it is bound by the same sweep discipline as logs.

## Files to create/modify

- `docs/execution/error-analysis.md` — new: intro + per-session entry template + first (possibly empty) session section.
- `.claude/skills/error-analysis/SKILL.md` — new: the walkthrough checklist.
- `sidecar/src/scripts/fetch-recent-traces.ts` — new, OPTIONAL leg: read-only Langfuse fetch.
- `sidecar/package.json` — script entry `"traces:recent": "tsx src/scripts/fetch-recent-traces.ts"`.
- `sidecar/test/fetchRecentTraces.test.ts` — new (see Tests).

## Step-by-step implementation

1. **The log file** (`docs/execution/error-analysis.md`). Header states the discipline: pull a handful of recent traces; per trace, write down the FIRST thing that went wrong and STOP (no downstream-symptom chasing); force one disposition each. Template (copied into the file verbatim, one block per session):

   ```markdown
   ## Session YYYY-MM-DD (reviewer: <name/agent>)

   Traces pulled: <N> (source: traces:recent script | Langfuse UI) · window: <e.g. last 7 days>

   | Trace / correlation id | First thing that went wrong | Disposition | Follow-up ref |
   |---|---|---|---|
   | `<id>` | <one sentence, engineer language — ids/stages/counts only, never quoted patient or document text> | fix-now \| new-eval-case \| ignore-because: <reason> | <PR/ticket/eval-case id or —> |

   Session note: <1-3 lines — patterns across entries, if any>
   ```

   Dispositions are a closed set: **fix-now** (open the fix in the same
   session or a ticket), **new-eval-case** (the flagged-output→fixture loop
   observability.md's A3 response already names — add to `sidecar/eval/`),
   **ignore-because** (the reason is mandatory, not optional).
2. **The skill** (`.claude/skills/error-analysis/SKILL.md`), frontmatter then a numbered walkthrough:
   - description triggers: "error analysis", "review traces", "what went wrong lately", "trace review session".
   - Steps: (1) pull traces — `cd sidecar && npm run traces:recent` (or the Langfuse UI path: project → Traces → sort newest, open the last ~10, prioritizing `run_success=0`, `citations_failed>0`, error-level spans); (2) per trace, find the FIRST failing/degraded span and write the one-line finding; (3) fill the table in `docs/execution/error-analysis.md` (append a new session section, never rewrite old ones); (4) execute the fix-now items or file them; (5) for new-eval-case items, note that expected answers follow the CT5 maintenance rules (re-baseline = separate labeled commit); (6) commit the log update.
3. **The optional script** (`sidecar/src/scripts/fetch-recent-traces.ts`) — read-only:
   - Reads `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` from env; missing any ⇒ print a one-line "not configured; nothing to fetch (exit 2)" (the `verify-pgvector.ts` UX pattern).
   - Calls Langfuse's public API: `GET {LANGFUSE_HOST}/api/public/traces?limit=<N>&orderBy=timestamp.desc` with HTTP Basic auth `publicKey:secretKey`. **Verify the exact path/params against the current Langfuse API reference at execution time** (network needed anyway) — the endpoint family is stable but parameters drift; adjust to what the docs say, and keep it GET-only.
   - Prints one line per trace: timestamp, trace id (= correlation id), name, scores present (`run_success`/`citations_failed`/`facts_blocked` values), latency if provided. **Print ids and numbers only — never trace input/output bodies** (they may carry chat text; the G18 rule for this repo's terminals and logs applies to script output too).
   - Flags: `--limit N` (default 10). No write endpoints, no delete, no annotation calls.
   - Egress note in the file header: sandbox proxy denies cloud.langfuse.com today (merged-plan execution note); runnable from the user's laptop clone or in-session after USER-ACTIONS item 9.
4. **Wire the npm script**, run `npm run typecheck` (script is inside the main tsconfig like its siblings).
5. Do ONE real session if network allows (laptop or item 9 landed): fill the first session section with real entries. If egress is still blocked, commit the log with an honest first entry: "Session pending network access — see USER-ACTIONS item 9", and the ticket is still complete (script + skill + log shipped; the merged plan's execution note says exercising it live "waits on network access").
6. Tests, trackers, ship.

## What NOT to do

- Do NOT chase downstream symptoms into the log — the template's forcing function is FIRST failure only; resist enriching entries with full narratives.
- Do NOT paste trace payloads, chat questions, document excerpts, or patient identifiers into the log, the skill, or script output (G18/P5 — the log is a committed file; the PHI sweep discipline applies). Synthetic demo data is not an excuse; the habit must be pilot-safe.
- Do NOT give the script any mutating capability (no annotations, no deletes) — "read-only" is a stated property the spec's reviewers rely on.
- Do NOT auto-schedule it (cron/workflow) — this is deliberately a HUMAN habit; automation of the pull is fine (the script), automation of the judgment is not.
- Do NOT block on Langfuse SDK — the raw fetch keeps the script dependency-free; the `langfuse` npm package stays a runtime-tracing dep only.
- Do NOT put the log under `docs/internal/` — it is legitimate engineering-practice evidence (like `baselines.md`); `docs/execution/` is its home. But do not link it from README either — findable, not thrust at graders (the CT1 linking philosophy).

## Acceptance checks

```bash
cd sidecar && npm run traces:recent
# keyless: prints the not-configured line and exits 2
LANGFUSE_HOST=https://cloud.langfuse.com LANGFUSE_PUBLIC_KEY=pk-lf-x LANGFUSE_SECRET_KEY=sk-lf-x npm run traces:recent
# from a network-blocked sandbox: clear egress-denied error naming the proxy, non-zero exit
ls docs/execution/error-analysis.md .claude/skills/error-analysis/SKILL.md
```

With real keys from the laptop (or post-item-9): prints ≤10 lines of
id/timestamp/scores, zero payload text. `npm test`, `npm run typecheck`
green.

## Tests to add

`sidecar/test/fetchRecentTraces.test.ts` (the script exports its core as a
function taking an injected `FetchLike`, same seam style as the codebase):

- `it('formats trace lines from a canned public-API response with ids and scores only')` — feed a fixture JSON containing an `input`/`output` field with a planted canary string; assert the canary NEVER appears in the formatted output (the G18 property as a test).
- `it('exits not-configured cleanly when any of the three env vars is absent')`.
- `it('surfaces a network failure as a single clear error, not a stack trace')`.

## Tracker updates

- `docs/internal/build-status.html` DATA block: ticket `CT6` (T2 section) → `s: "done"`.
- `docs/w2/requirements.md` — no checkbox; do not invent one.
- `W2_ARCHITECTURE.md` §8 (Observability) — optional one-line pointer to the log file in the prose; skip if it reads as clutter.

## Verify + ship ritual

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

Panel untouched — skip the panel leg. Then: conventional commit
(`feat(ct6): error-analysis log + skill + read-only trace fetch script`)
with `--trailer "Assisted-by: Claude Code"` (trackers in the SAME commit) →
`git push -u origin claude/merged-eval-course-plan-ky6ulh` → update the
PR #16 body → SendUserFile `docs/internal/build-status.html`.
