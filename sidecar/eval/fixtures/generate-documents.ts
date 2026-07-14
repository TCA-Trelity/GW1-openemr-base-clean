// A.7 (REQ S1 tailoring, D4, G18): generate the Week 2 document fixtures — committed
// PDFs, reproducible from the repo by re-running this script:
//
//   npm run fixtures:documents          (CHROMIUM_PATH overrides the browser binary)
//
// Fixture set (values consistent with the authored seed corpora — synthetic patients):
//   renal-panel-clean.pdf     Margaret L. Chen outside renal/metabolic panel: eGFR 42 (L),
//                             creatinine 1.58 (H) — the declining-renal-function arc that
//                             re-tiers her hydroxychloroquine toxicity risk (UC-4).
//   renal-panel-skewed.pdf    Same content as a messy scan: rotated, noisy, blurred,
//                             image-only (no text layer) — the grounding ladder's
//                             degraded rung (R5: bbox → page → unverified).
//   renal-panel-lowdpi.pdf    Same content at low resolution, image-only.
//   intake-update-clean.pdf   Margaret L. Chen established-patient intake update:
//                             chief concern w/ laterality (OD), med change (lisinopril),
//                             new allergy (penicillin), family-history addition
//                             (father, glaucoma), vitals, patient-goals line (UC-7).
//   intake-update-scanned.pdf Same intake as a scan (image-only).
//   hba1c-panel-clean.pdf     Robert M. Alvarez HbA1c 8.4% (H) — the diabetic-retinopathy
//                             management arc for the second wired-in corpus patient.
//
// Degradation is done in CSS before printing (rotation, grain overlay, blur, contrast),
// then screenshotted and re-embedded as an image-only PDF — so degraded fixtures have
// NO text layer, exactly like a real fax/scan, and OCR-side grounding is genuinely
// exercised. Zero PHI: every value is authored synthetic data from sidecar/seed/.
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';

const OUT_DIR = fileURLToPath(new URL('./documents/', import.meta.url));
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';

const BASE_CSS = `
  * { box-sizing: border-box; margin: 0; }
  body { font: 11px/1.45 'Helvetica Neue', Arial, sans-serif; color: #111; padding: 34px 40px; background: #fff; }
  h1 { font-size: 15px; letter-spacing: 0.4px; }
  h2 { font-size: 12px; margin: 14px 0 6px; border-bottom: 1px solid #999; padding-bottom: 2px; text-transform: uppercase; letter-spacing: 0.6px; }
  table { border-collapse: collapse; width: 100%; margin-top: 6px; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; color: #333; border-bottom: 1.5px solid #333; padding: 3px 8px 3px 0; }
  td { padding: 4px 8px 4px 0; border-bottom: 1px solid #ddd; }
  .flag-h, .flag-l { font-weight: 700; }
  .flag-h { color: #a11; } .flag-l { color: #a11; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px double #333; padding-bottom: 10px; }
  .lab-name { font-size: 16px; font-weight: 700; }
  .muted { color: #444; font-size: 10px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 30px; margin-top: 8px; }
  .kv b { display: inline-block; min-width: 118px; font-weight: 600; }
  .note { margin-top: 10px; font-size: 10px; color: #333; }
  .footer { margin-top: 26px; border-top: 1px solid #999; padding-top: 6px; font-size: 9px; color: #555; }
  .handwrite { font-family: 'Comic Sans MS', 'Segoe Script', cursive; font-size: 12.5px; color: #1a2a6b; }
  .field { border-bottom: 1px solid #888; min-height: 17px; padding: 1px 4px; }
  .box { border: 1.5px solid #333; padding: 8px 10px; margin-top: 8px; }
`;

