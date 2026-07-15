# Vision-review prompt templates

Used by `SKILL.md` when constructing the `Workflow` script's `agent()`
calls. The point of splitting review into small batches is that *looking at
the screenshot* is the entire job for that agent call — not one step in a
longer browsing session. Keep these prompts focused on that.

## Stage 1 — fan-out batch review

One agent per batch of ~8-10 manifest entries. Each agent must actually
`Read()` every screenshot in its batch — do not let it skim only the
heuristic flags and skip the image.

```
You are reviewing a batch of screenshots captured during an automated UI
crawl, looking for real UI/UX defects — the kind a careful human tester
would notice on a first pass through this part of the app.

For each of the following manifest entries, Read() the screenshot at its
screenshot_path and look at it directly. Do not rely only on the metadata
below — the heuristic flags are automated *guesses*, not confirmed
problems, and most of what you're looking for (visual inconsistency,
layout gaps, unclear validation messages) can only be judged by actually
looking at the image.

Batch entries (JSON, one per screenshot):
<paste the batch's manifest entries here, each including: url, viewport,
action/context description, heuristic_flags, console_log_delta>

For each screenshot, ask:
- Does anything look visually broken — misaligned, overlapping, clipped,
  overflowing, inconsistent spacing/sizing compared to similar elements
  elsewhere in this app?
- If this was captured after a click/upload/submit action: did the app
  respond sensibly? Is there a broken/dead interaction, an unclear error
  state, or a console/network error that corresponds to something visible?
- At this viewport specifically: any responsive-layout breakage (horizontal
  scroll, unreachable controls, content that doesn't fit)?
- Treat each heuristic_flags entry as a hint to look at, not a verdict —
  confirm or reject it by what you actually see.

Only report something as a candidate finding if you can point to what's
visibly wrong in the image. Emit draft findings using the schema in
references/findings-schema.md, with a `confidence` reflecting how sure you
are from the image alone. It's fine — expected — to review a batch and find
nothing wrong in some or all of it.
```

## Stage 2 — adversarial falsification

One agent per candidate finding at High/Critical severity (or all
candidates, for small runs). The framing matters: this is not "look again
and agree," it's "try to prove this wrong."

```
A previous reviewer flagged the following as a UI defect. Your job is to
try to FALSIFY this claim, not confirm it. Actively look for an innocent
explanation before accepting it as real.

Claimed finding:
<paste the Stage 1 candidate finding JSON>

Screenshot(s): Read() each screenshot_path yourself — do not take the
claim's description at face value.

Actively consider these alternative explanations before accepting the
finding:
- Is this a mid-load/transition state (spinner, skeleton screen,
  animation-in-progress) rather than a final broken state?
- Is this an intentional empty/zero-state, not a bug (e.g. "no results"
  screens legitimately look sparse)?
- Could this be a browser-chrome or screenshot-cropping artifact rather
  than an actual page defect?
- Is the heuristic flag that prompted this a false positive (e.g. a
  zero-size element that's a hidden-until-hover control, not broken)?
- Is there a plausible design reason for what looks like an inconsistency
  (e.g. a deliberately different treatment for a different content type)?

Respond with a verdict: CONFIRMED (the defect is real and visible in the
screenshot, no innocent explanation holds up) or FALSIFIED (an innocent
explanation is more likely, or you cannot see clear evidence of a defect
in the image). Briefly justify your verdict — 1-3 sentences is enough. Err
toward FALSIFIED when genuinely uncertain; a missed real bug is cheaper
than a false alarm in the final report.
```

## Aggregation (no agent call — plain synthesis in the orchestrating agent)

- Drop everything Stage 2 marked FALSIFIED.
- Dedupe candidates describing the same underlying defect seen across
  multiple viewports/screens into one finding with a combined `viewport`
  list.
- Sort by severity (critical → high → medium → low), then by screen.
