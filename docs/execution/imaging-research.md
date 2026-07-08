# OCT Imaging Workspace — Design Research Brief (V1 input)

Research window: 2024–2026 practice. Purpose: ground the imaging workspace redesign in
what retina specialists actually read per visit and how current OCT review/AI tools lay
it out — then map that onto **our real data model** so the build agent builds what our
records can support and fakes nothing.

**Our data model (read before recommending anything).** Source: `sidecar/panel/src/types.ts`,
`sidecar/panel/src/imaging/*`, `sidecar/seed/*.json`.
- Per-scan `ImageRecord`: `image_metadata` (capture_date, modality=`oct`, laterality, scan_type, scan_quality), a **single 2D B-scan JPEG** (`storage_key`, Kermany-style stock — *not* co-registered, *not* a volume), + authored `ai_analysis`.
- `ai_analysis.measurements[]`: **scalar** `measurement_type` (`central_retinal_thickness`, `ganglion_cell_thickness`, `rnfl_thickness`) with `value`, `unit`, `reference_range {normal_min, normal_max}`. One value per scan — **no maps, no sectors**.
- `ai_analysis.findings[]`: `finding_type` (`subretinal_fluid`, `drusen`, `pigment_epithelial_detachment`, `rpe_changes`, `retinal_thinning`, `normal`), `severity` (mild/moderate/severe), `confidence` (0–1), `location`, `description`. **Fluid is categorical, not a quantified volume.**
- `ai_analysis.comparison_to_prior`: `overall_change` (improved/worsened/stable/mixed), `interval_days`, `treatment_response {assessment, confidence, rationale}`, `changes[]`.
- `treatment_context`: `days_since_last_treatment`, `last_treatment.medication`, `interval_from_prior_image`, `treatment_cycle_number`.
- Server-computed brief blocks: `interval_analysis` (`intervals[]` each with `interval_weeks`+`outcome`, `pattern_summary`, `optimal_interval`, `recommendation`, `confidence`) and `hcq_progression` (`gc_thickness_trend[]`, `rpe_changes_trend[]`, `progression_detected`, `alert_level`, `recommendation`).
- **1–7 scans/patient**, all OCT, all OD in seed (laterality field exists for OS). `recharts` already in use.
- Structured VA (visual acuity) is **absent** — it lives only as free text inside treatment `pre_treatment_assessment` / `outcome`. Do not chart it.

---

## 1. The numbers that matter

### Wet AMD anti-VEGF visit (treat-and-extend decision)
| Metric | Threshold / reference band worth showing | Drives | We have it? |
|---|---|---|---|
| Central subfield / retinal thickness (CST/CRT, µm) | Normal ~**240–280 µm**; recurrence signal = rise **≥100 µm** from nadir (with ≥10-letter VA drop) or **≥150 µm** alone (HAWK/HARRIER-style protocol) | Extend vs hold vs shorten interval | Yes — scalar `central_retinal_thickness` + `reference_range` |
| Fluid status (IRF / SRF present-absent + location) | "Dry macula" = success; IRF less tolerated than SRF; PED height/stability | The core wet/dry call | Yes — categorical `findings` (subretinal_fluid, PED); **no IRF volume** |
| Δ CST vs prior **and vs baseline** | Direction + magnitude; post-loading CST predicts future injection frequency | Interval titration | Yes — `measurementDelta` (prior); baseline delta = cheap display math |
| Injection interval (weeks) | Extend **+2 wk** when dry; shorten **−2 to −4 wk** when wet; cap **12–16 wk**, floor **4 wk** | Next appointment | Yes — `interval_analysis.intervals[].interval_weeks` + `optimal_interval` |
| Overall change / treatment response | improved/stable/worsened + good/partial/no response | Regimen confidence | Yes — `comparison_to_prior` |
| Visual acuity (letters) | ≥10-letter drop is a co-trigger with CST | Confirms activity | **No** (free text only) — do not chart |

