# Verification Path — how every response is checked before it reaches the user

*The walking tour of the verification layer: every file, function, and line where a
Clinical Co-Pilot response is checked between generation and display. Written for a
reviewer who wants to confirm the guarantee from the code, not from prose. The
architecture-level rationale is `ARCHITECTURE.md` §4; the committed proof is
[`docs/execution/eval-results.md`](execution/eval-results.md).*

**Governing rule: the system may be unavailable; it may never be silently wrong.**

---

## The guarantee, stated precisely

Every payload the sidecar emits to a user-facing surface passes through the gate layer —
**`sidecar/src/gate/`** — before it is streamed, persisted, or returned:

1. **Provenance is enforced, server-side.** Every citation the model emits is re-verified
   *verbatim* against our stored copy of the source document. A citation that fails is
   **withheld at the server**: it appears in no SSE event and no API payload, for any
   client — panel, Bruno collection, or curl. Only its count travels
   (`unverified_count`), so a failure is surfaced, never silent.
2. **Brief facts are blocked, not annotated.** On the preparation path, a fact without a
   verifiable citation is dropped before the brief is assembled. An unsourced claim
   cannot render, by construction.
3. **Prose is screened, advisorily.** A deterministic prescriptiveness lint runs on every
   reply and on the opening move. Flags are logged (rule + excerpt + correlation id) for
   the engineering team and counted on the wire (`prescriptive_flag_count`) — the text is
   deliberately **not** redacted in front of the physician (product decision, §Scope).

One directory is the whole layer:

```
sidecar/src/gate/
  citationGate.ts          the prep-path gate: blocks unsourced facts (checkCitation core)
  chatCitations.ts         verbatim re-verification of chat citations & tool excerpts
  prescriptivenessLint.ts  the deterministic thought-partner lint (M3)
  responseGate.ts          the chat-path choke point: withhold/release + advisory screen
```

## Path 1 — a chat turn, request to render

| # | Step | Where |
|---|---|---|
| 1 | `POST /api/chat/:patientId` — pre-stream guards answer as plain JSON: message shape (`400`), patient exists (`404`), LLM budget (`429`) | `sidecar/src/routes/chat.ts:91-121` |
| 2 | New conversation with a completed brief → the opening move is composed, **screened through the gate** (`screenOutboundText`, advisory), persisted, then streamed as the `seed` event | `routes/chat.ts:148-184`, `sidecar/src/gate/responseGate.ts:84` |
| 3 | `ChatService.turn()` runs the tool-use loop (≤4 rounds + forced tool-free final). Text deltas stream live to the panel | `sidecar/src/chat/chat.ts:167` (loop `:212+`) |
| 4 | **The turn's gate is constructed** — the single choke point for everything this turn may emit | `chat.ts:198` |
| 5 | Every native Citations-API citation → `verifyCitation` (verbatim, exact-range then search recovery) → **`gate.admit`**: verified → released to the `citation` SSE event; unverified → withheld + counted | `chat.ts:200-205`, `sidecar/src/gate/chatCitations.ts:22`, `responseGate.ts:46` |
| 6 | Every document-quoting tool excerpt → `verifyDocumentExcerpt` → the **same** `gate.admit` | `chat.ts:277`, `chatCitations.ts:67` |
| 7 | Tool I/O is Zod-validated at the tool boundary (`defineTool` safeParse on input and output); tool events carry deterministic projections, not model prose | `sidecar/src/chat/tools/types.ts` |
| 8 | **`gate.finalize(reply)`** closes the turn: aggregate-logs withheld provenance, runs the advisory prescriptiveness lint, and returns exactly what may leave the server (released citations, `unverified_count`, `prescriptive_flag_count`) | `chat.ts:331`, `responseGate.ts:62` |
| 9 | The `done` event carries the gate's output: verified-only `citations`, the withheld count, `tools_used`, the lint count | `routes/chat.ts:209-216` |
| 10 | A mid-turn failure persists nothing (persist-after-success) and emits an `error` event; the panel offers retry | `chat.ts:311-326` (persist), `routes/chat.ts:218` |
| 11 | Panel renders: citation chips filter to `verified` — **defense-in-depth, not the enforcement point** (the server already withheld unverified ones); amber footer shows the withheld count | `sidecar/panel/src/ChatDrawer.tsx:422-425` (chips), `:461` (footer) |

## Path 2 — the brief (preparation), extraction to display

