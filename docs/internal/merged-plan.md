# Integrated Plan: Merging the Evaluation Plan (Plan A) and the Course-Technique Plan (Plan B)

> **Execution note (added when this plan was committed, 2026-07-15).**
> This is the canonical, user-approved merged plan. Work happens on branch
> `claude/merged-eval-course-plan-ky6ulh`. Per-ticket cold-executable specs
> live in `docs/internal/tickets/` (files `H.*.md`, `J.*.md`, `K.*.md`,
> `CT*.md`); the build board (`docs/internal/build-status.html`) tracks live
> status in its two new sections "Track 1 — Hardening & Ship-Readiness" and
> "Track 2 — Course-Technique Alignment".
>
> **One correction discovered at execution start:** decision #3 below assumed
> the executing environment has live internet access to the deployed app
> (Railway), Langfuse, and Cohere. The actual session environment's network
> policy **denies** those hosts (proxy CONNECT 403 to
> `*.up.railway.app`, `cloud.langfuse.com` — verified 2026-07-15). Three
> consequences:
>
> 1. **H.4 routes through CI instead of the sandbox.** GitHub Actions runners
>    *do* reach the deployed app, and the repo already has a live flow-test
>    (`.github/workflows/live-smoke.yml`, `workflow_dispatch`). H.4 is
>    executed by extending that workflow with the W2 document flow
>    (upload → extraction → evidence chat → citation payload) and
>    dispatching it via the GitHub API from the session. Only the
>    "eyeball the trace in Langfuse" step stays with the user (the workflow
>    records the `x-correlation-id` to search for).
> 2. The **Langfuse-visual checks** (H.4's trace view, H.7's span-nesting
>    confirm) and anything needing Railway/Langfuse dashboards are user
>    actions — see USER-ACTIONS items 9+.
> 3. If the user widens the environment network policy (USER-ACTIONS item 9),
>    in-session live checks become possible and CT6's trace-fetch script can
>    be exercised directly.
>
> Everything else in both tracks is code/tests/docs and is unaffected.

## Context

Two different graders/evaluators independently reviewed this repo (an OpenEMR fork
plus a `sidecar/` Node service that adds an AI "Clinical Co-Pilot" for a Gauntlet AI
bootcamp submission) and each wrote up a plan. Nobody has acted on either plan yet.
This document is the result of reading both in full, checking their factual claims
against the actual code (two verification passes), asking the user how to resolve
the places where the two plans made different assumptions, and combining everything
into one plan a future coding agent can pick up and execute — with no separate
"Plan A" / "Plan B" split left for that agent to reconcile itself.

**The two source plans, in one sentence each:**
- **Plan A ("Evaluation Plan")** is a code-level audit: it ran the tests/evals
  itself, found what's genuinely broken or unfinished versus what's just
  undocumented, and produced a prioritized list of fixes — mostly hardening the
  `sidecar/` service (timeouts, retries, live re-verification) plus a smaller,
  separate "product roadmap" idea about narrowing the OpenEMR menu to fit an
  ophthalmology-only use case.
- **Plan B ("Course-Technique Plan")** is about proving, for a grader, that this
  project applied specific techniques taught in the bootcamp's course (things like
  golden test sets, difficulty tiers, replay testing, LLM-as-judge scoring). It's
  almost entirely new documentation and small additions to the existing automated
  test suite — it deliberately avoids touching the actual product code.

**Why they merge cleanly:** the two plans barely touch the same files. Plan A works
mostly in `sidecar/src/` (the actual application code) and, in its smaller trimmed
piece, in the OpenEMR PHP side. Plan B works almost entirely in `sidecar/eval/`
(the automated test/grading harness), `docs/`, and `.claude/skills/` (reusable
checklists for future work sessions). Where they do touch the same handful of
shared tracking files, this plan spells out exactly how to avoid stepping on each
other.

**Decisions the user already made, which this plan follows:**
1. This is **one integrated plan**, not two plans shipped separately. Both sets of
   work happen against this one repo (`TCA-Trelity/GW1-openemr-base-clean`); no
   need to force everything onto one branch or split it onto two — whichever
   working branch is assigned when a coding agent actually starts on this can hold
   all of it, and the two halves below are described as two **tracks** that can be
   worked at the same time without conflicting.
2. **Both tracks run in parallel** — there's no rule saying "finish Track 1 before
   starting Track 2." Each track has its own internal priority order (see below).
3. **The environment that will execute this plan has live internet access** to the
   deployed app (Railway), Langfuse, and Cohere. So anything in either source plan
   that needed a human to click through a live check by hand can instead be written
   as a task the coding agent runs itself. *(See the execution note at the top —
   this assumption failed in the actual executing environment; live tasks are
   prepared-and-blocked, not dropped.)*
