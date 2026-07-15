# H.13 — Data-authority ADR + "lab facts never write to OpenEMR" regression test

REQ: G1 (data authority), S1/R1 (persistence-split box), G18 · Depends on: — (pairs naturally with H.11) · Band: merged-plan Track 1 · Priority: P2 (per merged-plan.md)

## Why

The persistence split is a locked decision (register #5): source PDFs →
OpenEMR Documents; extracted facts → sidecar fact store; intake
height/weight/BP → native OpenEMR vitals; **lab values → fact store ONLY**,
because this fork's API has no FHIR Observation create and no lab-table write
path. §10 ships the authority *table*, but the *decision record* (context,
alternatives, consequences, revisit trigger) is not written up, and nothing
regression-tests the dangerous direction: a lab-value fact accidentally
triggering an OpenEMR write would be a silent authority violation a table
cannot catch. This ticket writes the ADR into §10 and pins the invariant with
a spy-based test.

## Existing seams you MUST reuse

- `W2_ARCHITECTURE.md` §10 (`## 10. Data model, authority, lineage (REQ: G1, G18) — [SHIPPED: authority table + wipe-and-rewrite overwrite policy, verified against code 2026-07-13 · TARGET: native vitals write (vitalsWriter seam exists, not yet wired in server.ts — the table row is annotated)]`) — the authority table at :361-368 (row 2: *"Extracted lab observations | **Fact store** (derived view; no API path into native lab tables — declared, not fudged) | intake-extractor only | …"*) and the overwrite policy at :370-374. The ADR extends THIS section.
- `docs/w2/requirements.md` S1/R1 status note (:90-98) — the verified evidence line to cite in the ADR: *"this fork's API has **no FHIR Observation create and no lab-table write path** (verified: `apis/routes/_rest_routes_fhir_r4_us_core_3_1_0.inc.php` — FHIR writes exist only for Patient/Organization/Practitioner)"*. Re-verify that route file still matches before quoting (grep it for `Observation` + POST/PUT handlers).
- `src/ingest/service.ts` — the persistence path under test: EHR writes happen at exactly two places — the document upload (:184, `uploadPatientDocumentDeduped`) and the vitals writer (:289-301, intake-only guard `grounded.extraction.doc_type === 'intake_form' && this.deps.vitalsWriter !== undefined`); lab facts flow only into `factSink.insertFacts` (:275-276) via `factsOf` (:363+, `fact_type: 'lab_result'`); `IngestionServiceDeps` (:110-120): `ehr?: { client: StandardApiClient; openemrPatientId }`, `vitalsWriter?: (patientId, payload: EhrVitalPayload, correlationId) => Promise<boolean>`, `factSink?: IngestionFactSink`.
- `test/openemr-documents.test.ts:27-34` — the harness to copy for a REAL `StandardApiClient` over a recording `fetchImpl` spy: `new StandardApiClient({ baseUrl, tokenProvider: { getAccessToken: async () => 'token' }, fetchImpl, correlationId })`; the raw server shapes to mock: GET listing = raw rows array, empty category = bare 404 (`new Response('', { status: 404 })`), POST = literal `true`, then the post-write verification re-list must include the uploaded hash (compute with `sha3_512Hex(bytes)` from the same module).
- `test/graph.test.ts:23-30` — `LAB_JSON` (a valid `lab_pdf` extraction with an eGFR result) and the stub-VLM idiom (`{ complete: vi.fn(async () => ({ text: LAB_JSON, … })) }`); `eval/fixtures/documents/renal-panel-clean.pdf` as input bytes.
- `src/server.ts:198-211` — confirms the vitals writer is NOT wired in production yet (no `vitalsWriter` key) — this bounds what the tracker may claim (see Tracker updates).
- `docs/w2/requirements.md` §6 locked-decision register row 5 (`EHR writes | Docs → OpenEMR; facts → fact store; intake vitals → native vitals; lab authority documented`) — the decision the ADR records; do not re-litigate it.

## Files to create/modify

- **Modify** `W2_ARCHITECTURE.md` — new `### ADR: write authority per data class (locked decision #5)` subsection inside §10, after the overwrite-policy paragraph.
- **Modify** `sidecar/test/ingest.test.ts` — new `describe('data authority (G1/H.13)')`.
- Trackers: `docs/w2/requirements.md`, `docs/internal/build-status.html`.

## Step-by-step implementation

1. **ADR subsection** (§10) — ADR shape, ~30 lines, no new claims beyond what is verified:
   - **Status:** accepted (locked decision #5, 2026-07-13).
   - **Context:** the fork's REST surface — standard API writes exist for documents/vitals/problems/allergies/medications (cite `standardApi.ts`'s route comments); FHIR writes exist only for Patient/Organization/Practitioner (cite the route file, re-verified date); no lab-table write path.
   - **Decision:** the four-way split verbatim from the register's persistence-split box; one writer per artifact class (the §10 table's Writers column is the enforcement map).
   - **Alternatives rejected:** (a) writing labs to OpenEMR via forms/lab tables directly — no supported API path, schema-fragile; (b) holding source PDFs sidecar-side — would demote the EHR from system-of-record (G1).
   - **Consequences:** extracted labs are visible in the panel/brief/chat, NOT in OpenEMR's native lab views — stated to the user, not hidden; wipe-and-rewrite recovery stays trivial because derived facts live in one store.
   - **Revisit trigger:** upstream OpenEMR gains a FHIR Observation create this fork adopts, or a pilot customer requires labs round-tripped into the EHR.
   - **Enforcement:** name the regression test added below (file + describe string) so the ADR points at its own guard.
