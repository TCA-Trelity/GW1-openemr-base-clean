---
name: ui-audit
description: Vision-driven, interaction-oriented UI/UX testing agent — crawls a section of a web app like a human on a first visit, clicking buttons, trying uploads, resizing viewports, and using an actual vision review pass (not just heuristics) to find broken interactions, visual/layout inconsistencies, responsive breakpoint issues, and form/upload edge cases. Stack-agnostic: works against any web UI reachable at a URL, not tied to any one project's language or test framework. Trigger on phrases like "ui-audit", "audit the X module/page", "exploratory UI test", "click around and find UI bugs", "check for responsive/layout issues in X", or any request to do human-like exploratory UI testing.
---

# `/ui-audit`: vision-driven UI/UX testing

## Why this exists

Screenshots that get taken but not actually looked at are the recurring
failure mode this skill is built to avoid. The fix is architectural, not a
reminder: **mechanical browser interaction and vision judgment are two
separate phases**, run by different things.

1. A standalone Playwright driver (`driver/run.js`, ships with this skill,
   no dependency on the target app's stack) does the mechanical sweep:
   click everything, try uploads, resize the viewport, and write a manifest
   of screenshots + DOM heuristics + console/network events. It never
   decides what's a bug — it only produces *candidates*.
2. A `Workflow`-based vision-review stage spawns agents whose only job for
   that turn is to `Read()` batches of screenshots and judge them. A
   second, adversarial pass tries to *falsify* anything severe before it's
   reported. This is what makes "looking" reliable — it's the entire task
   for that agent call, not one step buried in a long session.

## Usage

```
/ui-audit <url-or-target> [--config=<path>] [--viewports=<list>] [--max-pages=<N>]
```

- `<url-or-target>` — a starting URL. Required unless `--config` supplies
  `baseUrl`.
- `--config=<path>` — optional adapter file for this specific target (auth,
  destructive-keyword additions, breakpoints, seed paths). Omit it entirely
  for a first, config-free run against any public or already-logged-in app.
- `--viewports=<list>` — e.g. `375x812:mobile,1920x1080:desktop`, overrides
  both the config and the built-in default matrix.
- `--max-pages=<N>` — overrides the default crawl breadth (default 8, hard
  cap 20).

## Step-by-step flow

### 1. Resolve the run

Pick an output directory for this run — a fresh, empty directory (e.g.
under the session's scratch/tmp space, or a gitignored path in the target
project if there isn't one). Don't reuse a previous run's directory; the
manifest is append-only and a stale one will mix runs together.

### 2. First-run setup

```bash
cd <this-skill-dir>/driver
[ -d node_modules ] || npm install
```

Playwright will use a pre-installed Chromium if the environment provides
one (`PLAYWRIGHT_BROWSERS_PATH`); otherwise `npm install` pulls its own.

### 3. Run the driver

```bash
node <this-skill-dir>/driver/run.js \
  --url="<target>" \
  [--config="<config-path>"] \
  [--viewports="<list>"] \
  [--max-pages=<N>] \
  --out-dir="<run-dir>"
```

The driver prints `run-summary.json` to stdout on completion and writes
`manifest.jsonl` + `screens/*.png` under `--out-dir`. It never throws on a
timeout or bound hit — it truncates gracefully and records why.

**Before doing anything else, read `run-summary.json` and surface to the
user, up front:**
- `truncated` / `truncatedReason` — if the crawl hit a bound, say so; don't
  present partial coverage as complete.
- The `auth` entry at the top of `manifest.jsonl` — if `loginError` is set,
  the whole crawl may have only ever seen a login wall. Stop and report
  this rather than silently reviewing screenshots of a login page.
- `pagesVisited` vs `pagesQueued` — gives a sense of how much of the target
  was actually covered this run.

### 4. Prepare vision-review batches

Read `manifest.jsonl` (JSONL — one JSON object per line). Keep only entries
with a `screenshotPath` (types `screen`, `interaction`, `form-empty-submit`,
`file-upload`). Group them into batches of ~8-10 entries each. Each batch
entry should carry: `url`, `viewport`, `type`/action context,
`heuristicFlags` (if present), `consoleDelta` (if present), and
`screenshotPath`.

### 5. Run the vision review via `Workflow`

Call the `Workflow` tool with a script following this shape — fill in the
Stage 1 / Stage 2 prompt text from `references/vision-review-prompts.md`
(embed the batch's entries as JSON inside the Stage 1 prompt; embed the
candidate finding as JSON inside the Stage 2 prompt), and pass the batches
built in step 4 as `args`:

```js
export const meta = {
  name: 'ui-audit-vision-review',
  description: 'Batch vision review of ui-audit screenshots with adversarial verification',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}

const STAGE1_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          category: { type: 'string', enum: ['broken-interaction', 'visual-inconsistency', 'responsive', 'form-upload'] },
          title: { type: 'string' },
          description: { type: 'string' },
          screenshot_paths: { type: 'array', items: { type: 'string' } },
          url: { type: 'string' },
          viewport: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['severity', 'category', 'title', 'description', 'screenshot_paths'],
      },
    },
  },
  required: ['findings'],
}

const STAGE2_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['CONFIRMED', 'FALSIFIED'] },
    justification: { type: 'string' },
  },
  required: ['verdict', 'justification'],
}

const results = await pipeline(
  args.batches,
  (batch) => agent(
    `<Stage 1 prompt from references/vision-review-prompts.md, with batch.entries embedded as JSON>`,
    { label: `review:${batch.batchId}`, phase: 'Review', schema: STAGE1_SCHEMA }
  ),
  (review) => {
    const findings = review?.findings || []
    const toVerify = findings.filter((f) => f.severity !== 'low')
    const autoIncluded = findings.filter((f) => f.severity === 'low')
    return parallel(toVerify.map((f) => () =>
      agent(
        `<Stage 2 prompt from references/vision-review-prompts.md, with f embedded as JSON>`,
        { label: `verify:${f.title}`, phase: 'Verify', schema: STAGE2_SCHEMA }
      ).then((v) => ({ finding: f, verdict: v }))
    )).then((verified) => ({
      confirmed: verified.filter(Boolean).filter((v) => v.verdict?.verdict === 'CONFIRMED').map((v) => v.finding),
      autoIncluded,
    }))
  }
)

const confirmed = results.filter(Boolean).flatMap((r) => [...r.confirmed, ...r.autoIncluded])
return { confirmed }
```

Only `low`-severity findings skip adversarial verification (cheap, low
stakes); everything `medium` and above is actively falsification-tested
before it's allowed into the final report.

### 6. Report findings

Present the `confirmed` findings from the workflow, severity-ranked
(critical → high → medium → low), using the shape in
`references/findings-schema.md`. For each finding, surface its screenshot
alongside the description — don't just link the path, actually show it (via
whatever the environment supports for inline images) so the user doesn't
have to go dig it up.

Also report, briefly, as context rather than findings:
- Count of `skipped-destructive` actions (what was intentionally not
  clicked, and why).
- Any `link-health` entries with a non-2xx status or error.
- The truncation status from step 3, restated here so it's the last thing
  the user reads before the findings, not just the first.

## Config file (optional)

```json
{
  "baseUrl": "https://example.com",
  "auth": {
    "storageStatePath": "./storage-state.json",
    "loginUrl": "https://example.com/login",
    "usernameSelector": "#username",
    "passwordSelector": "#password",
    "submitSelector": "button[type=submit]",
    "credentialsEnv": { "username": "UI_AUDIT_USER", "password": "UI_AUDIT_PASS" }
  },
  "destructiveKeywords": ["archive"],
  "breakpoints": [{ "label": "mobile", "width": 375, "height": 812 }],
  "seedPaths": ["/dashboard", "/settings"],
  "navSelector": "nav a",
  "maxPages": 10,
  "submitValidUploads": false,
  "uploadFixtureOverrides": { "valid": "/path/to/fixture.pdf" }
}
```

Every field is optional. `auth.storageStatePath` (a Playwright storage
state file — cookies + localStorage from an already-logged-in session) is
the preferred auth method when available; it's more robust than replicating
a login form. Without any `auth` block, the driver crawls whatever's
reachable unauthenticated. `submitValidUploads` defaults to `false` — the
driver attaches a valid file and captures the pre-submit UI state without
actually persisting it, unless explicitly enabled; oversized/wrong-type
fixtures are always submitted since they're expected to be rejected and a
lack of rejection is itself the finding.

## Known limitations (v1)

- Generic login-form detection may not find unusual custom auth flows —
  use an explicit `auth` config block for anything nonstandard.
- The destructive-keyword filter will occasionally skip a benign control
  (e.g. "Remove Filter") — it fails toward safety by design;
  `destructiveKeywords` in config extends the list per target.
- Same-origin link discovery only follows plain `<a href>` — SPA navigation
  driven entirely by JS click handlers with no real links needs
  `seedPaths` in config to reach.
- No automated cleanup of any data a flow persists (only happens when
  `submitValidUploads` is enabled) — that's on the caller to manage per
  target.