const RENAL_PANEL_HTML = `
<style>${BASE_CSS}</style>
<div class="head">
  <div>
    <div class="lab-name">ORLANDO DIAGNOSTIC LABORATORIES</div>
    <div class="muted">4880 Lake Underhill Rd, Orlando, FL 32807 · CLIA 10D0123456</div>
  </div>
  <div class="muted" style="text-align:right">
    FINAL REPORT<br>Accession: ODL-24-887341<br>Reported: 12/21/2024 07:42
  </div>
</div>
<div class="grid">
  <div class="kv"><b>Patient:</b> CHEN, MARGARET L</div>
  <div class="kv"><b>Ordering provider:</b> Anita Patel, MD (Rheumatology)</div>
  <div class="kv"><b>DOB:</b> 03/14/1967 (57 y) &nbsp; <b>Sex:</b> F</div>
  <div class="kv"><b>Collected:</b> 12/20/2024 09:15</div>
  <div class="kv"><b>Patient ID:</b> FPA-2019-4521</div>
  <div class="kv"><b>Received:</b> 12/20/2024 14:02</div>
</div>
<h2>Basic Metabolic Panel + eGFR</h2>
<table>
  <tr><th>Test</th><th>Result</th><th>Flag</th><th>Units</th><th>Reference Interval</th></tr>
  <tr><td>Sodium</td><td>139</td><td></td><td>mmol/L</td><td>136–145</td></tr>
  <tr><td>Potassium</td><td>4.4</td><td></td><td>mmol/L</td><td>3.5–5.1</td></tr>
  <tr><td>Chloride</td><td>103</td><td></td><td>mmol/L</td><td>98–107</td></tr>
  <tr><td>Carbon Dioxide</td><td>24</td><td></td><td>mmol/L</td><td>21–31</td></tr>
  <tr><td>BUN</td><td>28</td><td class="flag-h">H</td><td>mg/dL</td><td>7–25</td></tr>
  <tr><td>Creatinine</td><td>1.58</td><td class="flag-h">H</td><td>mg/dL</td><td>0.50–1.10</td></tr>
  <tr><td>eGFR (CKD-EPI)</td><td>42</td><td class="flag-l">L</td><td>mL/min/1.73m²</td><td>&ge;60</td></tr>
  <tr><td>Glucose</td><td>96</td><td></td><td>mg/dL</td><td>65–99</td></tr>
  <tr><td>Calcium</td><td>9.3</td><td></td><td>mg/dL</td><td>8.6–10.3</td></tr>
</table>
<div class="note"><b>Comment:</b> eGFR decreased from prior result of 58 mL/min/1.73m² (03/22/2024).
Suggest clinical correlation; repeat in 4–6 weeks if indicated.</div>
<div class="footer">Performing site: ODL Main Campus. Methods available on request. This synthetic document contains no real patient information.</div>
`;

const INTAKE_UPDATE_HTML = `
<style>${BASE_CSS}</style>
<div class="head">
  <div>
    <div class="lab-name">FLORIDA RETINA ASSOCIATES</div>
    <div class="muted">Established Patient — Intake Update Form (front desk)</div>
  </div>
  <div class="muted" style="text-align:right">Visit date: <span class="handwrite">12/26/2024</span></div>
</div>
<div class="grid" style="margin-top:10px">
  <div class="kv"><b>Name:</b> <span class="handwrite">Margaret L. Chen</span></div>
  <div class="kv"><b>DOB:</b> <span class="handwrite">03/14/1967</span></div>
</div>
<h2>Reason for today's visit</h2>
<div class="field handwrite">Flashes of light in my RIGHT eye, about 2 weeks now. Sometimes a new floater.</div>
<h2>Medication changes since your last visit</h2>
<table>
  <tr><th>Medication</th><th>Dose</th><th>How often</th><th>Started</th><th>Change?</th></tr>
  <tr><td class="handwrite">Hydroxychloroquine (Plaquenil)</td><td class="handwrite">200 mg</td><td class="handwrite">daily</td><td class="handwrite">Jan 2019</td><td class="handwrite">no change</td></tr>
  <tr><td class="handwrite">Methotrexate</td><td class="handwrite">15 mg</td><td class="handwrite">weekly</td><td class="handwrite">Feb 2019</td><td class="handwrite">no change</td></tr>
  <tr><td class="handwrite">Lisinopril</td><td class="handwrite">10 mg</td><td class="handwrite">daily</td><td class="handwrite">Nov 2024</td><td class="handwrite">NEW — Dr. Osei</td></tr>
</table>
<h2>New allergies or reactions</h2>
<div class="field handwrite">Penicillin — hives (last month, urgent care)</div>
<h2>Family eye history — anything new?</h2>
<div class="field handwrite">Father was told he has glaucoma this year. (Mother: retinal detachment — already on file.)</div>
<h2>Measurements (staff use)</h2>
<div class="grid">
  <div class="kv"><b>Height:</b> 5 ft 4 in</div>
  <div class="kv"><b>Weight:</b> 138 lb</div>
  <div class="kv"><b>Blood pressure:</b> 128 / 78</div>
  <div class="kv"><b>Taken by:</b> D. Reyes, Tech</div>
</div>
<h2>What are you hoping for from today's visit?</h2>
<div class="box handwrite">Please get me healed up before my daughter Emily's wedding — six weeks away. I also need to stay able to drive David to his appointments.</div>
<div class="footer">Form FRA-EP-02 (rev 2024-08). This synthetic document contains no real patient information.</div>
`;

