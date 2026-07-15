# J.3 — Railway staging environment + manual promote-to-production

REQ: D8 (deployed-URL credibility) · Depends on: USER-ACTIONS item 12 (Railway dashboard clicks are user-only) · Band: merged-plan Track 1 (J) · Priority: P0 within sub-track J (per merged-plan.md)

> **PARKED — post-grading.** Sub-track J is "post-grading hardening". Extra
> reason to wait here: changing production's deploy trigger mid-grading-window
> risks the exact URL graders are using. Execute only after grading closes.

## Why

Today `main` deploys straight to the URLs a grader or prospective pilot user
is looking at: RELEASE.md states "the production Railway environment … tracks
this branch \[main\]" and "the merge **is** the promotion decision". That was
the right posture for the grading window (fast, simple, gate-protected). For
a pilot, one more airlock is wanted: a staging environment that auto-deploys,
and a deliberate human click to promote to production. The merged plan sizes
this as "the hosting provider's built-in preview-environment feature is
enough — no need for anything more elaborate."

## Existing seams you MUST reuse

- `railway.json` (repo root) — the **EHR service** build config (`builder: DOCKERFILE`, `dockerfilePath: Dockerfile`). No deploy-trigger config lives in the repo; triggers are Railway dashboard state.
- `sidecar/railway.json` — the **sidecar service** config; additionally sets `deploy.healthcheckPath: "/health"` + `restartPolicyType: "ON_FAILURE"`. RELEASE.md's "Health-gated deploys" hardening depends on this — staging must keep it.
- `RELEASE.md` — the branch/promotion model doc this ticket amends: "The model (current — PR-gated)" section, the "Promotion gate" section, the "Rollback" section, and the "Deploy triggers" bullet (RELEASE.md:84-88 — Railway watch paths for the EHR service are include-patterns `/**` + `!sidecar/**` + `!docs/**`; the sidecar service watches `sidecar/**`). Any staging environment must reproduce both services' watch paths or staging will rebuild wrongly.
- The two production domains (used in every runbook verify): sidecar `enchanting-mercy-production-5d32.up.railway.app`, EHR `gw1-openemr-base-clean-production.up.railway.app` (USER-ACTIONS "Finding the right Railway service"). Staging will mint new domains — the docs updated by this ticket must list them once known.
- `.github/workflows/live-smoke.yml` — `workflow_dispatch` takes a `sidecar_url` input (default = production). Staging verification reuses this workflow pointed at the staging URL; zero new CI needed.
- `docs/internal/tickets/USER-ACTIONS.md` item 12 + `docs/internal/user-actions.html` — the parked placeholder this ticket fills in (update both together, per the file's footer rule).
- Ops note (DECISIONS.md, 2026-07-08): the EHR service mounts a volume at `/var/www/localhost/htdocs/openemr/sites`, and the EHR **database persists across redeploys** (USER-ACTIONS item 5 verification). A staging environment gets its OWN fresh volume/DB unless deliberately shared — state this in the docs so nobody expects staging to carry production's seeded chart data without re-seeding.

## Files to create/modify

This ticket is docs + dashboard clicks; no application code.

- `RELEASE.md` — amend the model: staging environment description, the manual promote step, updated "Deploy triggers", a staging row in the verify/rollback guidance. Keep the historical sections intact (they are a record, not live instructions).
- `docs/internal/tickets/USER-ACTIONS.md` item 12 — replace the placeholder with the exact click sequence (Step 2 below) and its verify.
- `docs/internal/user-actions.html` — mirror the item 12 change (same commit).
- `docs/RUNBOOK.md` — one pointer line where deploy behavior is assumed (§A's redeploy notes) saying promotion is now manual per RELEASE.md.

## Step-by-step implementation

1. **Confirm the current Railway feature names before writing click steps.** Railway's UI evolves; the ticket executor (with the user, since only the user has dashboard access — USER-ACTIONS preamble) verifies against the live dashboard/docs which of these fits, in order of preference:
   a. **Environments**: duplicate the production environment into a `staging` environment (Railway supports environment duplication with services + variables). Staging services keep auto-deploy from `main`; the production environment's services get auto-deploy disabled (Service → Settings → Source/Deploy triggers), so production only moves when a human clicks Deploy/Redeploy on a chosen commit — that click IS the promote step.
   b. **PR environments** (ephemeral per-PR deploys) — weaker fit: they test branches, but the plan's goal is a persistent pre-production stage for `main`; use only if (a) is unavailable on the current plan tier.
2. **Write USER-ACTIONS item 12 (Railway half) as an exact click path** for option (a), in the file's established style (where to click → how to verify it took). Required content, fully filled in (house rule: no placeholders, no inline comments in copy-paste commands):
   - Create the `staging` environment by duplicating production (both services + Postgres; variables copy — then EDIT the staging sidecar's `OPENEMR_BASE_URL` to the staging EHR domain, and decide key posture: reuse the same Cohere/Langfuse/Anthropic keys or drop staging-only keys).
   - Flip production services to manual deploys; leave staging on auto from `main`.
   - Record the two new staging domains in RELEASE.md (the executor edits the doc when the user reports them).
   - Verify: push a docs-only commit to `main` → staging redeploys, production deployment list shows no new build; then promote once → production updates.
3. **Amend RELEASE.md.** Replace the "the merge is the promotion decision" clause with the two-stage model: PR gate (unchanged, branch protection) → auto-deploy to staging → manual promote to production. Update the Rollback section: rollback = redeploy previous production deployment (unchanged mechanics) and note staging as the rehearsal surface. Keep the "Hardening that protects this model" list and note health-gated deploys apply in both environments (sidecar/railway.json travels with the repo).
4. **Staging smoke.** Document (in item 12's verify) one `live-smoke` dispatch with `sidecar_url` set to the staging sidecar domain — GitHub → Actions → Live smoke → Run workflow → paste the staging URL. CI runners reach Railway (merged-plan execution note), so this works regardless of the sandbox egress policy.
5. **Seed note.** State in RELEASE.md that the staging EHR/DB starts empty on first creation: run the seed path from RUNBOOK §A against the staging EHR once (same scripts, staging URL) before expecting demo patients there.
6. Trackers, ship ritual.

## What NOT to do

- Do NOT change production's deploy trigger before the grading window is confirmed closed (the whole point of parking this).
- Do NOT hand-invent Railway UI steps from memory into USER-ACTIONS — every click line must be verified against the live dashboard (by the user) or current Railway docs at execution time; this spec deliberately leaves feature-name confirmation as Step 1.
- Do NOT create a staging environment that shares production's database (fresh volume/DB per environment unless the user explicitly chooses otherwise — a staging test that writes into production's chart data defeats the airlock).
- Do NOT add deploy scripts/CD workflows to the repo — the merged plan explicitly says the provider's built-in feature is enough.
- Do NOT delete or rewrite RELEASE.md's historical sections (orphaned-SHA notes are a record of real incidents).

## Acceptance checks

All runnable by the user + executor together after item 12's clicks:

```bash
git commit --allow-empty -m "docs(release): staging promote rehearsal ping" --trailer "Assisted-by: Claude Code"
git push origin claude/merged-eval-course-plan-ky6ulh
```

Then after that PR merges to `main`: staging shows a new deployment; the
production environment's Deployments tab shows none. One manual promote →
production shows exactly one new deployment. `live-smoke` dispatched against
the staging sidecar URL passes. RELEASE.md's model section matches observed
behavior (spec rule: if doc and reality disagree, fix the doc in the same PR).

## Tests to add

None (docs + dashboard state). The live-smoke dispatch against staging is the
executable test; record its run URL in the PR body.

## Tracker updates

- `docs/internal/build-status.html` DATA block: ticket `J.3` (T1 section) → `s: "done"` once the user confirms the clicks + one promote rehearsal.
- `docs/w2/requirements.md` — no checkbox for this follow-on; do not invent one.
- `W2_ARCHITECTURE.md` — no section describes deploy topology; no edit.

## Verify + ship ritual

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

(Docs-only PR — the sidecar suite is belt-and-braces here, and `evals.yml`
runs on every PR as the required check regardless.) Panel untouched — skip
the panel leg. Then: conventional commit with
`--trailer "Assisted-by: Claude Code"` (trackers in the SAME commit) →
`git push -u origin claude/merged-eval-course-plan-ky6ulh` → update the
PR #16 body → SendUserFile `docs/internal/build-status.html`.
