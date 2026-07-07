# MVP Demo Video Script (3–5 min)

*For the Tuesday MVP submission. The MVP is the foundation, not a working
agent (per the project brief) — so the video demonstrates the deployed fork,
the audit, the user definition, and the AI integration plan, not a live
agent. Record screen + voiceover. Times are targets.*

---

### 0:00–0:30 — The problem, in the user's numbers
- On screen: title card → the four stat tiles (70 patients/day · 90 seconds
  between rooms · 5–20 min waiting gap · ×70 multiplier).
- Say: "Dan is a retina surgeon who founded the EHR that leads his
  own specialty — and he wants it replaced. He has about 90 seconds between
  rooms, and today's chart is, in his words, 20 pages where one page would
  have done, 90% not relevant. Our thesis: the data is already there — it's
  buried in clutter."

### 0:30–1:30 — The deployed OpenEMR fork (hard gate)
- On screen: browse to the live Railway URL → OpenEMR login → sign in →
  patient list → open a patient summary.
- Say: "Here's our fork of OpenEMR, deployed and publicly reachable. This is
  the real, large healthcare codebase we're integrating into — not a scratch
  build. Notice the patient summary: billing cards, compliance widgets, and
  configurable forms all sharing the screen at equal weight. We verified in
  the code why it's this dense — and it's load-bearing, so we don't touch how
  the data is stored. We add a triaged layer above it."
- (Show the density honestly; this *is* the status quo we're improving.)

### 1:30–2:45 — What the audit found (hard gate)
- On screen: `AUDIT.md` — scroll the summary, then the S1 finding with the
  `return true;` stub on screen.
- Say: "Before designing anything, we audited the system across security,
  performance, architecture, data quality, and compliance. The headline
  finding: OpenEMR enforces role permissions correctly, but its per-patient
  access check is unimplemented — this function returns 'allow'
  unconditionally. Any clinician can read any patient. We don't fix this in
  core; it shapes our design — we construct the patient-level access control
  we can't inherit."
- Briefly show: the no-async-queue finding, and the 14-demographics-only
  sample data finding. "Each of these changed the plan."

### 2:45–4:00 — Who it's for, and the AI integration plan
- On screen: `USERS.md` (the seven use cases, briefly) → the architecture
  diagram (`docs/defense/architecture-diagram.svg`).
- Say: "We picked one real user and one real workflow, not 'physicians need
  help finding information.' Seven use cases — the 90-second brief, iterative
  verification, contradiction surfacing, auto-computed drug-toxicity risk,
  treat-and-extend guidance, imaging in context, and patient-goal-aware care —
  each answering why a conversational agent is the right shape."
- On the diagram: "The plan: a sidecar service beside the untouched EHR,
  talking to it only through FHIR and SMART-on-FHIR. The core move — move the
  thinking to where time is free. Patients wait 5 to 20 minutes after
  check-in; we do all the expensive work in that gap, so when the doctor opens
  the chart, the brief is already prepared. Completeness at preparation time,
  speed at read time."

### 4:00–4:45 — Trust and the tiered plan
- On screen: `ARCHITECTURE.md` verification section → the citation-gate
  pipeline line.
- Say: "Every claim carries its source. A deterministic citation gate — code,
  not a model — sits between the model and the screen; an unsourced claim is
  blocked by construction. Domain rules are arithmetic the doctor can check by
  hand. And the whole thing is tiered: tonight's foundation, a working agent
  by Thursday, production hardening by Sunday."
- End card: the deployed URL + "every demo is a test run."

### Checklist before recording
- [ ] Live URL loads and login works.
- [ ] `AUDIT.md`, `USERS.md`, `ARCHITECTURE.md` visible at repo root.
- [ ] The `return true;` stub is on screen for the S1 beat.
- [ ] Architecture diagram renders.
- [ ] Total runtime 3–5 min.