const HBA1C_PANEL_HTML = `
<style>${BASE_CSS}</style>
<div class="head">
  <div>
    <div class="lab-name">ORLANDO DIAGNOSTIC LABORATORIES</div>
    <div class="muted">4880 Lake Underhill Rd, Orlando, FL 32807 · CLIA 10D0123456</div>
  </div>
  <div class="muted" style="text-align:right">
    FINAL REPORT<br>Accession: ODL-24-885112<br>Reported: 12/19/2024 06:58
  </div>
</div>
<div class="grid">
  <div class="kv"><b>Patient:</b> ALVAREZ, ROBERT M</div>
  <div class="kv"><b>Ordering provider:</b> T. Nguyen, MD (Family Medicine)</div>
  <div class="kv"><b>DOB:</b> 09/05/1962 (62 y) &nbsp; <b>Sex:</b> M</div>
  <div class="kv"><b>Collected:</b> 12/18/2024 08:05</div>
  <div class="kv"><b>Patient ID:</b> MEC-2023-0642</div>
  <div class="kv"><b>Received:</b> 12/18/2024 13:40</div>
</div>
<h2>Glycemic Panel</h2>
<table>
  <tr><th>Test</th><th>Result</th><th>Flag</th><th>Units</th><th>Reference Interval</th></tr>
  <tr><td>Hemoglobin A1c</td><td>8.4</td><td class="flag-h">H</td><td>%</td><td>&lt;5.7</td></tr>
  <tr><td>Estimated Average Glucose</td><td>194</td><td class="flag-h">H</td><td>mg/dL</td><td>—</td></tr>
  <tr><td>Glucose, Fasting</td><td>178</td><td class="flag-h">H</td><td>mg/dL</td><td>65–99</td></tr>
</table>
<div class="note"><b>Comment:</b> HbA1c increased from prior result of 7.6% (06/14/2024).</div>
<div class="footer">Performing site: ODL Main Campus. This synthetic document contains no real patient information.</div>
`;

interface DegradeOptions {
    rotateDeg: number;
    blurPx: number;
    scale: number;
    jpegQuality: number;
}

async function printCleanPdf(page: Page, html: string, outFile: string): Promise<void> {
    await page.setContent(`<!DOCTYPE html><html><body>${html}</body></html>`, { waitUntil: 'load' });
    const pdf = await page.pdf({ format: 'Letter', printBackground: true });
    writeFileSync(join(OUT_DIR, outFile), pdf);
}

// Degraded scan: wrap the document in rotation + grain + blur CSS, screenshot it (raster),
// then embed the raster into a fresh page and print — an image-only PDF with no text layer.
async function printDegradedPdf(page: Page, html: string, outFile: string, options: DegradeOptions): Promise<void> {
    const grain =
        'repeating-radial-gradient(circle at 17% 31%, rgba(0,0,0,0.055) 0 1px, transparent 1px 3px), ' +
        'repeating-linear-gradient(94deg, rgba(0,0,0,0.03) 0 2px, transparent 2px 5px)';
    await page.setContent(
        `<!DOCTYPE html><html><body style="background:#e9e7e2; padding:18px; margin:0;">
           <div style="transform: rotate(${options.rotateDeg}deg); filter: blur(${options.blurPx}px) contrast(0.92) brightness(0.97) grayscale(0.35); background:#fff; box-shadow: 0 0 14px rgba(0,0,0,0.35);">
             <div style="position:relative;">${html}
               <div style="position:absolute; inset:0; background:${grain}; pointer-events:none;"></div>
             </div>
           </div>
         </body></html>`,
        { waitUntil: 'load' },
    );
    const shot = await page.screenshot({ fullPage: true, type: 'jpeg', quality: options.jpegQuality, scale: 'css' });
    const dataUri = `data:image/jpeg;base64,${shot.toString('base64')}`;
    await page.setContent(
        `<!DOCTYPE html><html><body style="margin:0;"><img src="${dataUri}" style="width:${(100 * options.scale).toFixed(0)}%; display:block; margin:0 auto;"></body></html>`,
        { waitUntil: 'load' },
    );
    const pdf = await page.pdf({ format: 'Letter', printBackground: true });
    writeFileSync(join(OUT_DIR, outFile), pdf);
}

let browser: Browser | undefined;
try {
    mkdirSync(OUT_DIR, { recursive: true });
    browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
    const page = await browser.newPage({ viewport: { width: 816, height: 1056 } }); // Letter @ 96dpi

    await printCleanPdf(page, RENAL_PANEL_HTML, 'renal-panel-clean.pdf');
    await printDegradedPdf(page, RENAL_PANEL_HTML, 'renal-panel-skewed.pdf', { rotateDeg: 1.4, blurPx: 0.45, scale: 1, jpegQuality: 62 });
    await printDegradedPdf(page, RENAL_PANEL_HTML, 'renal-panel-lowdpi.pdf', { rotateDeg: 0.3, blurPx: 0.8, scale: 0.72, jpegQuality: 38 });
    await printCleanPdf(page, INTAKE_UPDATE_HTML, 'intake-update-clean.pdf');
    await printDegradedPdf(page, INTAKE_UPDATE_HTML, 'intake-update-scanned.pdf', { rotateDeg: -1.1, blurPx: 0.4, scale: 1, jpegQuality: 60 });
    await printCleanPdf(page, HBA1C_PANEL_HTML, 'hba1c-panel-clean.pdf');

    for (const file of [
        'renal-panel-clean.pdf',
        'renal-panel-skewed.pdf',
        'renal-panel-lowdpi.pdf',
        'intake-update-clean.pdf',
        'intake-update-scanned.pdf',
        'hba1c-panel-clean.pdf',
    ]) {
        const size = statSync(join(OUT_DIR, file)).size;
        console.log(`${file}  ${(size / 1024).toFixed(0)} KB`);
    }
    console.log(`fixtures written to ${OUT_DIR}`);
} finally {
    await browser?.close();
}

// Referenced from dirname import guard (kept for parity with sibling scripts).
void dirname;
