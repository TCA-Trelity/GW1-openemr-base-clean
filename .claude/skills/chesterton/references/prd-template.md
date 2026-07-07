# PRD template (Phase 4 output)

One document, everything embedded. Sections 1–4 are context the executor (human or prd-optimizer) needs to not break things; sections 5–7 are the work itself. Section 5's structure — discrete units with files, dependencies, and complexity — is what prd-optimizer's intake phase parses to build its session plan, so keep units genuinely discrete and file lists concrete.

```markdown
# PRD: <Short name>

## 1. Summary
What we're changing and why, in one paragraph. State the user's original goal if there was one.

## 2. Codebase map
- **Stack**: languages, frameworks, key libraries, versions that matter
- **Boundaries**: modules/services and their responsibilities (one line each)
- **Data flow**: how the 1–2 traced flows actually move through the system
- **Build/test/run**: exact commands
- **External integrations**: APIs, queues, databases, vendors
- **Conventions worth preserving**: patterns the codebase uses consistently
  (write these as terse imperative rules — prd-optimizer lifts them into CLAUDE.md)

## 3. Fence register
| # | Fence (path:line) | Hypothesized reason | Evidence | Confidence | Status |
|---|---|---|---|---|---|
Status ∈ Explained / Load-bearing / Unknown. Every unit in §5 that touches a
fence references its number. Unknown fences touched by any unit get a row in §6.

## 4. Tradeoff analysis
For each candidate considered (including rejected ones):
**Candidate — verdict (in scope / rejected / deferred)**
Cost / performance impact / risk (note fence exposure) / vision alignment.
One short paragraph each. Rejections with reasons are part of the deliverable.

## 5. Implementation units
### Unit N: <name>
- **What**: direct description of the change
- **Files**: concrete paths expected to be created/modified
- **Depends on**: unit numbers, or "none"
- **Fences touched**: register numbers + how the unit respects them
- **Complexity**: light / medium / heavy
- **Acceptance criteria**: verifiable statements ("test X passes", "p95 < 200ms")

## 6. Risks & mitigations
Every Unknown fence being touched → its mitigation (flag, canary, revert plan,
or a spike unit that resolves it to Explained first). Plus ordinary project risks.

## 7. Open questions
Anything unresolved at checkpoints, or questions that couldn't be asked
(non-interactive run). Assumptions made in their place, clearly labeled.

## Appendix: Evidence log
Commit hashes, issue/PR links, ADR paths backing the fence register — so a
future reader can re-verify without redoing the archaeology.
```

Length guidance: the PRD should be as long as the evidence demands and no longer — typically 2–6 pages. The fence register and unit list are the load-bearing sections; don't pad the prose around them.
