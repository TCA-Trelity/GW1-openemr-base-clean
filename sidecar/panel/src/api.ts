// Typed fetch client for the sidecar endpoints. Deterministic reads (patients, overview,
// facts) back the instant landing; brief/prep/prep-runs back the async AI insights card,
// whose caller owns the polling loop.
import type { FactBundle, OverviewPayload, PatientRecord, PrepRunRecord, StoredBrief } from './types';

const UNREACHABLE = 'Could not reach the sidecar API.';

export type PatientsFetchResult =
    | { kind: 'ready'; patients: PatientRecord[] }
    | { kind: 'error'; message: string };

/** GET /api/patients — the day schedule behind the sidebar. */
export async function fetchPatients(): Promise<PatientsFetchResult> {
    try {
        const res = await fetch('/api/patients');
        if (!res.ok) {
            return { kind: 'error', message: `Patient list request failed (HTTP ${res.status}).` };
        }
        const body = (await res.json()) as { patients: PatientRecord[] };
        return { kind: 'ready', patients: body.patients };
    } catch {
        return { kind: 'error', message: UNREACHABLE };
    }
}

export type OverviewFetchResult =
    | { kind: 'ready'; overview: OverviewPayload }
    | { kind: 'error'; message: string };

/** GET /api/overview — the deterministic landing payload (no LLM in this path). */
export async function fetchOverview(patientId: string): Promise<OverviewFetchResult> {
    try {
        const res = await fetch(`/api/overview/${encodeURIComponent(patientId)}`);
        if (res.status === 404) {
            return { kind: 'error', message: 'Patient is not registered in the sidecar.' };
        }
        if (!res.ok) {
            return { kind: 'error', message: `Overview request failed (HTTP ${res.status}).` };
        }
        return { kind: 'ready', overview: (await res.json()) as OverviewPayload };
    } catch {
        return { kind: 'error', message: UNREACHABLE };
    }
}

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
        return { kind: 'error', message: UNREACHABLE };
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
        return { kind: 'error', message: UNREACHABLE };
    }
}

export type PrepStartResult =
    | { kind: 'accepted' }
    | { kind: 'reused' }
    | { kind: 'rejected'; message: string }
    | { kind: 'error'; message: string };

/** POST /api/prep — 202 accepted/already_running, 200 fresh-brief reuse, 429 guard rejections. */
export async function startPrep(patientId: string): Promise<PrepStartResult> {
    try {
        const res = await fetch(`/api/prep/${encodeURIComponent(patientId)}`, { method: 'POST' });
        if (res.status === 202) {
            return { kind: 'accepted' };
        }
        if (res.status === 200) {
            return { kind: 'reused' };
        }
        if (res.status === 429) {
            const body = (await res.json().catch(() => ({}))) as { error?: string };
            return {
                kind: 'rejected',
                message:
                    body.error === 'llm_budget_exceeded'
                        ? 'The AI budget for today is exhausted — try again tomorrow.'
                        : 'The AI pipeline is busy — try again in a moment.',
            };
        }
        return { kind: 'error', message: `Preparation request failed (HTTP ${res.status}).` };
    } catch {
        return { kind: 'error', message: UNREACHABLE };
    }
}

export type PrepRunsFetchResult =
    | { kind: 'ready'; runs: PrepRunRecord[] }
    | { kind: 'error'; message: string };

/** GET /api/prep-runs — newest-first run history with live stage progress. */
export async function fetchPrepRuns(patientId: string): Promise<PrepRunsFetchResult> {
    try {
        const res = await fetch(`/api/prep-runs/${encodeURIComponent(patientId)}`);
        if (!res.ok) {
            return { kind: 'error', message: `Prep-run request failed (HTTP ${res.status}).` };
        }
        const body = (await res.json()) as { runs: PrepRunRecord[] };
        return { kind: 'ready', runs: body.runs };
    } catch {
        return { kind: 'error', message: UNREACHABLE };
    }
}
