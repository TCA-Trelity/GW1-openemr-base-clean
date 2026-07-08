# Execution Plan — Clinical Co-Pilot build-out

*Ticket-level execution tracker for Tier 1 (Early Submission, Thu 11:59 PM CT)
and Tier 2 (Final, Sun 12:00 PM CT). This file is the **single source of
truth** for scope and status — it survives context windows, sessions, and
machines. Rules: every commit references a ticket ID in its body; a ticket's
checkbox flips in the same PR that completes it; scope changes edit this file
first. Grain: one ticket ≈ one reviewable diff. The PRD
(`docs/defense/PRD-clinical-copilot.md`) remains the *why*; this file is the
*what/when/who*.*

**Agent legend** — who executes each ticket:
- **main** — the primary Claude Code session (orchestrator + integrator; owns
  merges, deploys, and anything touching more than one area)
- **sub/wt** — parallel subagent in an isolated git worktree; returns a
  reviewed diff (used for self-contained units: schema ports, pure engines,
  frontend components, corpus authoring)
- **user** — dashboard/browser actions only the human can do (Railway UI,
  secrets, video)
- **railway** — scripts that must run *inside* the Railway project because the
  dev session cannot reach the live app (seeding, OAuth registration)
- **ci** — GitHub Actions; public runners CAN reach the live URL, so live
  smoke/e2e verification runs here

**Verification channel** per ticket: `unit` (vitest in repo), `ci-live` (smoke
against the deployed URL), `screenshot` (user confirms UI), `logs` (Railway
deploy logs).

---

## Phase 0 — Platform stabilization (tonight, serial, blocks everything)

| ID | Ticket | Agent | Depends | Verify | Done |
|---|---|---|---|---|---|
| P0.1 | Attach Railway volume at `/var/www/localhost/htdocs/openemr/sites` on the OpenEMR service (stops DB reset per push) | user | — | logs: next boot shows setup skipped | ☑ |
| P0.2 | Set Watch Paths on OpenEMR service to ignore `sidecar/**` and `docs/**` | user | — | push a docs commit → no rebuild | ☑ |
| P0.3 | Verify demo data + admin login stable across a push; change admin password from demo default | user | P0.1 | screenshot | ☑ |
| P0.4 | Commit this plan + update `docs/HANDOFF.md` with locked decisions (imaging metadata authored-at-seed; Kermany-style public OCT imagery; all-four imaging features Thu; embedded panel Thu; F9→`medicationRiskFlags` canonical; scan storage = sidecar volume behind `ImageStore` interface) | main | — | in repo | ☑ |

## Phase 1 — Walking skeleton (Wednesday; goal: one real prep runs end-to-end on Railway by EOD)

**Wave A — parallel (subagents in worktrees, no shared files):**

| ID | Ticket | Agent | Depends | Verify | Done |
|---|---|---|---|---|---|
| S1.1 | `sidecar/` scaffold: Fastify + TS strict + pino logging with correlation-ID middleware (ID on every log line, propagated to tool + LLM calls), config loader, error envelope, Dockerfile, `railway.json`, `/health` + `/ready` (ready = real checks: OpenEMR reachable, Anthropic key valid, Langfuse reachable, Postgres/Redis up) | main | P0.4 | unit + logs | ☑ |
| S1.2 | Port Zod schemas verbatim from port manifest §2: `PatientFact` (11 fact types, content shapes), `CitationRef` (character-range excerpt), rich `Contradiction`, `SourceDocument`, `ProviderProfile` thresholds, image/treatment shapes. Contracts = source of truth; exported for panel reuse | sub/wt | — | unit (schema fixtures) | ☑ |
| S1.3 | Port pure engines + unit tests w/ golden numbers: `medicationRiskFlags` (canonical per F9; AAO thresholds), `computeTreatmentContext`, `computeComparison`, `analyzeIntervalPatterns`, `analyzeHCQProgression`; inject clock (manifest §3); document the failure mode each test guards | sub/wt | S1.2 | unit | ☑ |
| S1.4 | Author seed corpus: Margaret Chen (12 source docs, 4 contradictions w/ ground truth, HCQ series w/ authored GC-thinning trend) + William Thompson (7 OCT + 4 injections, 49→71d over-extension) as OpenEMR-ready payloads; source public OCT B-scans (CNV-class for fluid visits, normal post-tx; normal for HCQ) + `docs/data-sources.md` attribution (CC BY) | sub/wt | S1.2 | unit (corpus validates against schemas) | ☑ |