4. **The "narrow the OpenEMR menu to ophthalmology-only" product idea (Plan A's
   Wave K) is trimmed down.** Only the cheap, mechanical pieces are in scope now:
   recording the "stay narrow, don't expand to full ophthalmology" decision in
   writing, and hiding/renaming menu items to fit the actual product. The pieces
   that involve making medical-content judgment calls (which clinical scenarios to
   deepen, how to handle a patient whose condition doesn't match the product's
   focus) are explicitly **left out of this plan** — those deserve their own,
   separate conversation with the user later, not a decision baked into a big
   merged execution plan.

---

## What changed from the two source plans during fact-checking

Before trusting either plan's claims, two research passes checked the specific
files and line numbers each plan cited against the actual repo right now. The vast
majority of both plans checked out exactly as written. A few small things were
wrong or imprecise, and this plan uses the corrected version:

1. **Plan A said `auth.ts` has un-timed-out network calls at lines 178, 257, and
   350.** Only two of those are real: **257 and 350**. Line 178 isn't a network
   call. (Doesn't change the fix, just the exact spots to touch.)
2. **Plan A said the retry helper `withTimeoutAndRetry` is reused inside
   `CohereEmbeddings.embed()`.** It's actually reused inside a different method,
   **`CohereReranker.rerank()`**, in the same file (`rerank.ts:52`). Same pattern,
   different method name — worth knowing so the fix is copied from the right place.
3. **Plan A described some "plain TypeScript, no validation" data shapes in
   `queryPolicy.ts` as "SearchOptions-type."** The actual type names there are
   `QueryContext` and `BuiltQuery`. Not `SearchOptions` (that name only exists in
   `retriever.ts`). Cosmetic, but worth using the real names in any future ticket.
4. **Plan A claimed the file-upload endpoint (`routes/ingest.ts`) validates
   everything "ad hoc," with no schema.** That's only true for two of the three
   things it checks (file type by extension, and file size). The **document
   category** (lab report vs. intake form, etc.) is *already* validated through a
   proper schema. So this fix is smaller than the original plan implied — only two
   checks need upgrading, not three.
5. **Plan A claimed the shared extraction-data schema (`schemas/extraction.ts`) has
   "zero usage" in the test-harness or the UI.** More precisely: it's already used
   correctly throughout the actual ingestion pipeline (as expected). The real,
   still-open gap is narrower than "zero usage" suggested — it's specifically that
   neither the **panel UI code** nor the **automated eval test files** reference it
   directly (the UI hand-rolls its own duplicate version of the same shape, and the
   eval tests don't assert against the schema). That's still a real gap, just
   described more precisely here than in the original plan.
6. **Everything in Plan B checked out with no material corrections** — every file,
   line number, function name, and test-count claim it made was accurate against
   the current code. (Read literally, the only nitpick is that one class it
   describes as "a no-op without keys" is actually made a no-op by the code that
   *constructs* it, not by the class itself refusing to run — a distinction with no
   practical effect on anything in the plan.)
7. **Plan B's assumption that the coding agent's sandbox can't reach the live
   deployed app, Langfuse, or Cohere is not true for this execution** — see
   decision #3 above. Every ticket below that needed a "have a human check this
   live" step has been rewritten as a directly-runnable task instead. *(Overtaken
   by events — see the execution note at the top: the executing environment's
   network policy turned out to deny those hosts after all, so those tasks revert
   to script-plus-checklist form until access exists.)*
8. **Plan B's designated branch, `claude/openemr-rag-requirements-x25vzm`, has
   already been merged into `main` (as PR #15) and no longer exists.** It shouldn't
   be treated as a live branch to build on — this plan doesn't hard-code a branch
   name at all, per decision #1 above.

---

## Standing rules for both tracks

These apply to every ticket below, in both tracks, merged and reconciled from both
source plans' own standing rules plus this repo's existing house rules (CLAUDE.md):

1. **Never merge to `main` without the user explicitly saying so** (e.g., "merge
   this"). Everything happens on a working branch with draft pull requests until
   then.
2. **Before every push that touches `sidecar/`**, run its full check sequence:
   tests pass, the TypeScript typechecker is clean, and the automated eval suite
   prints a full pass ("GATE PASS", all cases green — currently 58 out of 58). If
   the change also touched the `panel/` (the web UI folder inside `sidecar/`), run
   its tests/typecheck/build too.
3. **Before every push that touches OpenEMR's PHP code** (this only applies to the
   trimmed Wave K pieces below), run this repo's standard PHP quality checks
   (static analysis, code style, and the relevant test suite) the same way any
   other PHP change in this repo would be checked, per this repo's normal
   CLAUDE.md instructions.
4. **Update the tracking dashboards in the same pull request as the code**, never
   as a follow-up: the ticket-status data embedded in
   `docs/internal/build-status.html`, the checkboxes in `docs/w2/requirements.md`,
   and any status line in `W2_ARCHITECTURE.md` that describes the thing just
   changed.
5. **Never touch the automated test suite's "expected answers" to force a case to
   pass.** If a test result changes on purpose, that's a deliberate, clearly
   labeled "re-baseline" commit with the before/after difference visible for
   review — not a silent edit.
6. **The automated pass/fail gate that blocks bad pull requests never depends on an
   AI model's subjective judgment of quality.** It only depends on objective,
   deterministic checks. Any AI-judged quality scoring (see Track 2's CT7 below)
   is informational only and never blocks anything.
7. **Internal working documents (anything under `docs/internal/`) are never linked
   from the public-facing README or grading-facing docs.** They're for whoever is
   doing the work, not for the grader to stumble onto.
8. **Commit messages follow this repo's Conventional Commits format**, and if an AI
   assistant wrote the commit, it gets the `Assisted-by` trailer, per CLAUDE.md.
9. **User-facing commands written into any doc or ticket must be fully filled in**
   — no placeholder text like `<branch-name>`, and no inline `#` comments in
   copy-paste shell commands (this repo's house rule — some users' shells choke on
   them).

### Coordinating the two tracks so they don't collide

Because both tracks run in parallel, and both need to touch a few of the same
shared files (the dashboard, the requirements checklist, the architecture doc),
follow this to avoid one track's work accidentally overwriting the other's:

- Before opening a pull request that edits `docs/internal/build-status.html`,
  `docs/w2/requirements.md`, or `W2_ARCHITECTURE.md`, make sure the branch is
  freshly updated from `main` first, so the edit is based on the latest version
  of these files (which may have just changed from the *other* track's most
  recent merge).
- If a conflict shows up in one of these shared files when merging, the fix is
  to **keep both tracks' additions** (they add different rows/sections — a Track 1
  ticket's status flip and a Track 2 ticket's status flip are both real and both
  belong in the file), never to resolve it by discarding one side.
- `docs/internal/build-status.html`'s embedded data currently only has rows for
  this project's *original* waves (labeled `0`, `A` through `F`, and the planning
  wave `P`). It has **no rows yet** for either track's new work. The first ticket
  that lands in each track should add a **new, clearly labeled section** to that
  dashboard for its own track (e.g., "Hardening & Ship-Readiness (Track 1)" and
  "Course-Technique Alignment (Track 2)") rather than trying to fit into the
  existing wave list — these are follow-on work, not part of the original Week 2
  execution plan.

---

## How the priority labels work

Both source plans used slightly different priority language. This plan uses one
consistent scale across both tracks:

- **P0** — do this before the grading window closes. Either it reduces real risk
  (something a grader could hit and find broken) or it's cheap, high-value
  evidence of good practice.
- **P1** — do this right after grading closes, or squeeze in if there's spare time
  before. Cheap and durable — small effort, long-lasting value.
- **P2** — valuable, but can wait until after the submission crunch is over.
- **P3 / backlog** — not scheduled now. Written up so it's ready to pick up later,
  but nobody should feel behind for not doing it yet.

---

## Track 1 — Ship-readiness, reliability & hardening

*(From Plan A. Mostly touches `sidecar/src/` — the actual running application
code — plus a small trimmed piece touching OpenEMR's PHP/module configuration.)*

### Sub-track H — Grading-window critical

**P0 — do first, all can be worked at the same time except where noted**

1. **H.1 — Stop the rehearsal script from leaving a scary-looking fake failure
   report behind.** There's a script (`sidecar/eval/rehearsal/run-rehearsal.sh`)
   that deliberately breaks the code three different ways, one at a time, to prove
   the automated pass/fail gate actually catches each kind of break — then undoes
   each break. The bug: after undoing all three breaks, it never re-runs the report
   generator, so it leaves behind a report file
   (`docs/execution/eval-results.md`) that still shows the *last* deliberate
   failure, looking like a real, current bug. **Fix:** after the three checks
   finish successfully, either restore that file to its last-committed version or
   re-run the report generator cleanly, so nobody who runs this script locally
   sees a false alarm sitting in their working files.
2. **H.2 — Make the "is Cohere reachable" health check actually check that.**
   Right now, the app's `/ready` health-check endpoint reports the AI re-ranking
   service ("Cohere") as healthy just because an API key is *configured* for it —
   it never actually calls Cohere to confirm the key works or that Cohere is up.
   **Fix (`sidecar/src/server.ts:333`):** either make it do one cheap, quick real
   call to Cohere (the same way another part of this health check already proves a
   different dependency is reachable, not just configured), or — if a live call is
   deliberately not wanted here — change the wording in the documentation from
   "reachable" to "key is present," so the claim matches what's actually being
   checked.
3. **H.3 — Fix two spots that bypass the structured logging system.** Two specific
   places in the code (`sidecar/src/server.ts:496` and `:507`) print raw,
   unstructured text to the console when something fails, instead of using this
   project's normal structured logger (the kind that machines can search and filter
   later, and that guarantees patient-identifying details never leak into logs).
   **Fix:** pass in the already-built structured-logging object (it's created a
   few lines further down in the same file, around line 512 — move that
   construction earlier so these two spots can use it) instead of the raw
   console output.
4. **H.4 — Actually re-verify the live, deployed app end-to-end, right now.** As
   of today, a real incident was just fixed where uploading a document to a
   patient's chart silently failed in production due to three separate small bugs
   stacked on top of each other. The fix has been committed, but nobody has
   actually re-run the full flow against the live deployed app since then to
   confirm it's really fixed. **Do this task directly** (the environment
   executing this plan has live access): run the full flow — upload a document,
   watch it get extracted, ask the chat a question that should cite it, open the
   PDF citation overlay — against the real deployed URLs, using the existing
   automated flow-test collection if one is set up for it, or by driving it
   directly. Confirm there's a matching, viewable trace in Langfuse (the
   observability tool this project uses) for that run. **Do this before writing
   more code in Track 1** — of everything in this plan, this is the single most
   likely thing a grader will personally try, and it was broken again as recently
   as this morning. *(Execution note: blocked-on-access in this environment — see
   the header note; shipped as a runnable live-smoke script + USER-ACTIONS item
   until the network policy is widened or it's run from the user's laptop.)*
