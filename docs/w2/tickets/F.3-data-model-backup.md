# F.3 — Data authority + backup & recovery runbook (execution-plan ticket **F.4**)

REQ: G18, G1 · Plan ticket: **F.4** in `docs/w2/execution-plan.md` (filename kept for spec-set stability) · Depends on: — · Band: 3

## Why

G18's last real gap: "Today this runbook does not exist." The fact store is a
**derived view** — its recovery primitive is wipe-and-rebuild, which is a
design property worth stating precisely, not a backup afterthought. This
ticket writes the backup/recovery runbook, verifies the §10 data-authority
table against as-built reality, and closes the G1 "no silent overwrites"
paperwork. For Dan: if the sidecar DB vanished mid-clinic, the honest answer
is "one prep cycle, minutes" — this document is where that answer lives.

## Existing seams you MUST reuse

- `W2_ARCHITECTURE.md` §14 (`## 14. Backup & recovery (REQ: G18) — [TARGET]`) — the committed DESIGN this runbook operationalizes verbatim: postures by store (OpenEMR = system of record; fact store = derived, wipe-and-rebuild; corpus + golden set = repo, `git checkout`); automatic = Railway Postgres scheduled backups; manual = documented `pg_dump`/restore; estimates RPO ≤24 h via backup but ~0 for rebuildables, RTO restore ≤30 min / full re-prep ≤1 h; invariant: golden set reproducible from the repo alone.
- `W2_ARCHITECTURE.md` §10 (`## 10. Data model, authority, lineage (REQ: G1, G18) — [TARGET]`) — the six-row authority table (source document / extracted labs / intake facts / guideline chunks / citation records / eval golden set) + the overwrite policy paragraph ("deterministic IDs + wipe-and-rewrite … the shipped `ehrSync.ts` pattern; OpenEMR documents append-only with caller-side hash dedupe").
- `docs/RUNBOOK.md` — letter-keyed activation sections `## A.`–`## D.`; the backup section joins as `## E.`. Live URLs at its top (sidecar + EHR Railway services).
- Non-derivable state, verified in source: the `llm_calls` ledger (`src/prep/budget.ts` insert :81-92) and ingestion records (**currently `MemoryIngestionRecordStore`** — in-memory, `src/server.ts:169` — i.e. today they don't even survive a restart; the runbook must say so honestly) are the only rows not reconstructable from OpenEMR + repo + re-ingestion.
- Reproducibility facts to cite: `sidecar/eval/fixtures/documents/` (6 committed PDFs incl. `renal-panel-clean.pdf`), `sidecar/corpus/` (authored protocol docs; index rebuilds at boot via `loadCorpusChunks` + `HybridRetriever.build`, `src/server.ts:326-341`), `eval/baseline.json` committed.
- OpenEMR backup pointer (out of sidecar scope): the fork's standard guidance — reference OpenEMR's own backup documentation (`https://www.open-emr.org/wiki/index.php/Backup_and_Restore_Guidelines`) and the Railway Postgres backing the deployed EHR.

## Files to create/modify

- **Modify** `docs/RUNBOOK.md` — new `## E. Backup & recovery (G18)`.
- **Modify** `W2_ARCHITECTURE.md` — §10: verify/annotate table rows against as-built code, flip header marker; §14: flip header marker, add a pointer to RUNBOOK §E.
- (No sidecar code changes. If the vitals-write row in §10 claims a live path that does not exist yet, fix the TABLE, not the code.)

## Step-by-step implementation

1. **RUNBOOK §E — structure** (match §A–§D's imperative step style):
   1. *What must be backed up, and what must not* — the §14 posture table
      rendered operationally: OpenEMR DB + Documents (system of record —
      pointer to OpenEMR backup guidelines + Railway Postgres backups on the
      EHR service; explicitly out of sidecar scope); sidecar fact store
      (derived — backup is convenience, rebuild is truth); repo artifacts
      (corpus, fixtures, baseline — `git` IS the backup).
   2. *Automatic* — enable Railway Postgres scheduled backups on the sidecar
      DB (Railway dashboard → the Postgres service → Backups; state the
      retention the plan offers at click time). If the plan tier lacks
      scheduled backups, the documented alternative: a Railway cron service
      running `pg_dump "$DATABASE_URL" | gzip > nightly.dump.gz` to a volume
      — write the exact command either way.
   3. *Manual* — verbatim commands:
      `pg_dump --format=custom "$DATABASE_URL" -f copilot-$(date +%F).dump` and
      `pg_restore --clean --if-exists -d "$DATABASE_URL" copilot-<date>.dump`.
   4. *The true recovery path (wipe-and-rebuild)* — numbered: (a) provision
      empty Postgres / set `DATABASE_URL`; (b) boot the sidecar — migrations
      run at boot (idempotent, advisory-locked, `server.ts` boot block);
      (c) re-seed/EHR-sync patients; (d) trigger prep per patient
      (`POST /api/prep/:patientId`); (e) re-upload any outside documents
      (originals live in OpenEMR Documents — the preview cache and facts
      regenerate). **RPO = the last prep/ingestion run; RTO = one prep cycle,
      minutes** — state both, aligned with §14's estimates.
   5. *Non-derivable rows + retention decision* — `llm_calls` (audit/cost
      ledger): keep 90 days, backed up with the DB, acceptable to lose in a
      rebuild (cost history, not clinical data) — **record that decision
      here**. Ingestion records: currently in-memory (restart-lossy) — the
      durable trail is OpenEMR Documents + persisted facts; flag as a known
      limitation, not silently.
   6. *Golden set invariant* — one paragraph: everything the eval gate needs
      is in-repo (fixtures, corpus, cases, baseline.json); recovery is
      `git clone` + `npm ci` + `npm run eval`. Cite G18's wording.
   7. *Rehearsal record* — actually perform one manual dump→drop→restore (or
      dump→restore-to-scratch-db) against a local/dev DB and paste the
      command transcript + row-count verification (`SELECT COUNT(*) FROM llm_calls;` before/after). The plan's acceptance is "manual restore
      rehearsed once" — the transcript is the evidence.
2. **§10 verification pass** — for each table row, confirm the Writers/owner
   claims against code as-built: extracted labs → fact store only (true);
   intake ht/wt/BP → "also round-trip to OpenEMR vitals (native write)" —
   check `IngestionServiceDeps.vitalsWriter` wiring in `server.ts`; if the
   native vitals write is NOT wired yet, annotate the row `(vitals write:
   TARGET — route not yet wired)` rather than leaving an untrue SHIPPED
   claim. Then flip the §10 header marker to reflect reality (e.g.
   `[SHIPPED: authority table + overwrite policy · TARGET: native vitals write row]`).
3. **§14 flip** — header `— [TARGET]` → `— [SHIPPED: RUNBOOK §E (procedures + rehearsal) · TARGET: Railway scheduled-backup toggle (user click)]`; add "Operational procedures: `docs/RUNBOOK.md` §E."
4. Trackers, ship.

## What NOT to do

- Do NOT write backup theater — no procedure goes in the doc unless its
  command was actually run once (the rehearsal) or is a single documented
  dashboard click.
- Do NOT promote the fact store to something worth point-in-time recovery —
  its derived-ness IS the design; the runbook's job is to make rebuild
  boring.
- Do NOT paste connection strings, credentials, or dump contents into the
  runbook — commands reference `$DATABASE_URL`.
- Do NOT duplicate OpenEMR backup doctrine — one pointer, clearly scoped
  out.
- Do NOT edit §10's table to match aspiration — it must match code, with
  TARGET annotations where code lags.

## Acceptance checks

```bash
git diff docs/RUNBOOK.md W2_ARCHITECTURE.md
# RUNBOOK: §E with 7 parts incl. the pasted rehearsal transcript;
# W2_ARCHITECTURE: §10 rows annotated truthfully + header flipped; §14 flipped.
# Rehearsal re-runnable:
pg_dump --format=custom "$DATABASE_URL" -f /tmp/rehearse.dump && pg_restore --list /tmp/rehearse.dump | head
```

## Tests to add

None — documentation + one rehearsed procedure. (Ship ritual still runs the
full suite.)

## Tracker updates

- `docs/w2/requirements.md` — under **G18** flip: `- [ ] Backup & recovery: automatic + manual procedures documented … golden set reproducible from the repo alone (no DB-only state). Today this runbook does not exist — real gap.` → `- [x]`; and `- [ ] Data-model doc (W2_ARCHITECTURE.md): for each W2 artifact — … defined owner (authoritative system), lineage (…), access control (…), validation rules.` → `- [x]` after the step-2 verification. Under **G1** flip: `- [ ] Data-authority table (in W2_ARCHITECTURE.md §data-model): per data type — owner system, writers, readers, overwrite policy. Idempotent re-processing is wipe-and-rewrite by deterministic ID, never silent accretion.` → `- [x]`.
- `docs/w2/build-status.html` — DATA (starts L189): ticket **`F.4`** (`{ id: "F.4", … }` — NOT "F.3"; this spec file's number differs from the plan ticket) → `s: "done"`; bump G18 and G1 reqGroup done-counts.
- `W2_ARCHITECTURE.md` — §10 and §14 header markers as in steps 2–3.

## Verify + ship ritual

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

Panel untouched — skip the panel leg. Then: conventional commit with
`--trailer "Assisted-by: Claude Code"` (trackers in the SAME commit) →
`git push -u origin claude/openemr-rag-requirements-x25vzm` → update PR #9
body → SendUserFile `docs/w2/build-status.html`.