**Wave B — serial on main (integration spine):**

| ID | Ticket | Agent | Depends | Verify | Done |
|---|---|---|---|---|---|
| S1.5 | OpenEMR client: OAuth2 client_credentials (system, read-only) + SMART EHR-launch flow; FHIR R4 reads (8 resource types per ARCHITECTURE §2); registration script (`sidecar/scripts/register-oauth.ts`) runnable on Railway | main | S1.1 | ci-live | ☑ |
| S1.6 | Fact store: Postgres schema + migrations (facts, citations, contradictions, source docs, briefs, image records, treatments); derived-view wipe/rebuild command | main | S1.2 | unit | ☑ |
| S1.7 | Prep pipeline: BullMQ job → FHIR fetch → Sonnet 5 extraction to typed facts (schema-validated, retry on invalid) → contradiction detection → med-risk arithmetic → imaging analytics over authored metadata → brief assembly → store | main | S1.3, S1.5, S1.6 | unit (recorded LLM fixtures) + logs | ☑ |
| S1.8 | Citation gate: deterministic resolver (every claim's CitationRef must resolve to stored source excerpt; failures rewritten as absence + logged as verification-fail metric) | main | S1.6 | unit (invariant tests) | ☑ |
| S1.9 | Railway topology: sidecar + Postgres + Redis + Langfuse services in existing project; sidecar volume for scans; user adds `ANTHROPIC_API_KEY` in Variables; seed job (`sidecar/scripts/seed.ts`) runs on Railway against live EHR | main + user + railway | S1.1, S1.4 | logs + ci-live | ☐ |
| S1.10 | CI: sidecar unit tests on PR; live smoke workflow (hits `/ready`, triggers prep for seed patient, asserts brief exists + citations valid) — this is the session's eyes on prod | main | S1.9 | ci-live | ☐ |

**Exit criteria Wed:** smoke workflow green — a prepared brief for Margaret Chen exists on the live deployment, every fact cited, gate passing.

## Phase 2 — Surface + hard-gate deliverables (Thursday)

| ID | Ticket | Agent | Depends | Verify | Done |
|---|---|---|---|---|---|
| S2.1 | React panel shell: Vite + Tailwind/shadcn (ported design system), brief tabs per manifest §4 (Overview / Medical Background / Diagnosis & Care / Sources), citation chips → source cards (verbatim excerpt highlight, attribution, deep link) | sub/wt | S1.2 | screenshot | ☐ |
| S2.2 | Imaging spine + all four features: ImagingTimeline (+days-post-injection badges), TrendAnalysis (CRT/GC w/ thresholds), IntervalAnalysis (treat-and-extend recommendation), ImageComparison (≤4 side-by-side); images served from sidecar `ImageStore` | sub/wt | S1.4, S2.1 | screenshot | ☐ |
| S2.3 | Chat loop: Haiku 4.5 over prepared fact bundle, strict inline citation token contract + parse-back to chips (manifest §5), streaming, conversation persistence, quick prompts | main | S1.7, S1.8 | ci-live + screenshot | ☐ |
| S2.4 | **Embed (committed for Thu):** `oe-module-clinical-copilot` — brief card into patient chart via `SectionEvent`/`CardRenderEvent`, iframe → SMART-launched panel, patient-bound token. Timeboxed to Thu AM; fallback = chart link to standalone panel (decision point 1 PM CT) | main | S2.1, S1.5 | screenshot | ☐ |
| S2.5 | Eval suite as deliverable: fixtures from corpus ground truth (planted contradictions found; citation validity 100%; calculator goldens; empty/missing-record boundaries; cross-patient denial; injection corpus in a seeded referral letter); runs in CI; results exported to `docs/execution/eval-results.md` | sub/wt | S1.7, S1.8 | unit + ci-live | ☐ |
| S2.6 | Observability deliverable: Langfuse dashboard (requests, error rate, p50/p95 per surface, tool calls, retries, verification pass/fail, token spend) + 3 alerts documented w/ on-call response in `docs/execution/observability.md` | main | S1.9, S2.3 | screenshot | ☐ |
| S2.7 | Bruno collection (`sidecar/api-collection/`): health/ready, register, trigger prep, get brief, chat turn, verify fact — runnable by graders without source | main | S2.3 | ci-live | ☐ |
| S2.8 | `COSTS.md`: actual dev spend (Anthropic console + Langfuse tokens) + 100/1K/10K/100K projections w/ architecture inflections (from ARCHITECTURE §11) | main | S2.6 | review | ☐ |
| S2.9 | Demo video #2: script update (brief → drill-down chat → imaging story → contradiction verify → dashboards), user records | main + user | all above | — | ☐ |

**Exit criteria Thu:** agent works in the live environment (embedded), eval results committed, dashboard live, video submitted.

## Phase 3 — Tier 2 / Final (Fri–Sun)

| ID | Ticket | Agent | Depends | Verify | Done |
|---|---|---|---|---|---|
| S3.1 | Load tests: 10 + 50 concurrent vs live (k6 in CI), p50/p95/p99 + error rate; baseline CPU/mem/latency/throughput captured to `docs/execution/baselines.md` | ci | Phase 2 | ci-live | ☐ |
| S3.2 | Hardening per PRD Tier 2: dispatch.php error-disclosure fix (S2), background_service route verification (F6/U2.4), secrets audit | main | Phase 2 | unit + review | ☐ |
| S3.3 | Verification workflow polish: role-gated fact verification UI (physician vs delegated), disputed state, verify-audit trail | main | S2.1 | screenshot | ☐ |
| S3.4 | Eval expansion: flagged-output→fixture loop wired (panel flag control → Langfuse annotation), regression run on every push | main | S2.5, S2.6 | ci-live | ☐ |
| S3.5 | Production-thinking docs refresh: failure-mode drill results, rollback rehearsal (module disable + fact-store rebuild), interview prep sheet | main | S3.1–S3.4 | review | ☐ |
| S3.6 | Final demo video + social post | user | all | — | ☐ |

## Standing rules

- **Sequencing invariant:** platform (P0) before code; skeleton deployed before surface; the embed decision point is Thu 1 PM CT.
- **Subagent protocol:** worktree isolation for parallel tickets; every subagent diff gets a code-review pass before merge; no subagent touches `sidecar/src/schemas/` after S1.2 lands except via main.
- **Session continuity:** each new session starts by reading this file + `docs/HANDOFF.md` + `docs/execution/DECISIONS.md`. Status updates are commits, not memory.
- **Live verification:** the dev session never assumes live behavior — CI smoke (S1.10) is the arbiter.
- **Software-factory conventions** (`.claude/skills/software-factory/`) apply to all build work: GATE 1 = this plan approved before Phase 1 code; GATE 2 = deploys/pushes per the already-authorized Railway flow, with anything scope-changing or hard-to-reverse re-gated explicitly. Code style: 1–3-line file header comments (what/why), no speculative abstraction, fewer files, dependencies must pull real weight. Communication: quiet during routine work; every judgment call surfaced as a vetoable `DECISION:` one-liner and logged to `DECISIONS.md`. Verification findings (including the **untested** list) are written to the state docs, not just chat. Healthcare domain escalation: verification design is production-grade at every tier.
