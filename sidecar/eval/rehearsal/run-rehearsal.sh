#!/bin/sh
# D.7 (REQ S4/R6, D5): hard-gate rehearsal — prove the eval gate CATCHES an injected
# regression, one per rubric tier, before a grader injects their own.
#
#   A  a-citation-drop.patch      facts persist WITHOUT citations   → citation_present (safety, per-case)
#   B  b-schema-retry-skip.patch  feedback retry deleted            → schema_valid (quality, threshold/-5%)
#   C  c-phi-log-leak.patch       extraction payload logged         → no_phi_in_logs (safety, per-case)
#
# For each leg: apply the patch, run `npm run eval` (MUST exit non-zero and flag the
# expected category), reverse the patch. The script fails if any leg's regression
# slips through — i.e. the rehearsal itself is CI-runnable evidence (D5).
# Run from anywhere: paths resolve via git. Requires a clean sidecar/src tree.
set -u

REPO_ROOT=$(git rev-parse --show-toplevel) || exit 1
REHEARSAL_DIR="$REPO_ROOT/sidecar/eval/rehearsal"
cd "$REPO_ROOT/sidecar" || exit 1

if ! git -C "$REPO_ROOT" diff --quiet -- sidecar/src; then
    echo "rehearsal: sidecar/src has uncommitted changes — commit or stash first" >&2
    exit 1
fi

FAILED=0

run_leg() {
    LEG="$1"
    PATCH="$2"
    CATEGORY="$3"
    echo ""
    echo "=== rehearsal leg $LEG: inject $(basename "$PATCH") — expect the gate to flag $CATEGORY ==="
    git -C "$REPO_ROOT" apply "$PATCH" || { echo "rehearsal: failed to apply $PATCH" >&2; exit 1; }
    OUTPUT=$(npm run eval 2>&1)
    STATUS=$?
    # Always reverse, even if the eval run crashed.
    git -C "$REPO_ROOT" apply -R "$PATCH" || { echo "rehearsal: FAILED TO REVERSE $PATCH — tree is dirty" >&2; exit 1; }
    echo "$OUTPUT" | grep -E "category gate|${CATEGORY}|GATE" | tail -12
    if [ $STATUS -eq 0 ]; then
        echo "rehearsal leg $LEG: !! REGRESSION SLIPPED THROUGH (eval exited 0) !!"
        FAILED=1
    elif echo "$OUTPUT" | grep -q "${CATEGORY}: FAIL"; then
        echo "rehearsal leg $LEG: OK — gate failed and flagged ${CATEGORY}"
    else
        echo "rehearsal leg $LEG: !! eval failed but ${CATEGORY} was not the flagged category !!"
        FAILED=1
    fi
}

run_leg A "$REHEARSAL_DIR/a-citation-drop.patch" "citation_present"
run_leg B "$REHEARSAL_DIR/b-schema-retry-skip.patch" "schema_valid"
run_leg C "$REHEARSAL_DIR/c-phi-log-leak.patch" "no_phi_in_logs"

echo ""
if [ $FAILED -ne 0 ]; then
    echo "=== rehearsal FAILED: at least one injected regression slipped through ===" >&2
    echo "rehearsal: docs/execution/eval-results.md left in place — it shows the failing run (diagnostic evidence)" >&2
    exit 1
fi

# All legs passed. Each leg's `npm run eval` rewrote docs/execution/eval-results.md
# (eval/run.ts ALWAYS regenerates it), so the tree still holds leg C's deliberate
# no_phi_in_logs failure — a fake alarm now that every injected fault is reversed.
# Restore the committed deliverable; failure evidence is kept only for failed runs.
if ! git -C "$REPO_ROOT" restore -- docs/execution/eval-results.md; then
    echo "rehearsal: PASSED, but restoring docs/execution/eval-results.md failed — it still shows leg C's injected failure; run 'git restore docs/execution/eval-results.md' manually" >&2
    exit 1
fi
echo "rehearsal: docs/execution/eval-results.md restored to its committed state (leg runs regenerate it; a passing rehearsal leaves no fake failure report behind)"
echo "=== rehearsal PASSED: all three injected regressions were caught by the gate ==="
exit 0
