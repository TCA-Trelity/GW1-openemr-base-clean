# J.1 — Alert rules A1–A6 notify a human (Langfuse-native or sidecar webhook)

REQ: G15 (alerts wired to a person; definitions single-sourced per the 2026-07-13 DECISIONS.md entry) · Depends on: USER-ACTIONS item 11 (destination key drop) · Band: merged-plan Track 1 (J) · Priority: P0 within sub-track J (per merged-plan.md)

> **PARKED — post-grading.** Sub-track J is explicitly "post-grading
> hardening" (merged-plan.md, Track 1). Do not start this before the grading
> window closes; nothing in it is demo-critical. The spec is written now so
> execution later is cold-startable.

## Why

The six alert rules A1–A6 exist only as a documented table today
(`docs/execution/observability.md:39-48` — the "Alerts (≥3 required —
thresholds + on-call response)" section). Thresholds and on-call responses
are written, but nothing notifies anyone: a p95 breach or a verification
failure is invisible until someone happens to open Langfuse. One Slack (or
email) notification per firing rule closes G15's "alerts reach a person"
intent and makes the pilot posture credible for Dan.

## Existing seams you MUST reuse

- `docs/execution/observability.md:39-48` — the A1–A6 table (A1 p95 latency, A2 error rate, A3 verification/tool failure, A4 extraction failure rate, A5 RAG retrieval latency, A6 eval regression). **Single source of truth** — per the 2026-07-13 DECISIONS.md entry ("Alert definitions single-sourced in docs/execution/observability.md"), this ticket adds a *delivery column*, never a second copy of thresholds.
- `sidecar/src/config.ts:22 EnvSchema` — every optional var follows `z.string().min(1).optional().catch(orWarn(undefined, 'NAME'))` (see `LANGFUSE_PUBLIC_KEY`, config.ts:41). New env vars copy this pattern exactly (boot-crash-proof config is a RELEASE.md hardening guarantee).
- `sidecar/src/obs/langfuse.ts:134-137` — trace-end outcome scores: `run_success` (0 on failure), `citations_failed`, `facts_blocked`. The prep-side sentinel hook point (A3 prep leg, A4 adjacency).
- `sidecar/src/ingest/service.ts:197,221,225,279` — the ingestion failure transitions (`failed_storage`, `failed_validation`, `failed_extraction`). The A4 sentinel hook point.
- `sidecar/src/routes/chat.ts:273-280` — the SSE `done` event carrying `unverified_count` (and `prescriptive_flag_count`). The A3 chat-leg sentinel hook point.
- `sidecar/src/obs/langfuse.ts` guarded-emit philosophy (file header: "observability failure must NEVER fail a prep run") — the notifier inherits this rule verbatim.
- Standing rule 5 (tickets/README.md): every new client takes its transport as a constructor seam; zero live keys in CI (G17).

## Files to create/modify

- **First, a decision step, not a file** — see Step 1 (Langfuse-native vs sidecar-custom). The file list below is the custom-notifier fallback; if Langfuse-native alerting covers a rule, that rule's delivery is *configuration recorded in observability.md*, not code.
- `sidecar/src/obs/notifier.ts` — new. `AlertNotifier` interface + `WebhookAlertNotifier` (POSTs Slack-compatible `{ text: string }` JSON to a webhook URL via injected `fetch`), + `NoopNotifier`.
- `sidecar/src/config.ts` — add `ALERT_WEBHOOK_URL: z.string().url().optional().catch(orWarn(undefined, 'ALERT_WEBHOOK_URL'))`.
- `sidecar/src/server.ts` — `buildDeps` constructs the notifier (webhook when the URL is set, noop otherwise) and threads it to the three sentinel sites.
- `sidecar/src/obs/langfuse.ts`, `sidecar/src/ingest/service.ts`, `sidecar/src/routes/chat.ts` — accept an optional notifier and fire the sentinel notifications listed in Step 4.
- `docs/execution/observability.md` — new "Delivery" column/paragraph mapping each of A1–A6 to its mechanism (Langfuse-native, sidecar sentinel, or CI).
- `docs/internal/tickets/USER-ACTIONS.md` item 11 + `docs/internal/user-actions.html` — replace "name TBD by the J.1 spec" with the exact steps (both files together, per the USER-ACTIONS footer rule).
- `sidecar/test/notifier.test.ts` — new (see Tests).

## Step-by-step implementation

