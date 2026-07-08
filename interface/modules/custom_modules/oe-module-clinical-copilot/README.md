# Clinical Co-Pilot chart embed (oe-module-clinical-copilot)

Adds a **Clinical Co-Pilot** card to the top of the patient demographics
dashboard. When the chart patient matches a co-pilot patient (exact
first + last name match against the sidecar's `/api/patients` registry), the
card offers **Open Co-Pilot** (new tab) and **Embed here** (in-chart iframe of
the panel: pre-visit brief, sources, imaging trends, record chat). With no
match it links to the co-pilot day view; if the sidecar is unreachable it
degrades to a muted notice. The module is read-only glue — no tables, no
writes, no PHI leaves the EHR (only the chart patient's name is compared,
server-side).

## Enable

1. Admin → Modules → Manage Modules → *Unregistered* tab → Register
   **Clinical Co-Pilot**, then Install and Enable it.
2. Open any patient chart → the card appears above the demographics sections.

## Demo binding

The demo corpus patients are `Margaret L. Chen` and `William R. Thompson`.
Create (or rename) OpenEMR patients whose first/last names are
`Margaret Chen` and `William Thompson` — middle names are ignored by the
matcher — and their charts bind to the co-pilot records.

## Configuration

`COPILOT_SIDECAR_URL` environment variable on the OpenEMR service overrides
the sidecar base URL (defaults to the demo deployment).