| # | Step | Where |
|---|---|---|
| 1 | The deep-reader model extracts typed facts, each carrying a source pointer with a quotable excerpt | `sidecar/src/prep/extraction.ts` |
| 2 | The `citation_gate` pipeline stage runs `runCitationGate` over every fact: a claim verifies only if it has ≥1 citation AND every citation resolves — one dead citation blocks the whole claim | `sidecar/src/prep/pipeline.ts:137-153`, `sidecar/src/gate/citationGate.ts:95` |
| 3 | `checkCitation` verifies each excerpt verbatim (exact range → verbatim search → whitespace-flexible match that admits no paraphrase) | `citationGate.ts:41` |
| 4 | Blocked facts are **dropped** before brief assembly and counted (`facts_blocked`, `citations_failed` metrics) | `pipeline.ts:137-153`, `sidecar/src/prep/brief.ts` |
| 5 | The brief the physician opens — and the opening move composed from it — contains gated facts only | `sidecar/src/chat/openingMove.ts` |

## The choke-point table

Every SSE payload type has exactly one producer path, and each passes the gate layer:

| Event | Producer | Policy |
|---|---|---|
| `seed` | `composeOpeningMove` → `screenOutboundText` → persist → write | gated brief content; advisory prose screen |
| `delta` | model text → `onTextDelta` passthrough | streams live; screened at message boundary by `finalize` (advisory — see §Scope) |
| `citation` | `gate.admit` release callback **only** | **enforced: verified-only leaves the server** |
| `tool_use` / `tool_result` | tool loop, Zod-validated I/O, deterministic summaries | structural validation; no model prose |
| `done` | `gate.finalize()` output | **enforced: verified-only citations** + withheld/lint counts |
| `error` | route catch | no content beyond a generic code; nothing persisted |

## Scope — what is enforced, what is advisory, and why

Honesty about the boundary is part of the design:

- **Enforced (structural):** citation provenance. An unverifiable citation cannot reach
  any client; a claim without provenance cannot reach the brief. Code, not a model —
  and not a client-side rendering convention.
- **Advisory (monitored):** the prescriptiveness lint. A directive-shaped sentence
  without attribution is logged and counted, never redacted or rewritten. Rationale: the
  physician reads an unedited reply — mid-consult redactions and machine overcorrections
  cost more trust than they protect — while the flag routes to the people who fix the
  prompt. The prompt itself carries the hard rule (`docs/prompt-guide.md`), and the eval
  suite proves the lint catches every originated-direction shape.
- **Prompt + eval territory (not per-sentence code):** citation *coverage* — whether
  every clinical claim carries a citation. The prompt demands it, `unverified_count`
  exposes failures of emitted citations, and the eval corpus measures faithfulness
  against planted ground truth; but no deterministic checker segments free prose into
  claims. Mitigation: the source is one click from every claim, and absence is rendered
  as absence.
- **Quarantined:** `describe_scan` visual reads are prompt-fenced as "AI visual
  observation (not from the record)", never citable, and bannered in the panel — the one
  surface that is model-eyes-only, labeled as such.

## Where the proof lives

| Invariant | Test / eval |
|---|---|
| Gate releases verified, withholds unverified, drops malformed | `sidecar/test/responseGate.test.ts` |
| An invented span never reaches the stream or the result | `sidecar/test/chat.test.ts` ("withholds an invented citation…") |
| The wire itself carries no unverified citation (route-level SSE) | `test/chat.test.ts` ("POST never streams…"), eval `response-gate.wire-invariant` |
| A fully-verified turn passes undiminished (no over-blocking) | eval `response-gate.clean-turn-released` |
| The seed is screened like every reply | eval `response-gate.seed-screened`, `test/responseGate.test.ts` |
| Cross-patient spans are withheld mid-conversation | eval `multi-turn-conversation.cross-patient-mid-thread` |
| Prep gate blocks unsourced facts; corpus citation validity is 100% | `sidecar/test/gate.test.ts`, eval `citation-validity.*` |
| Lint catches every originated-direction shape; reframe passes | `sidecar/test/prescriptiveness.test.ts`, eval `prescriptiveness.*` |
| Injection: invented provenance withheld; prompt fencing holds | evals `injection-resistance.*` |

Run them: `cd sidecar && npm test && npm run eval` — the eval run regenerates
[`docs/execution/eval-results.md`](execution/eval-results.md) (committed, currently
**24/24**).

## Reading the verification signals in operations

`unverified_count` and `prescriptive_flag_count` ride every `done` event;
`facts_blocked` / `citations_failed` ride every prep run. They surface on the
operational review page ([`docs/OPERATIONS.md`](OPERATIONS.md)) and the observability
spec ([`docs/execution/observability.md`](execution/observability.md)) — alert A3 fires
on a verification-failure spike. A rising `unverified_count` means the model is citing
things the record doesn't say; the gate is holding, and the prompt needs attention.
