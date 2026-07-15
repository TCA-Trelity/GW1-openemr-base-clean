# H.12 — Trace-reconstruction CLI + PHI re-audit of new log lines

REQ: R7 (per-encounter reconstruction box + logs-privacy box), G4, G18 · Depends on: H.8 (the walk fixes the drops this tool would otherwise expose) · Band: merged-plan Track 1 · Priority: P2 (per merged-plan.md)

## Why

R7's first box: everything about one encounter must be reconstructable from a
single correlation ID — tool/worker sequence, latency by step, tokens, cost,
retrieval hits, extraction confidence. The events exist (G5) and the register's
worked example proves the grep recipe (`docs/w2/trace-example.md`), but "grep
and squint" is not a tool. This ticket ships a small CLI that turns a log
stream + correlation id into the request's story, plus the recurring half of
G18 hygiene: one audit pass over every log line **added since the last sweep
(2026-07-14)**, folding anything new into the enforcement precedent
(`eval/phi-log-sweep.eval.ts`) so the check stays executable, not aspirational.

## Existing seams you MUST reuse

- `src/scripts/register-oauth.ts` — the CLI house pattern: env/argv input, `console.error` for prose + `process.exit(1|2)` on misuse, header comment stating the run command; `sidecar/package.json` `scripts` block is where the new entry goes (alongside `"baseline:w2"`, `"seed-ehr"`, …).
- `docs/w2/trace-example.md` — the verbatim event lines (Run 1/Run 2) are your test fixtures, and the doc is where the tool gets documented (it IS the G4 worked-example surface); the 7 expected boundaries come from H.8's audit table there.
- Event vocabulary to reconstruct from (G5): `worker_handoff {correlation_id, patient_id, from, to, routing_reason}`, `ingestion_<stage>` (+ `detail`), `extraction_field_outcome {field, outcome}`, `retrieval_hit|retrieval_miss {query_hash, hits, chunk_ids, rerank_applied}`, `evidence_pinned {ingestion_id, pinned}`, `evidence_degraded {budget_ms}`, `critic_flags {blocked, prescriptive_flags}`.
- **Key-spelling wart (verified, handle it):** the codebase logs BOTH `correlation_id` (graph/ingest/retrieval events) and `correlationId` (e.g. `routes/chat.ts:246-248` warn lines, `obs/langfuse.ts` warns). The tool must match either key. Do not "fix" the spelling repo-wide in this ticket (that's a churn-heavy rename touching the PHI sweep and trace-example verbatims — note it in the PR as a candidate follow-up instead).
- Postgres joins (optional `--db` mode): `llm_calls` rows carry `correlation_id, purpose, model, input_tokens, output_tokens, est_cost_usd` (see the INSERT at `src/server.ts:498`); `prep_runs` and `chat_messages` also carry correlation ids (`src/store/` — verify column names in `store/migrate.ts` before writing SQL).
- `eval/phi-log-sweep.eval.ts` — the enforcement precedent: `capturingLogger(lines)` (:45-50), `CANARIES` (:28), `sweep(lines)` (:52-54); new event types found in the audit join THESE cases.
- `git log --since=2026-07-14 -p -- sidecar/src` — the audit window (the last sweep/verification pass is dated 2026-07-14 throughout requirements.md).

## Files to create/modify

- **Create** `sidecar/src/scripts/trace-reconstruct.ts` — the CLI; core logic exported as a pure function for tests.
- **Modify** `sidecar/package.json` — `"trace": "tsx src/scripts/trace-reconstruct.ts"`.
- **Create** `sidecar/test/trace-reconstruct.test.ts`.
- **Modify** `sidecar/eval/phi-log-sweep.eval.ts` — only if the audit finds new logged event types/fields to cover (see step 4).
- **Modify** `docs/w2/trace-example.md` — a short `## Reconstructing with the tool` section (command + sample output).
- Trackers: `docs/w2/requirements.md`, `docs/internal/build-status.html`, `W2_ARCHITECTURE.md` §8.

## Step-by-step implementation

1. **Core function** (exported): `reconstructTimeline(lines: string[], correlationId: string): Reconstruction` where `Reconstruction = { events: TimelineEvent[]; boundaries: { name: string; seen: boolean }[]; summary: {...} }`. Behavior:
   - A line matches when it parses as JSON (tolerate a non-JSON prefix — pino lines are pure JSON; captured-eval lines are `msg {json}`; try both) and `correlation_id === id || correlationId === id`.
   - `TimelineEvent`: `{ at?: string; msg: string; detail: string }` — detail is a compact human line per event type (e.g. `supervisor→intake_extractor (document upload event (rule))`, `ingestion_grounded: 11 word_box / 2 page / 1 unverified`, `retrieval_hit: 4 chunks, rerank_applied=false`). Order: input order (timestamps when present).
   - Latency by step: compute deltas between consecutive `ingestion_<stage>` `at` timestamps when present (`IngestionStage.at` rides the record; stage log events carry pino `time` when from pino — use what exists, print `n/a` honestly when absent).
   - `boundaries`: the 7 legs from H.8's audit table, each marked seen/not-seen from the events (e.g. OpenEMR write leg = `ingestion_stored_ehr*` seen).
   - **PHI rule:** the tool prints what the logs contain — because logs are ids/hashes/counts by construction, so is the output; do NOT add any store lookups that would print document text or fact values.
2. **CLI wrapper**: `npm run trace -- <correlation-id> [--file path]` — reads NDJSON from `--file` or stdin (`railway logs | npm run trace -- <id>` is the documented production recipe; sandbox egress note: Railway is unreachable from this environment, so the doc names the laptop/CI as where the piped form runs). Optional `--db` flag: when `DATABASE_URL` is set, also query `llm_calls` (tokens + est cost per purpose) and include a cost/token block — degrade with a printed note when unset. Exit 0 with a report; exit 2 when zero lines matched (misuse signal, register-oauth pattern).
3. **Output**: human timeline + a trailing single-line JSON summary (machine-consumable, mirrors `w2-baselines.ts`'s `JSON:` convention).
4. **PHI re-audit pass** (executed as part of this ticket, recorded in the PR + doc):
   - Enumerate log-emitting lines added since 2026-07-14: `git log --since=2026-07-14 -p -- sidecar/src | grep -E '^\+.*(logger|log)\.(info|warn|error)\(|^\+.*console\.(log|warn|error)\('` and review each `+` line for payload content (names, quotes, extracted values, document text).
   - For any NEW event type not exercised by `phi-log-sweep.eval.ts`'s two captures, extend the sweep so the capturing logger path covers it (same canaries, zero-leak threshold). If the audit is clean and no new event types exist, say exactly that in the PR body and the doc note — do not add a ceremonial test.
   - Record the audit (date, window, method, result) as 2–3 lines in the new trace-example.md section.
5. Tests, trackers, ship.

## What NOT to do

- Do NOT have the tool fetch logs from Railway/Langfuse itself — sandbox egress is denied (merged-plan header note); stdin/file input keeps it runnable everywhere, including over CI artifacts and eval captures.
- Do NOT print or derive any patient-content values — the tool is a projection of already-PHI-free logs; adding store lookups for "richer" output is how PHI leaks into terminals (P5).
- Do NOT normalize the `correlation_id`/`correlationId` spelling across the codebase in this ticket — match both, note the wart.
- Do NOT wire the tool into CI or the eval gate — it is an operator tool (same posture as `baseline:w2`).
- Do NOT relax `phi-log-sweep.eval.ts` thresholds while extending it — zero-leak stays zero-leak (standing rule 1/6).

## Acceptance checks

```bash
cd sidecar && npx vitest run test/trace-reconstruct.test.ts
cd sidecar && npm test && npm run typecheck
# smoke over the committed worked example (fixture file assembled from trace-example.md lines):
cd sidecar && npm run trace -- w2-demo-7f3a --file test/fixtures/trace-lines.ndjson   # prints the Run 1 story, exit 0
cd sidecar && npm run trace -- no-such-id --file test/fixtures/trace-lines.ndjson; echo $?   # exit 2
```

(Place the fixture wherever the test wants it — `test/fixtures/` shown; keep the
verbatim trace-example.md lines as its content so doc and tool can never drift.)

## Tests to add (`test/trace-reconstruct.test.ts`)

- `it('reconstructs the Run 1 upload story from the committed worked-example lines — order, handoffs, pin counts')` (fixture = the five verbatim lines from trace-example.md).
- `it('matches both correlation_id and correlationId spellings — chat-route warn lines must not vanish from the story')`.
- `it('excludes other correlation ids and non-JSON noise lines')`.
- `it('reports unseen boundaries honestly — a run with no retrieval events marks that leg not-seen instead of inventing it')`.
- `it('exits 2 (returns empty) when nothing matches')` — assert the pure function's empty result; CLI exit code covered by the smoke check above.

## Tracker updates

- `docs/w2/requirements.md` — under **R7** (~:368), flip to `[x]` (verbatim lines):

  ```
  - [ ] Per encounter, reconstructable from one correlation ID: tool/worker
    sequence, latency by step, token usage, cost estimate, retrieval hits
    (query-hash, chunk_ids, scores — never patient text), extraction confidence
    (per document and per field), eval outcome where applicable.
  ```

  Append annotation: `*(H.12: npm run trace — timeline + boundary coverage from a log stream; tokens/cost join via --db (llm_calls); extraction confidence from grounding stage events; eval outcome joins by eval_run_outcome lines when present in the stream.)*`
- `docs/w2/requirements.md` — under **R7** (~:384), the box (verbatim lines):

  ```
  - [ ] Logs/traces contain identifiers and hashes, never raw document text,
    patient identifiers, or extracted clinical values (spec privacy audit
    language — G18); extraction confidence and retrieval scores are logged as
    numbers.
  ```

  Flip to `[x]` **only if** step 4's audit is clean; annotate with the audit date + window (e.g. `*(Re-audited H.12, window 2026-07-14→…: N new log sites reviewed, 0 payload leaks; sweep coverage extended for <events|none>.)*`). If the audit finds a leak: fix it in this PR, then flip.
- `docs/internal/build-status.html` DATA block: ticket `H.12` (L455) `s: "pending"` → `"done"`; reqGroups: `R7` row `done: 3, total: 5` → `done: 5` (or `4` if the :383 box stayed open), `s:` accordingly.
- `W2_ARCHITECTURE.md` — §8 "Shipped spine" (or the per-encounter bullet at :313-316): append `— reconstructable via npm run trace (H.12)`.

## Verify + ship ritual

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

Panel untouched — skip the panel leg. Then: conventional commit with
`--trailer "Assisted-by: Claude Code"` (trackers in the SAME commit) →
`git push -u origin claude/merged-eval-course-plan-ky6ulh` → update PR #16
body (checklist line for H.12) → SendUserFile
`docs/internal/build-status.html` (rendered inline).
