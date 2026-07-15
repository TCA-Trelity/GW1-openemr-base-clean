# Findings schema

Every finding the `/ui-audit` skill reports — after the Stage 1 review and
Stage 2 adversarial verify passes — follows this shape:

```json
{
  "severity": "critical | high | medium | low",
  "category": "broken-interaction | visual-inconsistency | responsive | form-upload",
  "title": "short one-line summary",
  "description": "what's wrong, in plain language, as if describing it to the person who'll fix it",
  "screen": { "url": "...", "pageIndex": 1 },
  "viewport": ["mobile", "desktop"],
  "screenshot_paths": ["tmp/.../screens/p001-mobile-action003.png"],
  "console_excerpt": ["optional relevant console/network log lines"],
  "repro_steps": ["Navigate to X", "Click Y", "Observe Z"],
  "confidence": "high | medium | low",
  "verification_status": "confirmed | unconfirmed-not-verified | falsified"
}
```

## Severity rubric

- **critical** — the user cannot complete a core task at all (form can't
  submit, page crashes, primary action is unreachable).
- **high** — a control is broken or a layout is broken badly enough that a
  typical user would notice and be blocked or confused, but a workaround
  exists.
- **medium** — a real defect (inconsistent spacing, a truncated label, a
  console error on an otherwise-working action) that doesn't block the task
  but degrades the experience or signals a latent bug.
- **low** — cosmetic nit; worth listing, not worth blocking on.

## Category definitions

- **broken-interaction** — a control that doesn't do what it should: dead
  buttons/links, JS console errors on click, failed network calls, elements
  that never become clickable.
- **visual-inconsistency** — layout/visual defects: misaligned containers,
  overflow, clipped content, inconsistent spacing/padding between
  similar components, overlapping elements.
- **responsive** — a defect that only appears at certain viewport sizes:
  horizontal scroll on mobile, a control that becomes unreachable below a
  breakpoint, text/containers that don't reflow.
- **form-upload** — validation clarity and edge-case handling on forms and
  file inputs: unclear or missing error messages, an oversized/wrong-type
  file that's silently accepted, a required field that isn't enforced.

## Ordering

Findings are reported severity-ranked (critical → high → medium → low).
Within the same severity, group by `screen` so related findings on the same
page stay together. Deduplicate findings that recur across multiple
viewports/screens into a single entry with `viewport` listing every
viewport where it was observed, rather than repeating the same defect once
per breakpoint.

## What does *not* become a finding

- A heuristic flag from the driver's DOM-anomaly scan that the reviewing
  agent couldn't visually confirm as a real problem when it looked at the
  screenshot — heuristic flags are priors, not findings on their own.
- Anything the Stage 2 adversarial-verify pass falsified (a plausible
  innocent explanation exists — mid-load spinner, intentional empty state,
  browser-chrome cropping, etc.). Falsified candidates are dropped
  entirely, not downgraded to `low`.
- An intentionally skipped destructive action (`skipped-destructive` in the
  manifest) — that's a record of what wasn't tested, not a defect.