### Hydroxychloroquine (HCQ) toxicity screening (AAO 2016, reaffirmed 2025/2026 revision)
| Metric | Threshold / reference band worth showing | Drives | We have it? |
|---|---|---|---|
| Daily dose | **≤5.0 mg/kg real body weight**; >5 mg/kg is a primary risk factor | Risk stratification | Not in imaging records (dose lives elsewhere) |
| Cumulative duration | Risk <1% at 5 yr, <2% at 10 yr, ~**20% at 20 yr**; annual screening begins **after 5 yr** of use | When to screen | Derivable from scan date span, not authored |
| GC-IPL / inner-retinal thickness (µm) | Parafoveal ring; **progressive thinning** = early toxicity; our band lower-normal ~**70 µm** (seed uses 70–95) | Toxicity call | Yes — scalar `ganglion_cell_thickness` + trend |
| Structural OCT signs | Parafoveal **ellipsoid-zone (EZ) loss**, ONL thinning, **"flying saucer" sign**, peripapillary RNFL thinning | Confirmatory | Partially — `findings` (retinal_thinning, rpe_changes); **no EZ/segmentation overlay** |
| Toxicity pattern | **Parafoveal** (European) vs **pericentral** (East Asian) — screen both | Where to look | Descriptive only (finding `location`) |
| Primary test set | SD-OCT macula + automated **10-2** fields (24-2/30-2 Asian) + **FAF**; mfERG if equivocal | Screening protocol | We only hold the OCT leg |

---

## 2. Viewer / layout conventions (from tools reviewed)

| Tool | Convention worth borrowing | Source |
|---|---|---|
| Heidelberg Spectralis (Glaucoma/Progression module) | Baseline + follow-up shown together; **thinning-vs-baseline highlighted in a signal color**; eye-tracked AutoRescan registers follow-ups to baseline for exact correlation | reviewofophthalmology.com "Tracking Glaucoma with OCT" |
| Zeiss Cirrus Guided Progression Analysis (GPA) | **Event- + trend-based** change; needs ≥3 scans for "possible", ≥4 for "likely" progression; change-from-baseline framing | reviewofophthalmology.com "Art of Detecting Progression on OCT" |
| ETDRS 9-sector grid | Standardized central-subfield + inner/outer rings, **normative color-coding** (green/yellow/red deviation) — the canonical macular thickness readout | mdpi.com / PMC12656429 ETDRS-sector comparison |
| OHIF Viewer + Cornerstone3D (v3.9, 2024) | Browser DICOM viewer, **React + Tailwind**; left **thumbnail/series panel**, main viewport, **dark chrome**; synchronized scrolling, reference lines, hanging protocols for **prior-vs-current side-by-side**; segmentation labelmaps | github.com/cornerstonejs/cornerstone3D (read directly); ohif.org v3.9 note |
| Altris AI | Browser-based, 70+ pathologies; **structured pathology+severity list**, **heatmaps highlighting abnormal regions**, toggleable layer-segmentation overlays, clinician report module | ophthalmologytimes.com; altris.ai/ai-oct-for-ophthalmologists |
| RetinAI Discovery | Image+data management; fluid/layer/PED **segmentation & quantification with trend over time** | retinai.com/discovery-for-clinics |
| Notal SCANLY Home OCT / NOA analyzer (FDA-cleared 2024) | **IRF/SRF fluid-volume trajectories** over time + **AUC "fluid exposure" between treatments** — the fluid-trend-graph paradigm for anti-VEGF | notalvision.com/services/scanly-oct; aao.org home-OCT editors-choice |
| OD/OS + chrome norm | Right eye (OD) rendered left, left eye (OS) right; **dark viewer background** behind B-scans so retinal contrast pops | OHIF/Spectralis convention (general) |

**AI-findings presentation (Q3) distilled:** structured finding list (pathology label + severity + **confidence %**) is the baseline; heatmaps highlight *where* (Altris); toggleable segmentation overlays show *what layer*; a compact per-scan report summarizes. Confidence is shown as a plain percentage, badges carry severity, and change-over-time is a separate trend panel — **not** crammed onto the B-scan.

---

## 3. Recommendations for OUR workspace (prioritized)

Current build: `Imaging.tsx` (Timeline / Trends / Intervals / Compare sub-tabs), `ScanDetail.tsx`
(scan-left + authored-analysis-right + trends beneath), `Trends.tsx` (CRT + GC line charts with
reference bands), `Compare.tsx` (up to 4 side-by-side). Everything below fits the authored
`ai_analysis` + scalar measurements — no raw volume required.