5. **H.5 — Add a timeout and a couple of retry attempts to every outbound call to
   OpenEMR.** Right now, if OpenEMR (the medical records system this product
   talks to) doesn't respond, the code just waits with no time limit and doesn't
   try again — like a phone call nobody ever hangs up, even if no one answers. If
   any single OpenEMR call ever hangs, it freezes that entire request (a document
   upload or a chat answer) forever, with no recovery. Confirmed: none of the three
   files that talk to OpenEMR have this protection at all right now. There's
   already a reusable helper elsewhere in the codebase that does exactly this
   ("wait up to N seconds, retry a couple of times") — reuse it rather than writing
   a new one. **Fix these exact spots:**
   - `sidecar/src/openemr/standardApi.ts` — its private `request()` function, line
     427.
   - `sidecar/src/openemr/fhir.ts` — its private `request()` function, line 88.
   - `sidecar/src/openemr/auth.ts` — the two places it fetches an auth token, lines
     257 and 350.
   - Reuse the existing `withTimeoutAndRetry` helper (defined in
     `sidecar/src/retrieval/embeddings.ts`, reused today by
     `CohereReranker.rerank()` in `retrieval/rerank.ts`). Since it's about to be
     used by code that has nothing to do with search/retrieval, consider moving it
     to a more neutral shared location (e.g. a new `sidecar/src/lib/httpRetry.ts`)
     so the OpenEMR code doesn't have to import from the "retrieval" folder just to
     get it.
   - This is the single cheapest, highest-value fix in the whole plan — if a
     grader's test intentionally tries to break the system, "make one outbound
     call hang forever" is an easy, obvious way to do it, and right now nothing
     stops that.
