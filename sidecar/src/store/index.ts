// Store barrel + Pool factory (S1.6). ssl engages only when the connection string demands
// it — Railway's public proxy uses sslmode=require with a cert we cannot verify, while the
// private-network URL carries no sslmode and needs no TLS.
import { Pool } from 'pg';
import type { Config } from '../config.js';

export { FactStore } from './factStore.js';
export type {
    BriefInput,
    BriefStatus,
    ContradictionInput,
    FactBundle,
    FactInput,
    ImageRecordInput,
    PatientInput,
    PrepRunStatus,
    SourceDocumentInput,
    StoredBrief,
    StoredContradiction,
    StoredFact,
    StoredImageRecord,
    StoredPatient,
    StoredPrepRun,
    StoredTreatment,
    TreatmentInput,
} from './factStore.js';
export { migrate } from './migrate.js';

export function createPool(config: Config): Pool {
    const url = config.DATABASE_URL;
    if (url === undefined) {
        throw new Error('DATABASE_URL is not configured');
    }
    const sslmode = /[?&]sslmode=([a-z-]+)/.exec(url)?.[1];
    if (sslmode === 'verify-ca' || sslmode === 'verify-full') {
        return new Pool({ connectionString: url, ssl: true }); // full certificate verification
    }
    if (sslmode === 'require' || sslmode === 'prefer' || /[?&]ssl=true/.test(url)) {
        // Railway managed Postgres presents a self-signed chain, so sslmode=require gets
        // encryption without CA verification; callers wanting verification use
        // verify-ca/verify-full (handled above). Pinned by test/store.test.ts.
        return new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } }); // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
    }
    return new Pool({ connectionString: url });
}
