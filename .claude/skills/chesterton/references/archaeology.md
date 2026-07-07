# Archaeology: reconstructing why code is the way it is

Techniques for Phase 2 (Interpret/Empathize). The goal is never "who wrote this" — it's "what did they know that I don't."

## Git history and blame

The strongest signal. For each candidate fence:

```bash
# Who touched these lines and in what commit
git log -L <start>,<end>:<file> --oneline          # line-range history (best)
git blame -w -C -C <file>                          # -w ignores whitespace, -C -C follows copies/moves

# Read the full story of a suspicious commit
git show <hash> --stat                             # what else changed with it — context clusters
git log --oneline --follow <file>                  # file's whole life, across renames

# Churn hotspots — files changed most often are where pain lives
git log --format= --name-only | sort | uniq -c | sort -rn | head -20

# What was happening around a date ("why does everything reference retries in 2019?")
git log --since=2019-06-01 --until=2019-09-01 --oneline
```

Read commit messages as testimony. "fix", "hotfix", "revert", "workaround", "temp", "DO NOT", ticket numbers, and expletives all mark fence posts. A commit titled "fix prod incident" that adds the weird code you're staring at is a confession — go find the incident.

Merge commits and PR references (`Merge pull request #123`) point at discussion threads. If `gh` CLI or a fetch tool is available and the remote is reachable, pull the PR/issue conversation — review comments often contain the reason verbatim.

## Comments and TODO strata

- `git log -S "TODO"` style searches (`git log -S "<distinctive string>"`) find when a comment or hack was introduced.
- Date the TODOs/FIXMEs/HACKs via blame. A five-year-old "TODO: remove after migration" whose migration completed is a fence whose reason expired — cheap win. A five-year-old TODO nobody removed despite heavy churn nearby may be load-bearing wisdom.
- Comments that explain *what* are noise; comments that explain *why not* ("don't use X here because…") are gold — treat them as evidence directly.

## Tests as intent

Tests are the written record of what someone deliberately protected.

- A test pinning oddly specific behavior (magic numbers, weird ordering, exact error strings) means that behavior was once violated at cost. Blame the test to find the incident.
- Test names and docstrings ("test_handles_duplicate_webhooks") describe failure modes the team met in production.
- *Absence* is evidence too: a scary module with no tests suggests either it never breaks (stable fence) or nobody dares touch it (Unknown fence — raise its risk weight).
- Skipped/xfail tests with comments are frozen arguments — read them.

## Issues, PRs, and external context

When a remote is linked and reachable:

- Search issues for the file/function/error-string names: `gh issue list --search "<term>" --state all`, `gh pr list --search "<term>" --state all`.
- Closed-wontfix issues explain declined fences ("we won't remove X because customer Y").
- CHANGELOG, docs/adr/, RFC folders, and wiki links in README rank above inference — an ADR is a fence with the reason nailed to it.

## Weighing evidence into confidence

- **High**: explicit written reason (ADR, commit message stating the why, comment, issue) AND you can assess whether the reason still applies.
- **Medium**: strong circumstantial pattern (test pins it + commit timing correlates with a known event) but the why is inferred, not stated.
- **Low**: plausible story, no artifacts. Say "I suspect", not "this is".
- **Unknown**: archaeology exhausted, nothing found. This is a finding, not a failure — Unknown fences are exactly what the evidence gate protects.

Remember the empathetic prior: assume the original author was competent and rushed, not incompetent and leisurely. Given a choice between "they didn't know better" and "they knew something I don't", investigate the second first — it's more often true and more expensive to be wrong about.
