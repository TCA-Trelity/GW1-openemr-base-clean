// One-time CLI (node dist/scripts/register-oauth.js on Railway, npx tsx src/scripts/register-oauth.ts
// locally): generates an RSA keypair, registers the sidecar as an OpenEMR client, and prints the
// env vars Railway needs. Registration contract: src/RestControllers/AuthorizationController.php:268-357.
//
// By default the client is registered for BOTH roles it plays:
//   - client_credentials + system/*.read scopes  -> FHIR reads (the sidecar service itself)
//   - password grant + api:oemr user/* scopes    -> standard-API writes (scripts/seed-ehr.ts;
//     the standard API is closed to system clients, see STANDARD_API_SEED_SCOPES in ../openemr/auth.ts)
// Granted token scopes are intersected with the scopes registered here (ScopeRepository.php:137-188),
// so a client registered before seed-ehr existed must be re-registered to seed. Pass --read-only
// to register with only the original FHIR read scopes (pre-E1 behavior).
import { generateClientKey, registerSystemClient, STANDARD_API_SEED_SCOPES, SYSTEM_SCOPES } from '../openemr/auth.js';

const baseUrl = process.env['OPENEMR_BASE_URL'];
if (baseUrl === undefined || baseUrl === '') {
    console.error('OPENEMR_BASE_URL is required, e.g. OPENEMR_BASE_URL=https://ehr.example.com npx tsx src/scripts/register-oauth.ts');
    process.exit(1);
}
const clientName = process.env['OPENEMR_CLIENT_NAME'] ?? 'Clinical Co-Pilot Sidecar';
const readOnly = process.argv.includes('--read-only');
const scopes = readOnly ? SYSTEM_SCOPES : [...SYSTEM_SCOPES, ...STANDARD_API_SEED_SCOPES];
const grantTypes = readOnly ? ['client_credentials'] : ['client_credentials', 'password'];

console.error(
    `Generating RSA keypair (4096-bit, RS384) and registering "${clientName}" at ${baseUrl} ` +
        `(${readOnly ? 'read-only FHIR scopes' : 'FHIR read + standard-API seed scopes'}) ...`,
);
const key = generateClientKey(4096);

try {
    const registered = await registerSystemClient({
        baseUrl,
        clientName,
        jwks: key.jwks,
        scopes,
        grantTypes,
    });

    console.log('Registration succeeded.\n');
    console.log('Set these environment variables on the sidecar service (Railway):\n');
    console.log(`OPENEMR_CLIENT_ID=${registered.clientId}`);
    // One-lined PEM: paste as-is; the auth client converts the \n escapes back to newlines.
    console.log(`OPENEMR_CLIENT_KEY=${key.privateKeyPem.replace(/\n/g, '\\n')}`);
    console.log(`\nGranted scopes: ${registered.scope ?? '(not echoed by server)'}`);
    if (registered.registrationClientUri !== undefined) {
        console.log(`Registration management URI: ${registered.registrationClientUri}`);
    }
    console.log(
        '\nIMPORTANT: clients registered with system/* scopes start DISABLED',
        '(src/Common/Auth/OpenIDConnect/Repositories/ScopeRepository.php:352-360).',
        'An OpenEMR administrator must enable this client under',
        'Administration > System > API Clients before token requests will succeed',
        '(Documentation/api/AUTHENTICATION.md:150-151).',
    );
    if (!readOnly) {
        console.log(
            '\nNext step after enabling: seed the EHR with the corpus patients —',
            'railway ssh "OPENEMR_SEED_USERNAME=admin OPENEMR_SEED_PASSWORD=... node dist/scripts/seed-ehr.js"',
            '(full runbook in the header of src/scripts/seed-ehr.ts).',
        );
    }
    console.log('\nThe private key above is shown ONCE and is not stored anywhere else — save it now.');
} catch (error) {
    // OpenEmrAuthError messages carry only status + OAuth error code/description (no raw bodies).
    console.error(error instanceof Error ? error.message : 'registration failed');
    process.exit(1);
}
