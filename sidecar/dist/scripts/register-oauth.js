// One-time CLI (npx tsx scripts/register-oauth.ts): generates an RSA keypair, registers the
// sidecar as an OpenEMR system client, and prints the env vars Railway needs.
// Registration contract: src/RestControllers/AuthorizationController.php:268-357.
import { generateClientKey, registerSystemClient, SYSTEM_SCOPES } from '../openemr/auth.js';
const baseUrl = process.env['OPENEMR_BASE_URL'];
if (baseUrl === undefined || baseUrl === '') {
    console.error('OPENEMR_BASE_URL is required, e.g. OPENEMR_BASE_URL=https://ehr.example.com npx tsx scripts/register-oauth.ts');
    process.exit(1);
}
const clientName = process.env['OPENEMR_CLIENT_NAME'] ?? 'Clinical Co-Pilot Sidecar';
console.error(`Generating RSA keypair (4096-bit, RS384) and registering "${clientName}" at ${baseUrl} ...`);
const key = generateClientKey(4096);
try {
    const registered = await registerSystemClient({
        baseUrl,
        clientName,
        jwks: key.jwks,
        scopes: SYSTEM_SCOPES,
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
    console.log('\nIMPORTANT: clients registered with system/* scopes start DISABLED', '(src/Common/Auth/OpenIDConnect/Repositories/ScopeRepository.php:352-360).', 'An OpenEMR administrator must enable this client under', 'Administration > System > API Clients before token requests will succeed', '(Documentation/api/AUTHENTICATION.md:150-151).');
    console.log('\nThe private key above is shown ONCE and is not stored anywhere else — save it now.');
}
catch (error) {
    // OpenEmrAuthError messages carry only status + OAuth error code/description (no raw bodies).
    console.error(error instanceof Error ? error.message : 'registration failed');
    process.exit(1);
}
//# sourceMappingURL=register-oauth.js.map