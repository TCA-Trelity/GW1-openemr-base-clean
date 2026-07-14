#!/bin/sh
# SessionStart hook — Week 2 dashboard ritual (structural requirement, user-mandated 2026-07-13).
# Injects a standing instruction so every session opens by sending the tracking
# dashboards to the user. See CLAUDE.md "Week 2 session-start ritual".

DASH="docs/internal/build-status.html"
OPS="docs/execution/ops-status.html"
ACTIONS="docs/internal/user-actions.html"

# Only fire when the dashboards exist (protects pre-W2 branches / partial checkouts).
if [ ! -f "$DASH" ]; then
  exit 0
fi

FILES="\\\"$DASH\\\""
if [ -f "$OPS" ]; then
  FILES="$FILES, \\\"$OPS\\\""
fi
if [ -f "$ACTIONS" ]; then
  FILES="$FILES, \\\"$ACTIONS\\\""
fi

cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "STRUCTURAL REQUIREMENT (user-mandated): At the start of this session, BEFORE any build work, send the project tracking dashboards AND the user-actions form to the user rendered inline: call SendUserFile with files [$FILES] and display \"render\", so they stay open in front of the user for the whole session. If SendUserFile is unavailable on this surface, tell the user the dashboard paths instead. Standing rule while building: docs/internal/build-status.html's DATA block (ticket statuses, acceptance counts, measured numbers) is updated in the SAME PR as the code it describes — see CLAUDE.md 'Week 2 session-start ritual' and docs/w2/requirements.md."
  }
}
EOF
