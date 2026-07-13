# E.3 — Write-path auth: 401/403 on document upload (verify already done)

REQ: locked decision #14, S5 · Depends on: A.3 (upload route — shipped) · Band: 2

## Why

Locked decision #14: no public unauthenticated EHR write path — write routes
require a dev-login bearer with a role gate while read/chat stay open for
graders. Fact verification already enforces this; **document upload does not**
(`src/routes/ingest.ts:6-7` says so explicitly: "Write-path auth hardening …
is ticket E.3"). For Dan's demo this is the role-switcher moment: front-desk
(nurse) uploads the renal panel; flipping to resident shows a friendly 403.

## Existing seams you MUST reuse

- `src/routes/verify.ts:31-38` — **THE reference pattern** (401/403 in-route, regardless of `AUTH_MODE`, because writes must be attributable): `request.principal === null` → `401 { error: 'verification_requires_auth' }`; capability false → `403 { error: 'role_cannot_verify', role }`.
- `src/auth/middleware.ts:registerAuth(app, deps: AuthDeps | undefined)` (:76) — global preHandler (:84) attaches `request.principal` from the Bearer token in BOTH modes; in `enforced` mode it already 401s missing tokens (:115), 403s cross-patient on any `:patientId` route (:119), and 403s role-capability (:121-123, `requiresPrepTrigger` example). Do not duplicate its work — the in-route check adds only what `off` mode lacks.
- `src/auth/principal.ts:Capabilities` (:36-40) — `{ readonly read: boolean; readonly triggerPrep: boolean; readonly verify: 'full' | 'needs_attending_sign_off' | false }`; `capabilitiesFor(role: Role): Capabilities` (:43-52) — **exhaustive switch, no default** (adding a field forces every arm to update — that is the point).
- `src/auth/principal.ts:ROLES` (:8) — `['physician', 'nurse', 'resident'] as const`.
- `src/routes/auth.ts:28` — `POST /api/dev-login` mints `{ access_token, token_type: 'Bearer', expires_in, role, patient }`; `src/auth/devToken.ts:DevTokenService` — `mint(claims: { username: string; patient: string; role: Role; scopes?: readonly string[] }): { token: string; expiresIn: number }`, `verify(token): Principal`.
- `src/routes/ingest.ts:67` — `POST /api/patients/:patientId/documents` handler (the insertion point, before `request.file()` is read).
- `test/verify.test.ts` — the test file to mirror: `it('requires an authenticated clinician even when AUTH_MODE=off')` (:82), `it('a nurse cannot verify (403), and nothing is written')` (:72), `it('blocks cross-patient verification (403), and nothing is written')` (:91).
- `panel/src/api.ts:uploadDocument` (:206-224) — returns `{ ok: false, message }` on non-2xx; `apiFetch` (:38-44) already attaches `Authorization: Bearer` when the panel has a token. `panel/src/UploadCard.tsx:51-54` — `setPhase({ kind: 'error', message: result.message })`, rendered :160-162.

## Files to create/modify

- `sidecar/src/auth/principal.ts` — add `documentsWrite: boolean` to `Capabilities`; set it in all three `capabilitiesFor` arms.
- `sidecar/src/routes/ingest.ts` — 401/403 guard at the top of the upload handler.
- `sidecar/test/ingest-routes.test.ts` — authenticate the existing upload tests + new auth cases (mirror verify.test.ts).
- `sidecar/panel/src/api.ts` — friendly 401/403 messages in `uploadDocument`.
- `docs/RUNBOOK.md` §D — one paragraph: uploads now require a dev-login bearer (physician/nurse) in every mode; README W2 section gets one line.

## Step-by-step implementation

1. **Capability** (`principal.ts`) — extend the interface and every arm:

```ts
export interface Capabilities {
    readonly read: boolean;
    readonly triggerPrep: boolean;
    readonly verify: 'full' | 'needs_attending_sign_off' | false;
    /** May store documents into the chart (upload → OpenEMR Documents). */
    readonly documentsWrite: boolean;
}
// physician → documentsWrite: true; nurse → true (the demo's front-desk persona
// rides the nurse role); resident → false.
// NOTE: an adjustable product default, not a clinical ruling — revisit with real
// role feedback; the seam is this one field.
```

2. **Route guard** (`ingest.ts`, first lines of the upload handler, before `request.file()`):

```ts
const principal = request.principal;
if (principal === null) {
    return reply.status(401).send({ error: 'upload_requires_auth' });
}
if (!capabilitiesFor(principal.role).documentsWrite) {
    return reply.status(403).send({ error: 'role_cannot_upload', role: principal.role });
}
```

   Import `capabilitiesFor` from `../auth/principal.js`. This runs regardless
   of `AUTH_MODE` (the verify-route posture: EHR writes are attributable,
   period). Cross-patient stays the middleware's job (enforced mode), exactly
   as verify.ts does — do not re-implement it here.
3. **Read paths stay open**: do NOT guard `GET /api/ingestions/:id`,
   `GET /api/ingestions/:id/file`, `GET /api/patients/:patientId/ingestions`,
   or `POST /api/evidence/search` (read/search surfaces; locked #14 keeps
   them open for graders; the file route also feeds the `<img>`/iframe-style
   preview which cannot carry a header).
4. **Fix the existing upload tests** (`test/ingest-routes.test.ts`): the
   `makeApp()` helper (:58-76) boots `buildServer` without auth deps, so
   `request.principal` is always `null` and every existing upload test would
   now 401. Extend `makeApp` to wire dev-token auth in `off` mode and mint a
   header helper:

```ts
const devTokens = new DevTokenService({ secret: 'test-secret-test-secret' });
const app = buildServer(config, { ...existing,
    auth: { verifier: new CompositeVerifier(devTokens, undefined), mode: 'off' },
});
const bearer = (role: Role = 'physician', patient = 'margaret-chen') =>
    ({ authorization: `Bearer ${devTokens.mint({ username: 'dr-demo', role, patient }).token}` });
```

   Add `headers: bearer()` to every existing upload `inject` call (status
   routes stay headerless — they must keep passing without auth).
5. **New tests** (below), **panel messages** (`uploadDocument`, before the
   generic `!res.ok` branch):

```ts
if (res.status === 401) return { ok: false, message: 'Sign in with a clinical role (dev login) to upload documents.' };
if (res.status === 403) return { ok: false, message: 'Your current role cannot upload documents — switch to physician or nurse.' };
```

6. Docs (RUNBOOK §D + README line), trackers, ship.

## What NOT to do

- Do NOT gate the upload behind `AUTH_MODE === 'enforced'` — the whole point
  is 401/403 in every mode (verify.ts precedent).
- Do NOT add cross-patient logic in the route — that duplicates the
  middleware PEP and drifts.
- Do NOT touch `OPEN_PATHS` / `OPEN_PREFIXES` in `middleware.ts` — no path
  changes are needed; the upload path was never open-listed.
- Do NOT close the read/status/search routes — graders use them tokenless.
- Do NOT weaken `capabilitiesFor`'s exhaustive switch with a default branch.
- Do NOT let existing tests "pass" by removing their upload assertions —
  authenticate them instead.

## Acceptance checks

```bash
cd sidecar && npm test && npm run typecheck    # green, incl. updated ingest-routes tests
# Manual (AUTH_MODE=off, DEV_LOGIN_SECRET set):
curl -s -o /dev/null -w '%{http_code}' -X POST localhost:8080/api/patients/margaret-chen/documents \
  -F doc_type=lab_pdf -F file=@sidecar/eval/fixtures/documents/renal-panel-clean.pdf   # → 401
TOKEN=$(curl -s -X POST localhost:8080/api/dev-login -H 'content-type: application/json' \
  -d '{"role":"resident","patient":"margaret-chen"}' | jq -r .access_token)
# same POST with -H "Authorization: Bearer $TOKEN"                                      # → 403
# repeat with "role":"nurse"                                                            # → 202
```

Panel: logged out → upload shows the friendly sign-in message; resident role →
the switch-roles message; nurse/physician → staged progress as before.

## Tests to add

`sidecar/test/ingest-routes.test.ts`, new `describe('document upload auth (E.3)')` (mirror verify.test.ts):

- `it('requires an authenticated clinician even when AUTH_MODE=off')` — no header → 401 `{ error: 'upload_requires_auth' }`; `records` store stays empty.
- `it('a resident cannot upload (403), and nothing is ingested')` — resident bearer → 403 `{ error: 'role_cannot_upload', role: 'resident' }`; no ingestion record, VLM stub never called.
- `it('a nurse can upload — the front-desk persona (202)')` — nurse bearer → 202 with `ingestion_id`.
- `it('status and evidence routes stay open without a token')` — `GET /api/ingestions/:id` (404 for unknown id, not 401) and `POST /api/evidence/search` (200) with no header.

## Tracker updates

- `docs/w2/requirements.md` — under **S5** flip: `- [ ] Demo auth (locked): write paths (upload, vitals write, verify) require a dev-login bearer with role gate; read/chat surfaces stay open for graders.` → `- [x]`, annotating: "(vitals write joins this gate when its route lands — no vitals route exists yet)".
- `docs/w2/build-status.html` — DATA (starts L189): `{ id: "E.3", t: "Write-path auth: dev-login bearer + role gate", reqs: ["#14"], deps: "A.3", s: "pending" }` (L247) → `s: "done"`; bump the S5 reqGroup done-count.
- `W2_ARCHITECTURE.md` — §13 header (`## 13. Security & privacy posture (REQ: G18, P5) — [TARGET deltas on SHIPPED model]`): record the upload write-gate as shipped in the header marker or the section's delta list.

## Verify + ship ritual

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
cd sidecar/panel && npx tsc -p tsconfig.json --noEmit && npx vitest run && npm run build
```

Then: conventional commit with `--trailer "Assisted-by: Claude Code"`
(trackers in the SAME commit) → `git push -u origin
claude/openemr-rag-requirements-x25vzm` → update PR #9 body → SendUserFile
`docs/w2/build-status.html`.
