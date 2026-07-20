# Week 3 — AgentForge (Adversarial AI Security Platform)

Week 3 builds **AgentForge**, a multi-agent adversarial security platform that continuously
red-teams the AI-assisted Clinical Co-Pilot (the `sidecar/` target from Weeks 1–2) to find and fix
vulnerabilities before an attacker does. It is authorized, defensive security engineering.

## Where the code lives

AgentForge is a **greenfield, standalone project in its own repository** (it targets this repo's
deployed Co-Pilot as a black box; it does not modify the Co-Pilot source):

- **Repo:** [`TCA-Trelity/openemr-WH-RT`](https://github.com/TCA-Trelity/openemr-WH-RT) (WH-RT =
  White Hat / Red Team)
- **PR:** [openemr-WH-RT#1](https://github.com/TCA-Trelity/openemr-WH-RT/pull/1)

The canonical Week-3 deliverables (`PRD.md`, `THREAT_MODEL.md`, `USERS.md`, `ARCHITECTURE.md`, the
APT tradecraft digest, versioned `contracts/`, the exploit store, observability, the target adapter,
and the Operator Console) all live in that repo.

## What's in this folder

Planning artifacts produced during Week-3 planning in this primary repo:

- `architecture-slides-101.md` — content for the 5-minute, 101-level architecture defense slides
  (non-technical audience).
