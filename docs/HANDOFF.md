# Session handoff — Clinical Co-Pilot (AgentForge Week 1)

*State file for continuing work in a fresh session. Read this first, then
`docs/defense/PRD-clinical-copilot.md` (the execution plan) and `AUDIT.md` /
`USERS.md` / `ARCHITECTURE.md` (the graded deliverables).*

## Where everything lives

| Artifact | Path |
|---|---|
| Architecture defense (full, w/ 500-word summary) | `docs/defense/architecture-defense.md` |
| Slide copy (8 slides) + diagram | `docs/defense/architecture-defense-slides.md`, `architecture-diagram.svg` |
| Tiered PRD (T0 gates → T1 Thu → T2 Sun → T3 roadmap) | `docs/defense/PRD-clinical-copilot.md` |
| MVP hard gates | `AUDIT.md`, `USERS.md`, `ARCHITECTURE.md` (repo root) |
| Demo video script | `docs/defense/demo-script.md` |
| Railway deploy runbook + env template | `deploy/railway-runbook.md`, `deploy/.env.example` |
| Research: OpenEMR reviews | `docs/research/openemr-reviews.md` |
| Research: second-opinion full port manifest | `docs/research/second-opinion-port-manifest.md` |
| Brownfield-review skill | `.claude/skills/chesterton/` |
| Draft PR (submission surface) | PR #1 on this repo, branch `claude/ehr-architecture-defense-gg486o` |

**Not in this public repo, by design (hand-carried zip):** the design-partner
discovery synthesis (confidential; first-name-only rule applies to all repo
content) and the AgentForge course PDF.

## Decisions log (all confirmed with the user)

1. **Sidecar service** beside untouched OpenEMR; FHIR R4 + OAuth2/SMART only.
2. **Brief-first UI + chat drill-down**; imaging one toggle away.
3. **Imaging:** surface + deterministic analytics in scope (T2); raw-pixel
   model interpretation deferred (T3); schema slot reserved.
4. **Verification:** precomputed fact store + deterministic citation gate;
   domain rules as arithmetic.
5. **Dual credentials:** SMART patient-bound (interactive) / read-only system
   client (preparer).
6. **PostgreSQL** fact store (derived view; pgvector installed, unused).
7. **Two-tier models:** Claude Sonnet 5 (deep reader) / Claude Haiku 4.5
   (chat), Anthropic API under BAA assumption.
8. **TypeScript end-to-end** (Node.js + Fastify + Zod) — chosen so validated
   prototype engines port unchanged.
9. **Seed data:** full Margaret Chen + William Thompson conversion, incl.
   eye-exam forms; corpus doubles as eval ground truth.
10. **Deploy: Railway** (user's browser; Railway API egress-blocked from
    agent sessions). GCP abandoned (env credential is an expired/unscoped
    proxy-injected token). Demo-on-PaaS / pilot-on-BAA-infra note recorded.
11. **Tiered PRD** with hard cutoffs; MVP-tonight scope is gates only.
12. **Public-repo hygiene:** design partner first-name only; no secrets,
    project IDs, or personal info in committed files; secret-scan before
    every push.
13. Defense format (≤4 pages + 8 slides incl. economics slide) was the
    user's spec, not the PDF's; PDF names no discrete Architecture-Defense
    artifact — MVP-stage gates are the graded files.

## Current status / immediate next steps

- **DONE:** all Tier-0 documents committed and pushed; PR #1 open.
- **PENDING (user):** run `deploy/railway-runbook.md` (~10 min) → paste the
  public URL + the generated `OE_PASS`; record demo video from script;
  confirm Gauntlet's actual submission venue; optional `USER.md` pointer file
  (PDF is inconsistent: Stage-4 says `USERS.md`, final table says `USER.md`).
- **NEXT (agent, once URL exists):** verify deploy; register OAuth clients
  (SMART app + system client) against the live instance; seed 1–2 smoke
  patients via API; update PR description + README with the URL; then begin
  Tier 1 in PRD unit order (U1.1 scaffold → U1.2 engines → U1.3 migrations →
  U1.4 module → …). Railway services to add at T1: `sidecar`, `postgres`,
  `redis`, `langfuse` (self-hosted); `ANTHROPIC_API_KEY` set by user directly
  in Railway variables — never shared in repo or chat.

## Known constraints for any new session

- Egress: Railway/Render/Fly APIs are 403-blocked; googleapis reachable;
  the deployed app's public URL will be reachable over HTTPS (use it for
  API-based verification/seeding).
- OpenEMR PHP additions must clear PHPStan level 10 with zero new baseline
  entries (see `CLAUDE.md`).
- The two prototype med-risk engines diverge — reconcile per PRD F9/U1.2
  before porting.
- `analyzeOCT` in the prototype fabricates data — never port as logic (F10).

## Suggested kickoff prompt for a fresh session

> Read `docs/HANDOFF.md`, then `docs/defense/PRD-clinical-copilot.md`.
> Tier 0 status: [deployed URL: ___ / video: done or not]. Continue with
> [close Tier 0 / begin Tier 1 at U1.1], keeping the public-repo hygiene
> rules from the handoff.
