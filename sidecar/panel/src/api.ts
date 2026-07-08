// Typed fetch client for the sidecar's three endpoints. No retries here — the caller
// (App) owns the polling loop after POST /api/prep.
import type { FactBundle, StoredBrief } from './types';

export type BriefFetchResult =
    | { kind: 'ready'; brief: StoredBrief }
    | { kind: 'not_prepared' }
    | { kind: 'error'; message: string };

export async function fetchBrief(patientId: string): Promise<BriefFetchResult> {
    try {
        const res = await fetch(`/api/brief/${encodeURIComponent(patientId)}`);
        if (res.status === 404) {
            return { kind: 'not_prepared' };
        }
        if (!res.ok) {
            return { kind: 'error', message: `Brief request failed (HTTP ${res.status}).` };
        }
        return { kind: 'ready', brief: (await res.json()) as StoredBrief };
    } catch {
        return { kind: 'error', message: 'Could not reach the sidecar API.' };
    }
}

export type FactsFetchResult =
    | { kind: 'ready'; bundle: FactBundle }
    | { kind: 'error'; message: string };

export async function fetchFacts(patientId: string): Promise<FactsFetchResult> {
    try {
        const res = await fetch(`/api/facts/${encodeURIComponent(patientId)}`);
        if (res.status === 404) {
            return { kind: 'error', message: 'Patient is not registered in the sidecar.' };
        }
        if (!res.ok) {
            return { kind: 'error', message: `Fact bundle request failed (HTTP ${res.status}).` };
        }
        return { kind: 'ready', bundle: (await res.json()) as FactBundle };
    } catch {
        return { kind: 'error', message: 'Could not reach the sidecar API.' };
    }
}

/** POST /api/prep — returns true when the sidecar accepted the run (202). */
export async function startPrep(patientId: string): Promise<boolean> {
    try {
        const res = await fetch(`/api/prep/${encodeURIComponent(patientId)}`, { method: 'POST' });
        return res.status === 202;
    } catch {
        return false;
    }
}
