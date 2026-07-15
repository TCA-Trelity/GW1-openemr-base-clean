# J.5 — RUNBOOK: exact steps to disable dev-login for a pilot

REQ: P5 (demo-only credentials posture) · Depends on: — · Band: merged-plan Track 1 (J) · Priority: P1 within sub-track J (per merged-plan.md)

> **DOCS ONLY — the dev-login CODE stays untouched through grading.** The
> merged plan is explicit: dev-login is live on the deployment today, is
> correctly documented as demo-only (Wave P locked decision: "demoted, not
> removed"), and grading depends on it working. This ticket writes the
> turn-it-off procedure into the runbook so pilot day is a 2-minute mechanical
> flip, not a design conversation. The flip itself executes at pilot start —
> also after grading, by definition.

## Why

`POST /api/dev-login` mints patient-bound, role-carrying demo tokens with a
shared secret — perfect for graders, wrong for a real pilot. The off-switch
already exists structurally (it is env-var presence, no code change needed),
but nobody has written down the exact sequence, the verify, or what the panel
does afterwards. Under pilot-day pressure, "remove one variable and run one
curl" must be readable, not re-derived.

## Existing seams you MUST reuse (verified against code — cite these in the doc)

- `sidecar/src/config.ts:65` — `DEV_LOGIN_SECRET: z.string().min(16).optional().catch(orWarn(undefined, 'DEV_LOGIN_SECRET'))` — absent OR shorter than 16 chars ⇒ dev-login off (a too-short value logs `[config] DEV_LOGIN_SECRET is invalid and was ignored`).
- `sidecar/src/server.ts:161-162` — the `DevTokenService` is constructed only when `config.DEV_LOGIN_SECRET !== undefined`; without it, `deps.authRoutes.devTokens` is absent.
- `sidecar/src/routes/auth.ts:28-31` — the route answers `404 {"error":"dev_login_disabled"}` when `deps?.devTokens === undefined`. **404, not 403** — the endpoint denies its own existence; the verify below expects exactly this.
- `sidecar/src/auth/middleware.ts:35` — `OPEN_PATHS` includes `/api/dev-login` (staying in that list is harmless once the route 404s; do not "clean it up" in this docs ticket).
- `docs/RUNBOOK.md` §D ("Turn on authorization (Wave AZ) — the patient-bound demo", line 170) — steps D.1 (enable dev-login: the exact table this ticket mirrors in reverse), D.2 (`AUTH_MODE=enforced`), D.4 (real SMART EHR-launch path), and the trailing "To turn enforcement back off" note. The new subsection lands at the END of §D, before `## E. Backup & recovery`.
- `docs/internal/tickets/USER-ACTIONS.md` item 6 — the original key-drop (drop steps + the working verify curl this ticket inverts).
- Panel behavior seams: `sidecar/panel/src/api.ts:53 devLogin(role, patient)` and RUNBOOK §D.1's "the panel mints a patient-bound token on every patient/role switch" — needed for the honest "what the panel does afterwards" note.

## Files to create/modify

- `docs/RUNBOOK.md` — ONE new subsection appended inside §D (heading style mirrors `### C2. …`): `### D2. Disabling dev-login for a pilot (J.5)`. No other file. No code.

## Step-by-step implementation

1. Append the subsection to RUNBOOK §D with exactly this content shape (commands fully filled in, no placeholders, no inline comments in copy-paste blocks — house rule / merged-plan standing rule 9):

   ```markdown
   ### D2. Disabling dev-login for a pilot (J.5)

   Demo posture ships with `POST /api/dev-login` enabled (§D.1). For a real
   pilot, turn it off. This is configuration only — no deploy of new code.

   1. **Remove the secret.** Railway → **enchanting-mercy** (the sidecar
      service) → **Variables** → row `DEV_LOGIN_SECRET` → delete it → click
      the **Apply/Deploy** banner and wait for the deployment to go green.
   2. **Verify it is off** (expect HTTP 404 with `dev_login_disabled`):

      ```bash
      curl -s -i -X POST https://enchanting-mercy-production-5d32.up.railway.app/api/dev-login -H 'content-type: application/json' -d '{"role":"physician","patient":"margaret-chen"}'
      ```

      A 404 `{"error":"dev_login_disabled"}` is success. A 200 with an
      `access_token` means the variable survived — re-check step 1 and that
      the redeploy actually ran.
   3. **What the panel does now.** The role switcher can no longer mint
      tokens (its dev-login calls 404). With `AUTH_MODE=enforced` (§D.2 —
      the correct pilot posture), every per-patient route requires a real
      OpenEMR-issued SMART token (§D.4); panel access without one is 401.
      With `AUTH_MODE` unset/`off`, routes stay open and the panel works
      read-only-style without role switching — an acceptable interim, but
      not the pilot end-state.
   4. **Pilot pairing.** The full pilot flip is: remove `DEV_LOGIN_SECRET`
      **and** keep `AUTH_MODE=enforced` **and** have the SMART launch path
      configured (§D.4). Doing only step 1 with enforcement on locks
      everyone out until SMART works — sequence deliberately.
   5. **Reverting for a demo later:** re-add `DEV_LOGIN_SECRET` per §D.1
      (fresh `openssl rand -hex 24` — do not reuse the old value) and
      Apply/Deploy.
   ```

2. Sanity-read §D top-to-bottom after inserting: §D.1 (on), §D.2 (enforce), the new D2 (off) must not contradict each other; the trailing `AUTH_MODE=off` note already covers enforcement-off and stays as-is.
3. Trackers, ship ritual.

## What NOT to do

- Do NOT touch any `.ts` file, `sidecar/openapi.yaml`, or env handling — grading depends on dev-login working; this is a documentation-only PR by charter.
- Do NOT perform the Railway variable removal now — the doc describes a future pilot action; executing it today breaks the graded demo (the panel role switcher and E.3's auth demo depend on it).
- Do NOT document deleting the panel role switcher or editing `OPEN_PATHS` — reversibility is the point; the switch is env-var presence.
- Do NOT weaken the ≥16-char guidance elsewhere in the runbook (config.ts enforces min 16; §D.1 recommends 32+ — both true, leave both).
- Do NOT link this internal-procedure change from README or grader-facing docs (standing rule 7 posture; RUNBOOK is already the ops surface).

## Acceptance checks

```bash
grep -n "D2. Disabling dev-login" docs/RUNBOOK.md
grep -n "dev_login_disabled" docs/RUNBOOK.md
```

Both hit inside §D (between lines for `## D.` and `## E.`). Every claim in
the new subsection traces to the seams above (spot-check: config.ts:65 min
length, auth.ts:30 404 body). Optional live proof WITHOUT touching prod
config: run the sidecar locally with no `DEV_LOGIN_SECRET` and curl
`localhost:8080/api/dev-login` → 404 `dev_login_disabled` (this validates the
documented expectation against real code today).

## Tests to add

None (docs-only). The local keyless curl above is the executable evidence;
paste its output in the PR body.

## Tracker updates

- `docs/internal/build-status.html` DATA block: ticket `J.5` (T1 section) → `s: "done"`.
- `docs/w2/requirements.md` — no checkbox for this follow-on; do not invent one.
- `W2_ARCHITECTURE.md` §13 (Security & privacy posture) — no status change needed (the posture text already says dev-login is demo-only); add nothing unless the section literally contradicts the new runbook subsection.

## Verify + ship ritual

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

(Docs-only PR — belt-and-braces; `evals.yml` runs on every PR as the required
check regardless.) Panel untouched — skip the panel leg. Then: conventional
commit (`docs(runbook): …`) with `--trailer "Assisted-by: Claude Code"`
(trackers in the SAME commit) →
`git push -u origin claude/merged-eval-course-plan-ky6ulh` → update the
PR #16 body → SendUserFile `docs/internal/build-status.html`.