6. **H.6 — Prove the citation-checking gate correctly blocks bad citations from
   the two newest kinds of evidence, not just the original kind.** This project
   has a safety gate that's supposed to block any AI-generated answer from citing
   a source it can't actually verify. The gate's logic already handles all types of
   evidence generically (confirmed — it's not hardcoded to one type). What's
   missing is test coverage proving it correctly *rejects* an unverifiable citation
   from the two newer evidence types added this project cycle (facts pulled from
   an uploaded document, and quotes from the guideline library) — today it's only
   proven to correctly *accept* a good citation from those two types, not to reject
   a bad one. **Fix:** add test cases (mirroring the existing citation-gate tests)
   that intentionally feed it an unverifiable citation from each of the two newer
   types and confirm it's blocked.

**P1 — do second**

7. **H.7 — Confirm and lock in that trace spans are properly nested (the
   "supervisor" step visually contains its "worker" sub-steps in the observability
   tool), not just running in parallel unlabeled.** This is very likely already
   working correctly (a previous piece of work wired it up) — this ticket is
   mostly about *confirming* it visually in the observability tool, then adding
   an automated test that would catch it if this nesting ever broke, since
   right now nothing but a human eyeball would notice a regression here.
8. **H.8 — Walk the full request path and confirm a single tracking ID survives
   every step.** Every request in this system is supposed to carry one ID all the
   way through 7 different steps (document upload → writing to OpenEMR → AI
   extraction → the agent graph → the search/retrieval step → writing lab values
   back to OpenEMR → the final cited answer) so a specific request can always be
   traced end-to-end from just that one ID. There's a reference document
   (`docs/w2/trace-example.md`) describing what this should look like — walk the
   actual code against it and fix any step that drops the ID or accidentally
   generates a new one instead of passing the original through.
9. **H.9 — Give the chat AI a proper, explicit "attach and extract a document"
   tool**, instead of only being able to do that as a hardcoded step buried inside
   one specific part of the agent's flow. The underlying capability already exists
   as a regular function; what's missing is wrapping it as a discrete tool object
   the AI model can be told about and choose to invoke by name, the same way it's
   done for the model's other tools. Important design note carried over from the
   original evaluation: **do not** add this to the existing synchronous/read-only
   tool list used elsewhere in the chat system — that list is deliberately
   restricted to fast, synchronous, read-only actions, and this is neither fast
   nor read-only. Instead, build it as its own new kind of tool object meant for
   the slower, asynchronous "agent graph" part of the system, and update the part
   of the graph that currently does this step inline to call the new tool object
   instead.
10. **H.10 — Add a basic "circuit breaker" for each outside service this project
    depends on** (the AI re-ranking service, the AI chat model, and OpenEMR).
    Explanation: after a service fails several times in a row, stop hammering it
    for a short cooldown period instead of continuing to try (and instead of
    hanging every single request while it's clearly down) — this also makes the
    system's own health-check endpoint accurately reflect "this dependency is
    currently unhealthy." This doesn't need a fancy library — a simple counter per
    service that trips after N consecutive failures is enough, and this project's
    own written requirements explicitly say a simple version is acceptable. Do
    this after H.5, since it needs the timeout/retry logic to exist first to know
    what counts as "a failure."
11. **H.11 — Add real schema validation to four data shapes that are currently
    just plain, unchecked TypeScript types.** Specifically: the record of an
    in-progress document upload (`sidecar/src/ingest/service.ts`, two type names
    at lines 38 and 59), two of the search/retrieval system's internal data shapes
    (`sidecar/src/retrieval/retriever.ts` line 36 and line 45, and
    `queryPolicy.ts`'s `QueryContext` at line 64 and `BuiltQuery` at line 71 — see
    correction #3 above for the accurate names), the shape of a vital-signs value
    being written back to OpenEMR (`standardApi.ts` line 97), and — narrower than
    originally scoped, see correction #4 — the file-upload endpoint's checks on
    **file type/extension and file size only** (its document-category check
    already has proper validation). Pairs naturally with H.13 below.

**P2 — do third (still real work, but lower risk / more about measurement and
documentation than code changes)**

12. **H.12 — Build a small tool to reconstruct everything that happened during one
    specific request, given just its tracking ID**, plus do one pass reviewing
    every log line added since the last privacy audit to confirm none of them
    accidentally include patient-identifying details.
13. **H.13 — Write up, in full, the design decision about where different kinds of
    data are allowed to be written** (some facts only ever get written to this
    project's own database, never back to OpenEMR, and vice versa) in
    `W2_ARCHITECTURE.md`'s existing architecture-decisions section, and add a
    regression test proving a specific kind of fact (a lab value) never
    accidentally triggers a write back to OpenEMR.
14. **H.14 — Actually use the shared extraction-data schema in the two places that
    currently don't** (see correction #5 above for the precise gap): make the
    panel's UI code import the shared type instead of hand-rolling its own
    duplicate version of the same shape, and add at least one assertion in the
    automated eval tests that checks an extraction result against this schema
    directly, instead of only checking it loosely.
15. **H.15 — Measure how long the "which specialist should handle this question"
    routing decision actually takes**, and compare it against its stated target
    (roughly 200–400 milliseconds), extending the existing baseline-measurement
    script to capture it.
16. **H.16 — Make the chat's "fast answer" path actually check for a pre-computed
    answer before doing a live search.** There's already a place where evidence
    gets pre-computed and stored at the time a document is uploaded (so the answer
    to an already-anticipated question is ready instantly) — but the live chat
    path doesn't currently check that store first; it always does a fresh, slower
    search. This is both a real checklist item and a direct speed improvement for
    users, not just paperwork.
17. **H.17 — Rename existing test titles to describe the specific failure they
    guard against**, instead of a generic description. Pure renaming/documentation
    work with no behavior change — the safest item in the whole plan to skip
    entirely if time runs out before grading closes.

**Sequencing inside Sub-track H:** items 1–3 (H.1–H.3) are independent and trivial
— do them together first. Item 4 (H.4) doesn't depend on any code change — run it
alongside item 5 (H.5). Item 10 (H.10) needs item 5 (H.5) done first. Items 11 and
13 (H.11, H.13) pair naturally together. Everything else in the P1/P2 tier can be
worked in any order relative to each other.

### Sub-track J — Post-grading hardening

*(A credible pilot-demo bar, explicitly not a real-patient-data production
go-live — that's intentionally out of scope for now.)*

1. **J.1 (P0) — Connect the 6 already-defined alert rules to something that
   actually notifies a person**, instead of only existing as written thresholds
   in a documentation file today. One Slack or email notification is enough —
   check first whether the observability tool this project already uses
   (Langfuse) has built-in alert-webhook support before building a custom one.
2. **J.2 (P0) — Add basic rate-limiting to the write-capable endpoints** (document
   upload, and the chat streaming endpoint) using the rate-limiting plugin for
   this project's existing web framework. This also directly protects the
   existing daily spending cap from being drained by an accidental runaway
   client.
3. **J.3 (P0) — Add a staging environment and a manual "promote to production"
   step**, so `main` doesn't deploy straight to the URL a prospective user or
   grader might be looking at. The hosting provider's built-in preview-environment
   feature is enough for this — no need for anything more elaborate.
4. **J.4 (P1) — Turn on real CI checks for the OpenEMR PHP code on the main
   branch.** Confirmed: this fork inherited roughly 50 automated-check workflows
   from upstream OpenEMR (PHP static analysis, a security scanner, API-doc
   freshness checks) that are currently configured to only run against upstream's
   own branch names, never this fork's actual `main` branch — only the
   sidecar-specific checks currently protect real merges here. Pick the two
   highest-value ones (PHP static analysis and the PHP-side security scanner) and
   retarget them to run on this fork's `main`, recording any pre-existing findings
   as an accepted baseline the same way the sidecar side already does, rather than
   trying to fix everything upstream ever wrote.
5. **J.5 (P1) — Write down the exact, one-line steps to turn off the demo-only
   login shortcut** for the day a real pilot customer starts using this. Right
   now there's a special login method meant only for demos, and it's live on the
   actual deployment today (correctly documented as demo-only, not hidden). Don't
   touch that code now — grading depends on it working — just write the
   turn-it-off steps into the runbook so it's a fast, mechanical 2-minute action
   later, not a fresh design conversation under pressure.

### Sub-track K (trimmed) — Cheap, low-risk product-roadmap pieces only

*(Per the user's decision: the pieces involving medical-content judgment calls are
explicitly out of scope for this plan — see below.)*

1. **K.1 (P1) — Write down "stay narrow" as a locked decision**, in this project's
   existing decisions log (`docs/execution/DECISIONS.md`). The idea being locked
   in: keep this product focused on one clinical area (retina/medical-retina)
   rather than trying to compete broadly with established, full-featured
   ophthalmology EHR products — the actual advantage here is depth in one area,
   not breadth. Include a clearly stated condition for when this decision should
   be revisited (e.g., "if a second paying customer needs a different subspecialty
   focus"), so it's a deliberate, revisitable choice, not an accidental permanent
   one.
2. **K.4 (P0, cheap) — Give the co-pilot its own menu, instead of stock OpenEMR's
   full ~2,300-line menu.** Confirmed: the product currently adds exactly one card
   on one dashboard page, inside an otherwise completely untouched, full generic
   OpenEMR menu — real clutter for the actual target user. **Important:** do not
   hand-edit the shared stock menu file
   (`interface/main/tabs/menu/menus/standard.json`) directly — it's shared,
   upstream, and confirmed to be otherwise untouched history-wide. Instead, this
   repo already has a purpose-built module for exactly this
   (`interface/modules/custom_modules/oe-module-dashboard-context/`, an
   admin-configurable menu/dashboard scoping tool) that currently has zero
   ophthalmology-specific configuration defined in it (confirmed by search).
   Author an actual "Ophthalmology/Retina" configuration inside that module
   instead.
3. **K.5 (P1, cheap) — Turn off the 7 modules that don't apply to this product's
   actual use case**, for this deployment specifically (telehealth video vendor
   integration, a lab-routing integration, a health-info-exchange exporter,
   fax/SMS integration, prior-authorization workflow, an e-prescribing
   integration, and the dashboard-context module once K.4 above has repurposed
   it). Use OpenEMR's standard, built-in module on/off toggle — this is fully
   reversible and doesn't delete any code, so it's safe to revisit if a future,
   different deployment needs any of these back.

**Left out of this plan entirely** (per the user's decision — worth a separate,
dedicated conversation later, not a line item here): deepening a specific
patient's diabetic-retinopathy imaging scenario with new fixture content, deciding
how to handle a patient whose labeled condition (glaucoma) doesn't match the
product's clinical focus, and designing a first-time-user explainer in the chat
UI. All three involve real clinical-content or product-scope judgment calls that
deserve focused attention on their own.

---

## Track 2 — Course-technique alignment

*(From Plan B, renamed from its original "W1–W8" labels to **CT1–CT8** in this
plan — "W" already means several other things in this repo, including "W2" for
"Week 2" itself and this project's existing lettered "waves," so reusing it for a
third, unrelated numbering scheme would be confusing. Mapping: CT1=W1, CT2=W2,
CT3=W3, and so on through CT8=W8, in the same order as the original plan. This
track works almost entirely in `sidecar/eval/` — the automated test/grading
harness — plus documentation and reusable checklists; it deliberately does not
touch the actual running product code, with one small exception noted at CT7.)*

**Why this track exists:** this project already independently implements most of
what a specific bootcamp course teaches about testing and evaluating AI systems
(golden test sets, deterministic pass/fail gates, observability, safety guardrails,
etc.) — but a grader has to already know the course material to recognize that by
reading the code cold. This track makes that alignment explicit and visible,
and fills the few genuine gaps that exist.

### P0 — do first (all fairly cheap, roughly a business day total)

1. **CT1 — Write a one-page "here's where each course technique lives in this
   codebase" map** (a new file, `docs/w2/gauntlet-alignment.md`). One row per
   technique taught in the course, with exactly which file and line implements it,
   and its current status. This turns "we happen to already do this" into
   something a grader can actually find and verify — every row must point to a
   real, working file, not an aspirational claim. Also add one link to it from the
   README's existing Week 2 deliverables list, and one pointer line from the
   existing defense-outline document. Do **not** link this from anything grader-facing
   beyond that one README row — keep it findable but not thrust in the grader's face
   as if it were the whole story.
2. **CT2 — Tag every automated test case with a difficulty level**
   (straightforward / ambiguous / edge-case), and show a coverage breakdown by
   category and difficulty in the automated test report. Right now the project has
   58 test cases across 14 test files, but no way to see at a glance whether
   coverage is concentrated in the easy cases or genuinely spread across hard
   ones. **How:** add a required `difficulty` field to the shared test-record
   format (this deliberately breaks every existing test case's code at
   compile-time until each one is updated — that's intentional, it forces every
   case to actually get tagged rather than some being silently skipped). Then tag
   all 58 cases in the same commit. Then add a new "coverage by difficulty"
   section to the automated report, right after its existing category-summary
   table. **Important:** this is purely a reporting change — it must not change
   which cases are required to pass or add any new pass/fail thresholds; the
   automated gate's pass/fail logic stays exactly as it is today.
3. **CT3 — Add real retrieval-quality numbers to the test report** (this shares a
   file with CT2's report change, so do them in the same pull request). The
   project's search/retrieval system currently gets tested for whether it finds
   the right document, but the report doesn't show the two honest, calculable
   quality metrics for that: **hit rate** (how often the right document is found
   at all) and **average rank** (how high up the results list it lands, on
   average, when found). Note: the current test cases only define *one* correct
   document per test question, so a true "precision" metric (how many of the top
   results are relevant, when several could be) can't be honestly calculated yet
   without redesigning the test cases — don't fake it; report the two metrics that
   can be calculated honestly today, and note in the report that a fuller
   precision metric would need multi-document test cases as a future, optional
   step. Also copy these two numbers into the tracking dashboard.
4. **CT4 — Add a short section to `W2_ARCHITECTURE.md`** explicitly naming and
   listing, side by side, the difference between this project's **guardrails**
   (things that actively prevent bad behavior before it happens — login checks,
   spending caps, timeouts) and its **evals** (things that measure output quality
   after the fact — the 58 test cases). This is purely a documentation
   organization task using this project's own existing vocabulary; every item
   listed needs to point to the real file that implements it.

### P1 — do soon after, cheap and durable

5. **CT5 — Write a reusable "before you push" checklist** as a proper checklist
   tool (mirroring how this repo already stores similar checklists), plus add a
   short new section to the project's main instruction file (CLAUDE.md) codifying
   the rules around how the automated test set should be maintained over time
   (e.g.: never edit an expected test answer just to make it pass; a fully
   revised/re-baselined answer must always be a clearly separate, reviewed
   commit; the AI-judge scoring from CT7 below is informational only and can
   never block anything). **Important nuance for this merged plan** that the
   original course-technique plan didn't anticipate: since Track 1 above also
   makes real product-code changes (and a small piece touches OpenEMR's PHP side,
   not just the Node service), this checklist needs **two branches** depending on
   what was actually touched — the Node-side check sequence (tests, typecheck,
   eval gate) for anything under `sidecar/`, and the PHP-side check sequence
   (static analysis, code style, tests) for anything under OpenEMR's PHP code —
   not just the Node-only version the original course-technique plan assumed.

### P2 — after the submission crunch is over

6. **CT6 — Start a recurring "look at what actually went wrong" review habit.**
   This is the one genuine gap in an otherwise well-covered set of testing
   practices: a regular, human-led habit of pulling a handful of real recent
   interaction traces, reading them, writing down the very first thing that went
   wrong in each one (stopping there — don't chase every downstream symptom), and
   deciding for each: fix it now, turn it into a new permanent test case, or note
   why it's fine to ignore. Set this up as: a running log file to record findings
   in, and a checklist tool that walks through pulling recent traces from the
   observability tool and filling in the log. Since live access is confirmed
   available (see decision #3 above), this can include an optional small
   read-only script that fetches the most recent traces automatically instead of
   requiring a person to click through the observability tool's website by hand.
   *(Execution note: the optional fetch script ships, but exercising it live
   waits on network access — see the header note.)*
7. **CT7 — Add an optional, informational-only AI-graded quality scorecard.** This
   is the one piece of this track that adds a small new code module (still not
   touching the actual product — it's a separate, manually-run scoring script).
   The idea: for the handful of test cases that produce full written answers (not
   all 58 do — most check a single fact or a yes/no behavior), have a second AI
   model score the *quality* of those answers on a few specific dimensions
   (does it stick to the evidence, is it clinically useful, does it stay within
   scope), on a scale specifically designed to avoid wishy-washy middle scores.
   Critically: **this must never be wired into the automated pass/fail gate** —
   it only runs when someone chooses to run it by hand, and its results are
   purely for a human to read. Include a one-time step where a real domain expert
   scores a batch by hand too, so future runs can report how often the AI scorer
   agrees with the human.
8. **CT8 (backlog, not scheduled) — A future "replay real traffic" test harness**,
   sampling real (privacy-scrubbed) past questions instead of only hand-written
   test cases, to catch regressions that hand-written cases might miss. This is
   fully specified as an idea but deliberately not scheduled — pick it up later as
   its own ticket if there's ever a stretch of spare time and it seems valuable.

**Sequencing inside Track 2:** CT1 and CT4 are documentation-only and can land
immediately, independent of everything else. CT2 and CT3 share the same report
file's insertion point, so do them as one commit/pull request, in that order (CT2
first, since CT3's addition goes right after CT2's). CT5 can happen any time. CT6
and CT7 wait until after the submission crunch. CT8 stays a written-up backlog
idea unless it's specifically needed later.

---

## Explicitly out of scope for this whole plan (both tracks)

Merged from both source plans' own "don't build this now" lists:

- A secrets-management/rotation system (right-sized for a single-surgeon demo
  today; revisit once there's a second real customer).
- Migrating off the current hosting provider to something that can sign a formal
  data-protection agreement (only matters once real patient data enters the
  system, which it doesn't today).
- Access-control beyond the current three user roles (there's no real
  multi-organization problem to solve yet).
- A formal security-compliance certification program (starting that clock early,
  before a paying customer exists, wastes the 12-month observation window it
  requires).
- Broadening the product's clinical focus beyond retina/medical-retina into
  general ophthalmology — the single biggest "don't build" call carried over from
  Plan A; see Sub-track K's "stay narrow" decision above.
- Any note-writing, billing-code generation, or AI transcription/scribe feature —
  explicitly excluded by this project's own stated non-goals, and would blur the
  product's current strength of never originating clinical direction on its own.
- A full move to a heavyweight observability/monitoring platform beyond the
  observability tool already in use.
- A commercial circuit-breaker library or anything resembling full
  service-mesh-grade infrastructure — this project's own written requirements
  explicitly allow a simple, hand-rolled version (see H.10 above).
- The three medically-judgment-heavy pieces of the original product roadmap
  (deepening a specific imaging scenario, resolving a patient whose condition
  doesn't match the product's focus, and a first-time-user UI explainer) — see the
  note at the end of Sub-track K above.

---

## Verification — how to know this plan actually worked

- **After H.1:** re-run the rehearsal script and confirm the repo shows no
  leftover uncommitted changes to the eval-results report afterward.
- **After H.4:** the live end-to-end flow test against the real deployed app
  passes, and there's a viewable trace for that specific run in the observability
  tool.
- **After H.5 / H.10:** a test that deliberately makes a mock OpenEMR call hang
  past the new timeout, confirming the caller recovers instead of freezing.
- **Before considering Sub-track H done:** the full check sequence (tests,
  typecheck, eval gate) still passes cleanly — these were all already passing
  before this work started, and must stay that way throughout.
- **After K.4/K.5:** log in using each demo role and confirm the landing menu is
  the new, narrowed ophthalmology view, not the old full stock menu — a
  before/after screenshot is the clearest evidence to attach to that pull
  request.
- **After CT2:** the automated report shows the new coverage-by-difficulty
  section, and the full case count is still 58 out of 58 passing.
- **After CT3:** the two new retrieval-quality numbers appear in the report and
  are identical on a second run (the test data is fixed, so the numbers
  shouldn't vary run to run).
- **After CT7:** running the new scoring script produces its report locally, and
  running the normal automated gate with or without ever having run the scoring
  script produces byte-for-byte identical gate output — proving it truly never
  influences the pass/fail result.
- **Standing, for every ticket in both tracks:** the relevant tracking dashboard
  and checklist files got updated in the same pull request as the code, per the
  standing rules above — not as a follow-up.

---

## Suggested overall order

Since both tracks run in parallel, this is "what to do first *within* each track,"
not a strict global sequence:

- **Track 1:** H.1, H.2, H.3 together first (trivial) → H.4 alongside H.5
  (highest real risk + cheapest high-value fix) → H.6 → the rest of the P1/P2
  items in Sub-track H, in any order respecting the two noted dependencies →
  Sub-track J (J.1–J.3, then J.4–J.5) once grading closes → Sub-track K's three
  cheap items (K.1, then K.4/K.5) whenever there's spare time, not deadline-bound.
- **Track 2:** CT1 and CT4 immediately (cheap, grader-visible) → CT2 and CT3
  together (share a file) → CT5 any time → CT6 and CT7 after the submission
  crunch → CT8 stays backlog.
