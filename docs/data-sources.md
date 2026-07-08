# Data sources and attribution

## OCT imagery (synthetic stand-ins)

The scan imagery referenced by `sidecar/seed/images/manifest.json` is to be
sourced from the public **Kermany et al. OCT dataset**, licensed **CC BY 4.0**:

> Kermany, D., Goldbaum, M., Cai, W. et al. "Identifying Medical Diagnoses and
> Treatable Diseases by Image-Based Deep Learning." *Cell* 172(5), 1122–1131.e9
> (2018). https://doi.org/10.1016/j.cell.2018.02.010

Dataset distribution: Kermany, D., Zhang, K., Goldbaum, M. "Labeled Optical
Coherence Tomography (OCT) and Chest X-Ray Images for Classification."
*Mendeley Data*, v2 (2018). https://doi.org/10.17632/rscbjbr9sj.2
License: Creative Commons Attribution 4.0 (CC BY 4.0).

Class mapping (per `docs/execution/DECISIONS.md`): William Thompson's
fluid/worsened visits use `CNV`-class scans and his dry post-treatment visits
use `NORMAL`-class scans; all of Margaret Chen's scans are `NORMAL`-class —
early hydroxychloroquine toxicity is not visible on a single B-scan, so her
trend is carried entirely by the authored `ai_analysis` metadata.

**Scope and disclaimer:** these images are used solely as synthetic stand-ins
for demo and evaluation of the Clinical Co-Pilot. They do not depict the
synthetic patients, no diagnostic or clinical claims are made from the pixels,
and the deterministic analytics consume only the authored seed metadata. A
sourcing script downloads the files and records their exact dataset paths at
fetch time.

## Everything else

All patient records, documents, contradictions, measurements, and narratives in
`sidecar/seed/` are entirely synthetic, converted from the private
`second-opinion` prototype's authored demo data. No real patient data is used
anywhere in this repository.