### Must-have (buildable now, high clinical value)
1. **Fluid status as a first-class "wet / dry" chip**, derived from `findings` (SRF/IRF/PED present + severity), surfaced in the ScanDetail header and each Timeline row. After CST, this is *the* wet-AMD number; today it's buried in a findings list.
2. **Change-vs-baseline delta alongside change-vs-prior** on scalar rows (`MeasurementRow`). Baseline = first scan in the modality+laterality series; pure display math over data we already have. Mirrors Spectralis "difference vs baseline."
3. **Injection-interval ladder / swimlane** on the Intervals tab: plot `interval_weeks` per cycle as a recharts step/bar, **colored by `outcome`** (dry=emerald, leaked=red), with `optimal_interval` as a reference line. Directly supported by `interval_analysis.intervals[]`; this is the T&E "interval ladder" convention clinicians expect.
4. **Baseline→latest summary strip** at the top of the Imaging tab: CST baseline → latest (Δ), current fluid state, current interval + response. One-glance visit summary; all fields present.
5. **Reference bands calibrated per metric** (already partially present): keep 240–280 µm normal on CST, ~70 µm lower-normal on GC-IPL; add an optional dashed **baseline line** (first-scan value) so "change from baseline" is visible, not just implied.
6. **OD/OS discipline + dark chrome behind the B-scan pane.** Group/label by laterality even though seed is all OD; render the B-scan on a dark surface (viewer convention) inside the otherwise-light panel.

### Nice-to-have (do if cheap)
- Inline **sparklines** of CST / GC-IPL in Timeline rows for at-a-glance trend.
- **Prior-vs-current 2-up quick compare** with a delta readout (extend `Compare` beyond the checkbox grid); a static side-by-side, *not* a pixel flicker.
- Normative **color-coding of scalar values** (green/amber/red vs `reference_range`) — extend the existing amber-when-out-of-range treatment.
- Progression banner styling for HCQ already exists via `hcq_progression`; keep and make the `alert_level` visually load-bearing.

### Skip — data cannot support it; do not fabricate
- **ETDRS 9-sector thickness grid.** We hold **one** central-subfield scalar, not nine sectors. Do not render a 9-cell grid with invented sector values.
- **Thickness maps / en-face maps / change-from-baseline heatmaps.** No volume or per-pixel thickness data; the B-scan is a single 2D JPEG.
- **Segmentation-line overlays on the B-scan.** No per-pixel segmentation coordinates in the record.
- **Slice-scrolling filmstrip through a volume.** Each scan is one image, not a cube.
- **Quantified fluid-volume trajectories / AUC (Notal-style).** Fluid is categorical severity, not nL/µm³ — plotting a volume curve would be fabricated.
- **Normative-percentile deviation maps (Cirrus GPA style).** No normative database; only per-metric `normal_min`/`normal_max`.
- **True flicker overlay of co-registered retina.** Stock B-scans are not registered across visits.

---

## 4. Sources

Direct fetch was blocked (HTTP 403 at origin) for most publisher hosts through this
environment's proxy, as anticipated. Content below was read via search-result synthesis
except where marked **(read directly)**. URLs are those the findings are grounded in.

- Anti-VEGF T&E / CST activity thresholds — ophthalmology360.com "Post-loading OCT findings refine anti-VEGF frequency"; PMC7431723 (T&E long-term outcomes); PMC6802800 (T&E interval-pattern clustering: 8-wk and 12-wk clusters).
- HCQ screening (2016 + 2025/2026 revision) — healio.com 2016 AAO revision; aao.org clinical statement (screening recommendations, 2026 revision); aaojournal.org S0161-6420(25)00709-2 (2025 revision); PMC10267834 / frontiersin.org 10.3389/fphar.2023.1196783 (HCQ retinal toxicity, OCT signs, GC-IPL); eyewiki.org "Hydroxychloroquine Toxicity".
- OCT review-software layout — reviewofophthalmology.com "Tracking Glaucoma with OCT" & "The Art of Detecting Progression on OCT"; mdpi.com / PMC12656429 (ETDRS-sector thickness).
- Web viewers — **github.com/cornerstonejs/cornerstone3D README (read directly)**; ohif.org v3.9 (Cornerstone3D 2.0, segmentation, React/Tailwind UI).
- AI OCT tools — ophthalmologytimes.com (Altris platform launch); altris.ai/ai-oct-for-ophthalmologists (70+ pathologies, heatmaps, segmentation); retinai.com/discovery-for-clinics & retinai.com OCT-segmentation article (fluid/layer/PED quantification).
- Home-OCT fluid dashboards — notalvision.com/services/scanly-oct; aao.org editors-choice "Home OCT device for daily self-monitoring of wet AMD"; ophthalmologytimes.com (Notal home-OCT data); modernretina.com (home-monitoring scan quality).