2. **Regression test** (`test/ingest.test.ts`, new describe) — build an `IngestionService` with EVERY write-capable dep wired (this is the point — the test must prove restraint, not absence):
   - `ehr`: real `StandardApiClient` over a recording `fetchImpl` (capture `{url, method}` per call) using the openemr-documents.test.ts response script;
   - `vitalsWriter`: `vi.fn(async () => true)`;
   - `factSink`: recording fake (arrays of inserted docs/facts);
   - extractor: stub VLM returning `LAB_JSON`; bytes: the renal fixture.
   Run `attachAndExtract` for a `lab_pdf` and assert (a) status `complete`, (b) every captured OpenEMR URL matches `/patient/<pid>/document` (list + post + verify-list only) or the uuid→pid resolve (`/patient/<uuid>`), (c) **no** captured URL contains `/vital`, `/medical_problem`, `/allergy`, `/medication`, `/encounter`, (d) `vitalsWriter` was **never** called, (e) the lab facts landed via `factSink.insertFacts` with `fact_type: 'lab_result'`.
3. **The allowed direction, pinned too** (so the test can't pass vacuously): a second case runs an `intake_form` extraction WITH vitals (reuse/extend the intake stub JSON pattern from `eval/phi-log-sweep.eval.ts:31-43`, adding a non-null `vitals` block) and asserts `vitalsWriter` was called exactly once with the `mapIntakeVitals` payload — intake vitals ARE allowed to round-trip; lab values are not. (`mapIntakeVitals` is exported from `service.ts:489`.)
4. Trackers, ship.

## What NOT to do

- Do NOT wire the vitals writer into `server.ts` to "finish" the persistence split — that is §10's declared TARGET with its own wiring/route concerns; this ticket documents + guards the authority rule. If you find it already wired, the tracker flip below changes (see there).
- Do NOT assert on `StandardApiClient` internals or private methods — the spy sits on the public `fetchImpl` seam; URLs are the contract.
- Do NOT soften the test to "vitalsWriter not wired" — it must be wired-and-unused for `lab_pdf`, or the test proves nothing.
- Do NOT restate the whole §10 table in the ADR — link/point; one source of truth per fact (the ADR adds context/consequences, not a second table).
- Do NOT log or embed real-looking patient identifiers in the new test fixtures — reuse the existing synthetic ones.

## Acceptance checks

```bash
cd sidecar && npx vitest run test/ingest.test.ts        # new data-authority cases green
cd sidecar && npm test && npm run typecheck
grep -n "ADR: write authority" W2_ARCHITECTURE.md        # ADR present in §10
```

## Tests to add (in `test/ingest.test.ts`, `describe('data authority (G1/H.13)')`)

- `it('a lab_pdf ingestion with every write path wired touches OpenEMR ONLY for the document — never vitals/problems/allergies/medications')` — assertions (a)–(e) above.
- `it('an intake_form with vitals round-trips exactly one native vitals write — the allowed side of the split')`.

## Tracker updates

- `docs/w2/requirements.md` — under **S1/R1** (~:90), the box (verbatim lines):

  ```
  - [ ] Persistence split (locked decision): source PDF → OpenEMR Documents;
    extracted facts → sidecar fact store with provenance; intake
    height/weight/BP → native OpenEMR vitals write
    (`POST /api/patient/:pid/encounter/:eid/vital`, scope `user/vital.write` —
    already registered); lab values → fact store only, with data authority
    documented (G1) because this fork's API has **no FHIR Observation create and
    no lab-table write path** (verified:
    `apis/routes/_rest_routes_fhir_r4_us_core_3_1_0.inc.php` — FHIR writes exist
    only for Patient/Organization/Practitioner).
  ```

  **Flip guidance (honesty over box-count):** the native-vitals leg's server wiring is still absent (`server.ts:198` has no `vitalsWriter`; §10 header TARGET says so). Default: do NOT flip; instead append the annotation `*(H.13: data-authority ADR written into §10 + lab-never-writes regression test (test/ingest.test.ts); remaining: vitals writer server wiring — §10 TARGET.)*`. Only flip if you verify the wiring landed in the meantime (`grep -n vitalsWriter sidecar/src/server.ts` returns a wiring line).
- `docs/internal/build-status.html` DATA block: ticket `H.13` (L456) `s: "pending"` → `"done"`; reqGroups: `S1/R1` row `done` bumps ONLY if the box flipped (see above) — otherwise counts stay, the ticket row alone flips.
- `W2_ARCHITECTURE.md` — §10 header: append to SHIPPED `+ write-authority ADR + lab-never-writes regression test (H.13)` (keep the vitals-wiring TARGET as-is unless it landed).

## Verify + ship ritual

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

Panel untouched — skip the panel leg. Then: conventional commit with
`--trailer "Assisted-by: Claude Code"` (trackers in the SAME commit) →
`git push -u origin claude/merged-eval-course-plan-ky6ulh` → update PR #16
body (checklist line for H.13) → SendUserFile
`docs/internal/build-status.html` (rendered inline).
