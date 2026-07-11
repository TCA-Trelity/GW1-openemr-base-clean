# Final Demo Video Script (3–5 min) — conversation-led

*For the Sunday final submission (M8; supersedes the Tuesday MVP script, which
this file carried until Wave M). The rubric's core-interface requirement is a
**multi-turn AI agent that receives follow-ups, maintains context, and invokes
tools** — so the demo IS a conversation, start to finish, on one patient's
real clinical story. The brief appears as what the agent already prepared, not
as the product. Record screen + voiceover against the live Railway deployment.
Times are targets. One take of the chat thread is fine — every reply is
grounded in the seeded corpus, and every demo is a test run.*

---

### 0:00–0:25 — Cold open: the conversation, already waiting
- On screen: the live panel opens on **William R. Thompson** (wet-AMD,
  7 OCTs, 4 injections). At desktop width the **chat pane is already open**
  beside the record.
- Say: "This is a clinical co-pilot inside OpenEMR, and its core interface is
  this conversation. Everything on the left — the brief, the scans, the risk
  flags — is what the agent already did in the 5-to-20 minutes this patient
  spent in the waiting room. That's its opening move. The right side is where
  the physician talks to it."

### 0:25–1:25 — The imaging drill-down thread (multi-turn + tools, UC-8)
- On screen: Imaging tab — the full-viewport OCT workspace. Click
  **"Ask about this scan"** on the selected scan → the ask lands in the chat
  input, prefilled → send.
- Watch and narrate the stream: the **opening move** lands first (a fresh
  conversation opens with the agent's prepared digest — "I read the record
  during check-in…"), then **tool chips appear live** —
  `get_measurement_trend`, then `compare_scans` — then the cited answer.
- Say, over the opening move: "Notice the first message is the agent's, not
  mine — the transcript literally opens with what it prepared. There is no
  separate report; the brief is turn zero of this conversation."
- Say: "Measurement trends don't live in any document I attached — the agent
  has six read-only, patient-scoped tools, and you can watch it use them. It
  pulled the CRT series across all seven scans, compared the two scans around
  the 71-day gap, and the numbers it quotes are the same deterministic engine
  output as the analytics rail — the model never does the math."
- Type the follow-up: **"What were the prior cycles holding at?"** — say:
  "Second turn, same conversation — 'prior cycles' only means something
  because the thread carries its context. This conversation is persisted
  server-side; reload the page and it's still here."

### 1:25–1:55 — The guardrail moment (thought partner, UC-9)
- Type: **"So should I just shorten his interval?"**
- Say, over the reply: "This is the question every clinical chatbot fails.
  Ours never prescribes: it gives what the record shows — cited — what the
  interval engine derives — attributed — and the question worth weighing. The
  decision stays with the physician. That's a prompt contract, a
  deterministic prescriptiveness lint that runs on every reply and is counted
  like a citation failure, and a published eval."

### 1:55–2:20 — Cross-patient denial, mid-conversation
- Type: **"What about Margaret Chen — what were her injection intervals?"**
- Say: "Four turns in, the agent still can't cross patients — and that's
  structural, not politeness. Its tools only see this patient's bundle, the
  SMART token is bound to this patient, and a quote from anyone else's record
  can never verify as a citation. The refusal at turn four is eval-locked,
  not hoped for."

### 2:20–2:50 — The trust chain, end to end
- On screen: click a **citation chip** on any reply → the source viewer opens
  with the exact span highlighted.
- Say: "Every claim traces to a verbatim span in a stored document, re-checked
  server-side after the model cites it — spans that fail verification are
  counted and surfaced, never rendered as provenance. The brief on the left
  runs through the same deterministic citation gate. The rule for the whole
  system: it may be unavailable; it may never be silently wrong."

### 2:50–3:35 — The proof, not the promise
- On screen: `docs/execution/eval-results.md` — scroll the table.
- Say: "Eighteen evals, committed with the commit hash: citation validity,
  the clinical-calculator goldens against published AAO guidelines, planted
  contradictions, cross-patient denial, injection resistance — and as of this
  wave, the **conversation loop itself**: history threading, verbatim
  tool-result plumbing, the round cap, tool-error recovery, and the
  prescriptiveness contract."
- On screen: the Bruno `04-chat` folder (one glance): "Graders can run this
  exact multi-turn workflow — follow-up, tool chain, replay — without reading
  a line of source."
- On screen: the observability trail — the prep run's Langfuse trace (stages,
  generations, gate scores), then `GET /api/usage` beside the Railway logs
  filtered to one chat turn's correlation ID.
- Say: "And everything you watched is reconstructable from logs alone: the
  prep run is a Langfuse trace with a span per stage and gate verdicts as
  scores, and every chat turn carries one correlation ID through the token
  ledger, the tool calls, and the verification results."

### 3:35–4:00 — Close
- On screen: the deployed URL; the role picker (physician / nurse / resident)
  for one beat.
- Say: "Deployed on the same public URL since Tuesday. Patient-bound tokens,
  role-gated capabilities, a five-dollar-a-day spend guard, and a pre-visit
  brief the agent prepares while the patient waits — so the physician's 90
  seconds go to the conversation, not the chart. Built on an untouched
  OpenEMR: everything you saw is an additive, removable layer that cites into
  the record."
- End card: deployed URL + "every demo is a test run."

### Checklist before recording
- [ ] Live URL loads; dev-login lands on William with the chat pane open
      (≥1536 px window).
- [ ] A fresh conversation (clear sessionStorage) so the thread builds
      on-camera.
- [ ] Imaging tab shows the 7-scan OD series; "Ask about this scan" visible.
- [ ] The four asks rehearsed: scan-ask (seeded) → "What were the prior
      cycles holding at?" → "So should I just shorten his interval?" →
      "What about Margaret Chen — what were her injection intervals?"
- [ ] Citation chip → source viewer deep link works on the live stack.
- [ ] `eval-results.md` at 18/18 on the submitted commit; Bruno folder and
      Langfuse trace tabs pre-opened.
- [ ] Spend guard headroom checked (four Haiku turns ≪ $5/day budget).
- [ ] Total runtime 3–5 min.
