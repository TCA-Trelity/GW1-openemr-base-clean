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

### Sourced files (S2.13)

The demo OCT B-scans have now been sourced and are committed under
`sidecar/seed/images/`, catalogued in
`sidecar/seed/images/manifest.json` (fields: `filename`, `description`,
`condition_tag`, `source_url`, `source_page`, `author`, `license`). Each file
is a single-channel 512x496 JPEG (35-47 KB, no downscaling required) drawn
from the **Kermany et al. OCT2017** validation split, whose filenames follow
the dataset's `(disease)-(patientID)-(imageNumber)` convention. They were
retrieved from a GitHub mirror that redistributes the dataset
([Goodsea/heysaw](https://github.com/Goodsea/heysaw), MIT-licensed project
that cites the Kermany dataset); the canonical dataset is the Mendeley Data
record below. The images themselves remain the authors' works under **CC BY
4.0**.

Every image in this section is public research/teaching imagery used to
represent synthetic demo patients, not real patient data.

| Filename | Condition tag | Author | License | Link |
|----------|---------------|--------|---------|------|
| `oct-cnv-fluid-1.jpg` | `cnv_active` | Kermany, Zhang, Goldbaum (2018) | CC BY 4.0 | [source](https://raw.githubusercontent.com/Goodsea/heysaw/master/deploy/val/CNV/CNV-6294785-1.jpeg) · [dataset](https://data.mendeley.com/datasets/rscbjbr9sj/2) |
| `oct-cnv-fluid-2.jpg` | `cnv_active` | Kermany, Zhang, Goldbaum (2018) | CC BY 4.0 | [source](https://raw.githubusercontent.com/Goodsea/heysaw/master/deploy/val/CNV/CNV-6652117-1.jpeg) · [dataset](https://data.mendeley.com/datasets/rscbjbr9sj/2) |
| `oct-post-treatment-dry-1.jpg` | `post_treatment` | Kermany, Zhang, Goldbaum (2018) | CC BY 4.0 | [source](https://raw.githubusercontent.com/Goodsea/heysaw/master/deploy/val/DRUSEN/DRUSEN-9837663-1.jpeg) · [dataset](https://data.mendeley.com/datasets/rscbjbr9sj/2) |
| `oct-post-treatment-macula-1.jpg` | `post_treatment` | Kermany, Zhang, Goldbaum (2018) | CC BY 4.0 | [source](https://raw.githubusercontent.com/Goodsea/heysaw/master/deploy/val/NORMAL/NORMAL-5171640-1.jpeg) · [dataset](https://data.mendeley.com/datasets/rscbjbr9sj/2) |
| `oct-normal-macula-1.jpg` | `normal` | Kermany, Zhang, Goldbaum (2018) | CC BY 4.0 | [source](https://raw.githubusercontent.com/Goodsea/heysaw/master/deploy/val/NORMAL/NORMAL-4872585-1.jpeg) · [dataset](https://data.mendeley.com/datasets/rscbjbr9sj/2) |
| `oct-normal-macula-2.jpg` | `normal` | Kermany, Zhang, Goldbaum (2018) | CC BY 4.0 | [source](https://raw.githubusercontent.com/Goodsea/heysaw/master/deploy/val/NORMAL/NORMAL-5193994-1.jpeg) · [dataset](https://data.mendeley.com/datasets/rscbjbr9sj/2) |

Condition-tag mapping: `cnv_active` uses `CNV`-class scans (choroidal
neovascularization with exudative fluid); `post_treatment` uses a `DRUSEN`
scan (dry AMD, fluid resolved) and a `NORMAL` scan (restored macula); `normal`
uses `NORMAL`-class scans. This preserves the earlier visit→class mapping
(William Thompson: `CNV` for fluid/worsened visits, `NORMAL` for dry
post-treatment visits; Margaret Chen: `NORMAL` throughout).

## Everything else

All patient records, documents, contradictions, measurements, and narratives in
`sidecar/seed/` are entirely synthetic, converted from the private
`second-opinion` prototype's authored demo data. No real patient data is used
anywhere in this repository.
