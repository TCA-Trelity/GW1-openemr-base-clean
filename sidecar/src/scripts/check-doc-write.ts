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
for (const needed of ['api:oemr', 'user/document.read', 'user/document.write']) {
    console.log(`${granted.includes(needed) ? '✓ granted' : '✗ MISSING'}  ${needed}`);
}

if (testPid === undefined) {
    console.log('\n(no OPENEMR_TEST_PID set — skipping the live GET/POST probes; the scope report above is the main answer)');
    process.exit(0);
}

const headers = { authorization: `Bearer ${tokenBody['access_token']}` };
const get = await fetch(`${base}/apis/default/api/patient/${testPid}/document?path=${encodeURIComponent('Lab Report')}`, { headers });
console.log(`\ndocument READ  (GET  …/document?path=Lab Report): ${get.status}${get.ok ? ' — ACL patients/docs read OK' : ` — ${JSON.stringify(await get.json().catch(() => ({})))}`}`);

const form = new FormData();
form.set('document', new Blob([new TextEncoder().encode('%PDF-1.4 probe')], { type: 'application/pdf' }), 'probe.pdf');
const post = await fetch(`${base}/apis/default/api/patient/${testPid}/document?path=${encodeURIComponent('Lab Report')}`, {
    method: 'POST',
    headers,
    body: form,
});
console.log(`document WRITE (POST …/document?path=Lab Report): ${post.status}${post.ok ? ' — write path fully working (a tiny probe.pdf is now in that chart; delete it via the EHR UI)' : ` — ${JSON.stringify(await post.json().catch(() => ({})))}`}`);