1. **Check Langfuse's built-in alerting FIRST** (the merged plan mandates this order). Read the current Langfuse docs (langfuse.com/docs — needs network; from the sandbox this may require USER-ACTIONS item 9 or a laptop check) for alert/webhook support on Cloud projects: score-based alerts, error-rate alerts, Slack/webhook channels. Record the finding in the PR body. Decision fork:
   - Langfuse-native alerting exists for a rule → configure it there (USER-ACTIONS item 11 click path; the windowed rules A1/A2/A5 are the natural fits — they need time-window aggregation the sidecar does not do), and record the configured threshold in observability.md's delivery note.
   - Not supported (or a rule's signal never reaches Langfuse) → that rule rides the sidecar notifier below.
2. **Add config.** `ALERT_WEBHOOK_URL` in `EnvSchema` following the `orWarn` pattern (invalid → warn + unset → notifier off; the process must never crash-loop on a bad URL).
3. **Build the notifier** (`sidecar/src/obs/notifier.ts`):

   ```ts
   export interface AlertNotifier {
       /** Fire-and-forget; implementations MUST swallow their own failures. */
       notify(alert: { rule: 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'A6'; summary: string; correlationId?: string }): Promise<void>;
   }
   export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;
   export class WebhookAlertNotifier implements AlertNotifier { constructor(private readonly url: string, private readonly fetchImpl: FetchLike, private readonly logger: { warn(obj: Record<string, unknown>, msg: string): void }) {} /* ... */ }
   export class NoopNotifier implements AlertNotifier { async notify(): Promise<void> {} }
   ```

   Payload is Slack-incoming-webhook-compatible `{ text }` (works for Slack and for most generic webhook receivers). A failed POST logs one structured warning and returns — never throws (mirror the langfuse.ts guard).
4. **Wire the sentinel legs** (the event-shaped halves of the table; the windowed halves stay Langfuse-side per Step 1):
   - **A3** — chat leg: where `unverified_count` rides the `done` event (chat.ts:273-280), `> 0` fires `notify({ rule: 'A3', summary: 'chat turn released with unverified citations withheld: <count>', correlationId: request.id })`. Prep leg: where `citations_failed` is scored (langfuse.ts:136), `> 0` fires A3.
   - **A4** — each `failed_*` transition in ingest/service.ts fires `notify({ rule: 'A4', summary: 'ingestion failed at <status>', correlationId })`. (The 20%-over-1h *rate* half of A4 stays a Langfuse/dashboard query; the sidecar sends the discrete events. Say exactly this in observability.md's delivery note — do not pretend the sidecar computes windowed rates.)
   - **A6** — fires in CI, not at runtime: the eval gate already fails the required check. Delivery note: "GitHub PR red check is the notification". Optionally add a curl step to `.github/workflows/evals.yml` posting to a `ALERT_WEBHOOK_URL` repo secret on failure — only if the user drops that secret (item 11); the workflow must stay green-path-identical when the secret is absent.
   - **A1/A2/A5** — Langfuse-native (Step 1) or, if unsupported, documented dashboard queries with a manual check cadence. Do NOT build a background aggregation loop in the sidecar for these (see What NOT to do).
5. **Thread the dependency.** `buildDeps` (server.ts:117): `const notifier = config.ALERT_WEBHOOK_URL !== undefined ? new WebhookAlertNotifier(config.ALERT_WEBHOOK_URL, fetch, logger) : new NoopNotifier();` — pass via conditional spread where the target dep type has it optional (exactOptionalPropertyTypes, standing rule 8).
6. **Docs.** observability.md delivery notes (one line per rule); USER-ACTIONS item 11 rewritten with the two concrete options (Langfuse UI path from Step 1's findings, or `ALERT_WEBHOOK_URL` Railway variable on the sidecar service — Slack: create an Incoming Webhook in the workspace, copy the URL). Update `docs/internal/user-actions.html` in the same commit.
7. Tests (below), then trackers, then ship ritual.

## What NOT to do

- Do NOT restate thresholds anywhere but observability.md (single-source decision, 2026-07-13). Code carries rule IDs and summaries, not threshold copies.
- Do NOT let a notify failure fail (or even slow) a request/prep — fire-and-forget with an internal catch; never `await` it on the hot path in a way that couples latency.
- Do NOT put PHI in alert payloads: rule id, counts, status names, correlation id ONLY (G18/P5 — the same discipline as logs; `eval/phi-log-sweep.eval.ts` mindset applies).
- Do NOT build a metrics-aggregation daemon in the sidecar for A1/A2/A5 — that is the "heavyweight observability platform" the merged plan's out-of-scope list forbids.
- Do NOT hard-require the webhook in CI or tests (G17) — keyless boot keeps the NoopNotifier.
- Do NOT touch `LLM_DAILY_BUDGET_USD` or gate behavior (standing rules 1/3).

## Acceptance checks

```bash
cd sidecar && npm test && npm run typecheck
# Local proof with a fake receiver (nc as a one-shot HTTP sink):
( printf 'HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n' | nc -l 8099 & ) && \
ALERT_WEBHOOK_URL=http://localhost:8099/hook npm run dev
# then trigger one failing ingestion (upload a .txt) → the nc terminal shows a
# POST with {"text":"[A4] ingestion failed at failed_validation ..."}
```

Keyless boot (no `ALERT_WEBHOOK_URL`) logs nothing new and `/ready` is unchanged. With the var set on Railway (item 11), one deliberately-bad upload produces one Slack message.

## Tests to add

- `sidecar/test/notifier.test.ts`:
  - `it('WebhookAlertNotifier posts a slack-compatible text payload')` — fake `FetchLike` captures url/body; body JSON has `text` containing the rule id + summary.
  - `it('notify never throws when the webhook errors or rejects')` — fetch impl throws → resolves; one `logger.warn` recorded.
  - `it('buildDeps wires NoopNotifier when ALERT_WEBHOOK_URL is unset')` — keyless config → notifier is a no-op (G17: no transport constructed).
- Extend the existing chat/ingest suites: one case each asserting the sentinel fires exactly once on `unverified_count > 0` / a `failed_extraction` transition, with an injected fake notifier (constructor seam, standing rule 5).

## Tracker updates

- `docs/internal/build-status.html` DATA block: ticket `J.1` (T1 section, line ~461) → `s: "done"`.
- `docs/w2/requirements.md` — no unchecked box exists for this follow-on ticket; do not invent one.
- `W2_ARCHITECTURE.md` §8 header ("Observability & cost"): append the delivery wiring to the SHIPPED list (mixed-marker style, mirroring the existing header edits).
- `docs/internal/tickets/USER-ACTIONS.md` item 11 + `docs/internal/user-actions.html` (same commit).

## Verify + ship ritual

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

Panel untouched — skip the panel leg. Then: conventional commit with
`--trailer "Assisted-by: Claude Code"` (trackers in the SAME commit) →
`git push -u origin claude/merged-eval-course-plan-ky6ulh` → update the
PR #16 body → SendUserFile `docs/internal/build-status.html`.
