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

*(Updated 2026-07-07 evening — Tier 0 SUBMITTED.)*

- **DONE (Tier 0):** MVP submitted. Live app at
  https://gw1-openemr-base-clean-production.up.railway.app (Railway project:
  OpenEMR app service + mariadb over private networking; fork source baked
  into a `openemr/openemr:flex`-derived image; boot fixes in root
  `Dockerfile` + `deploy/wait-and-start.sh`; `DEMO_MODE=standard` loads the
  demo dataset — demo login resets to admin/pass on re-setup, then gets
  changed). PR #1 merged to `main`; `main` is canonical; GitLab mirror via
  `.github/workflows/mirror-to-gitlab.yml` (secrets `GITLAB_REPO` +
  `GITLAB_TOKEN`).
- **NOW (Tier 1/2):** execution is tracked ticket-by-ticket in
  `docs/execution/execution-plan.md`; decisions ledger in
  `docs/execution/DECISIONS.md`; software-factory conventions binding
  (`.claude/skills/software-factory/`). GATE 1 approved 2026-07-07. Phase 1
  in progress: S1.1 scaffold done (`sidecar/`), S1.2 schemas + S1.4 corpus
  fanned out to subagents.
- **PENDING (user):** P0.1 attach Railway volume at
  `/var/www/localhost/htdocs/openemr/sites`; P0.2 Watch Paths ignoring
  `sidecar/**` + `docs/**`; later `ANTHROPIC_API_KEY` on the sidecar service
  — set directly in Railway variables, never in repo or chat.

## Known constraints for any new session

- Egress: Railway/Render/Fly APIs AND `*.up.railway.app` are 403-blocked
  from the dev session. GitHub Actions runners CAN reach the live URL —
  CI smoke is the arbiter of live behavior; seeding/OAuth registration run
  as scripts on the Railway sidecar service.
- Railway builds from the GitHub **source archive**, which honors
  `.gitattributes` `export-ignore` — `actions/checkout` does not, so a
  tarball-only breakage is invisible to normal CI jobs. Reproduce locally
  with `git archive HEAD sidecar | tar -t`. Never add unanchored
  export-ignore patterns (they match at any depth); the
  `sidecar/** -export-ignore` carve-out + the `export-parity` CI job
  enforce this (see S3.7 in the execution plan).
- Pushes to the branch rebuild the OpenEMR service (and reset its DB until
  P0.1's volume is attached); watch paths (P0.2) stop sidecar/docs pushes
  from triggering EHR rebuilds.
- OpenEMR PHP additions must clear PHPStan level 10 with zero new baseline
  entries (see `CLAUDE.md`).
- F9 resolved: `medicationRiskFlags.jsx` is the canonical med-risk engine.
  F10 stands: `analyzeOCT` fabricates data — never port as logic.

## Suggested kickoff prompt for a fresh session

> Read `docs/HANDOFF.md`, `docs/execution/execution-plan.md`, and
> `docs/execution/DECISIONS.md`. Continue the build at the first unchecked
> ticket, keeping the software-factory conventions and public-repo hygiene
> rules from the handoff.
