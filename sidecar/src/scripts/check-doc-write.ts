// Diagnostic for the document-write 401 (USER-ACTIONS item 5 / test plan A1).
// Mints a password-grant token with the SAME values the sidecar uses and prints what
// OpenEMR actually GRANTED — the registered∩requested scope intersection that the
// /ready probe cannot see (it only proves a mint). Then probes document READ vs WRITE
// so scope problems and ACL problems separate cleanly.
//
//   OPENEMR_BASE_URL='https://…railway.app' OPENEMR_CLIENT_ID='…' \
//   OPENEMR_API_USERNAME='admin' OPENEMR_API_PASSWORD='…' \
//   [OPENEMR_TEST_PID='<patient uuid>'] npx tsx src/scripts/check-doc-write.ts
//
// Reading the outcome:
//   granted scopes MISSING user/document.write  -> wrong client row (or stale clone at
//     registration time): re-register from a pulled clone, enable THAT row, sync its id.
//   granted includes it but GET+POST both 401   -> EHR-side ACL (patients/docs) for the
//     API user — check the user's group/ACL in OpenEMR.
//   GET 200 but POST 401                        -> ACL write/addonly specifically.
//   GET 404                                     -> normal for an EMPTY category (OpenEMR
//     404s empty listings); only the POST + verification verdict below is authoritative.
import { createHash } from 'node:crypto';
import { STANDARD_API_SEED_SCOPES } from '../openemr/auth.js';

const base = process.env['OPENEMR_BASE_URL']?.replace(/\/+$/, '');
const clientId = process.env['OPENEMR_CLIENT_ID'];
const username = process.env['OPENEMR_API_USERNAME'] ?? 'admin';
const password = process.env['OPENEMR_API_PASSWORD'];
const testPid = process.env['OPENEMR_TEST_PID'];

if (base === undefined || clientId === undefined || password === undefined) {
    console.error('need OPENEMR_BASE_URL, OPENEMR_CLIENT_ID, OPENEMR_API_PASSWORD (and optionally OPENEMR_TEST_PID)');
    process.exit(2);
}

const tokenResponse = await fetch(`${base}/oauth2/default/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
        grant_type: 'password',
        client_id: clientId,
        user_role: 'users',
        username,
        password,
        scope: STANDARD_API_SEED_SCOPES.join(' '),
    }).toString(),
});
const tokenBody = (await tokenResponse.json().catch(() => ({}))) as Record<string, unknown>;
if (!tokenResponse.ok || typeof tokenBody['access_token'] !== 'string') {
    console.error(`token mint FAILED: status ${tokenResponse.status}`, JSON.stringify(tokenBody));
    process.exit(1);
}
console.log('token mint: OK');

const granted = typeof tokenBody['scope'] === 'string' ? tokenBody['scope'].split(' ') : [];
console.log(`granted scopes (${granted.length}):`);
for (const scope of granted.toSorted()) {
    console.log(`  ${scope}`);
}
for (const needed of ['user/document.read', 'user/document.write']) {
    console.log(`${granted.includes(needed) ? '✓ granted' : '✗ MISSING'}  ${needed}`);
}
// api:oemr (the standard-API gateway scope) is deliberately NOT checked against this
// list: OpenEMR grants it but does not echo api:* scopes in the token response, so its
// absence above means nothing (observed live 2026-07-14 — a token whose echo lacked
// api:oemr wrote a document successfully). The probes below are the authoritative test.
console.log('note: api:* gateway scopes are never echoed in the token response — trust the probes below, not their absence above');

if (testPid === undefined) {
    console.log('\n(no OPENEMR_TEST_PID set — skipping the live GET/POST probes; the scope report above is the main answer)');
    process.exit(0);
}

const headers = { authorization: `Bearer ${tokenBody['access_token']}` };

// The document routes take the NUMERIC pid — a raw uuid is silently filed to patient 0
// (Document.class.php:93-103 reassigns any non-numeric id to 0 and still returns 200),
// which is exactly how an earlier probe.pdf vanished into no patient's chart. Resolve a
// uuid to the numeric pid first, the same way the sidecar client now does internally.
let pid = testPid;
if (!/^[1-9]\d*$/.test(pid)) {
    const patientResponse = await fetch(`${base}/apis/default/api/patient/${encodeURIComponent(pid)}`, { headers });
    const patientBody = (await patientResponse.json().catch(() => ({}))) as Record<string, unknown>;
    const dataRaw = patientBody['data'];
    const record = typeof dataRaw === 'object' && dataRaw !== null ? (dataRaw as Record<string, unknown>) : undefined;
    const resolved = String(record?.['pid'] ?? '');
    if (!patientResponse.ok || !/^[1-9]\d*$/.test(resolved)) {
        console.error(
            `\ncould not resolve patient uuid → numeric pid (GET /api/patient/:puuid → ${patientResponse.status}). ` +
                'Aborting the probes rather than writing a document that OpenEMR would file to patient 0.',
        );
        process.exit(1);
    }
    console.log(`\nresolved patient uuid → numeric pid ${resolved} (document routes take the numeric pid; a raw uuid files to patient 0)`);
    pid = resolved;
}

// Category wire format: the route matches space-stripped names against an input that only
// has UNDERSCORES stripped (DocumentService.php:52-94), so 'Lab_Report' works and
// 'Lab Report' silently resolves a null category (documents get orphaned). Responses are
// RAW (rows array / literal true), and an EMPTY category is a 404 by design
// (RestControllerHelper::responseHandler treats [] as falsy).
const docUrl = `${base}/apis/default/api/patient/${pid}/document?path=Lab_Report`;
const listDocs = async (): Promise<Record<string, unknown>[]> => {
    const response = await fetch(docUrl, { headers });
    if (response.status === 404) {
        return [];
    }
    const body = (await response.json().catch(() => undefined)) as unknown;
    return Array.isArray(body) ? (body.filter((row) => typeof row === 'object' && row !== null) as Record<string, unknown>[]) : [];
};

const get = await fetch(docUrl, { headers });
const getVerdict =
    get.ok
        ? ' — ACL patients/docs read OK'
        : get.status === 404
          ? ' — empty category (normal before the first upload; OpenEMR 404s empty listings)'
          : ` — ${JSON.stringify(await get.json().catch(() => ({})))}`;
console.log(`\ndocument READ  (GET  …/document?path=Lab_Report): ${get.status}${getVerdict}`);

const probeBytes = new TextEncoder().encode('%PDF-1.4 probe');
const probeHash = createHash('sha3-512').update(probeBytes).digest('hex');
const form = new FormData();
form.set('document', new Blob([probeBytes], { type: 'application/pdf' }), 'probe.pdf');
const post = await fetch(docUrl, { method: 'POST', headers, body: form });
console.log(`document WRITE (POST …/document?path=Lab_Report): ${post.status}${post.ok ? '' : ` — ${JSON.stringify(await post.json().catch(() => ({})))}`}`);

if (post.ok) {
    // A 200 alone proves nothing (a mis-resolved category still 200s and orphans the
    // document) — verify the write by finding our hash in the category listing.
    const filed = (await listDocs()).find((row) => row['hash'] === probeHash);
    if (filed !== undefined) {
        console.log(`verification: probe.pdf is FILED under Lab Report as document id ${String(filed['id'])} — write path fully verified (delete it via the EHR UI when done)`);
    } else {
        console.error('verification: POST returned 200 but probe.pdf is NOT listed under the category — ORPHANED write (category mis-resolution); do not trust this write path');
        process.exit(1);
    }
}
