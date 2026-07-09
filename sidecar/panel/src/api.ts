// Typed fetch client for the sidecar endpoints. Deterministic reads (patients, overview,
// facts) back the instant landing; brief/prep/prep-runs back the async AI insights card;
// chat streams SSE over fetch (EventSource cannot POST) for the S2.3 drawer.
import type { ChatCitation, FactBundle, OverviewPayload, PatientRecord, PrepRunRecord, StoredBrief } from './types';

const UNREACHABLE = 'Could not reach the sidecar API.';

// ---- Auth (Wave AZ) ----
// The panel holds one bearer token (a sidecar dev token in the demo, or a SMART launch token in
// production) and attaches it to every sidecar call through apiFetch. All request functions below
// go through apiFetch, so this is the single place the Authorization header is added.

export type ClinicalRole = 'physician' | 'nurse' | 'resident';

export interface AuthCapabilities {
    read: boolean;
    triggerPrep: boolean;
    verify: 'full' | 'needs_attending_sign_off' | false;
}

export interface MeResult {
    authenticated: boolean;
    user?: string;
    patient?: string | null;
    role?: ClinicalRole;
    token_type?: 'smart' | 'dev';
    capabilities?: AuthCapabilities;
}

let authToken: string | null = null;

/** Set (or clear) the bearer sent on every sidecar call. Cleared by passing null. */
export function setAuthToken(token: string | null): void {
    authToken = token;
}

/** fetch + the current bearer. The only network entry point for the functions below. */
function apiFetch(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    if (authToken !== null) {
        headers.set('Authorization', `Bearer ${authToken}`);
    }
    return fetch(path, { ...init, headers });
}

export type DevLoginResult = { ok: true; token: string } | { ok: false; disabled: boolean };

/**
 * Mint a demo dev token bound to (role, patient). patient may be null for a provider-scope token
 * that can see the schedule but no chart. Returns { ok:false, disabled:true } when dev-login is
 * turned off (404) — the caller then runs tokenless, which is correct in AUTH_MODE=off.
 */
export async function devLogin(role: ClinicalRole, patient: string | null): Promise<DevLoginResult> {
    try {
        const res = await fetch('/api/dev-login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patient === null ? { role } : { role, patient }),
        });
        if (res.status === 404) {
            return { ok: false, disabled: true };
        }
        if (!res.ok) {
            return { ok: false, disabled: false };
        }
        const body = (await res.json()) as { access_token?: string };
        return typeof body.access_token === 'string' ? { ok: true, token: body.access_token } : { ok: false, disabled: false };
    } catch {
        return { ok: false, disabled: false };
    }
}

/** The current principal + its capabilities, or null when unavailable. */
export async function fetchMe(): Promise<MeResult | null> {
    try {
        const res = await apiFetch('/api/me');
        if (!res.ok) {
            return null;
        }
        return (await res.json()) as MeResult;
    } catch {
        return null;
    }
}

export type VerifyFactResult = { ok: true; needsAttending: boolean } | { ok: false; status: number };

/** Record a clinician's verification of a fact (S3.3). Role/patient-binding is enforced server-side. */
export async function verifyFact(patientId: string, factId: string): Promise<VerifyFactResult> {
    try {
        const res = await apiFetch(`/api/facts/${encodeURIComponent(patientId)}/${encodeURIComponent(factId)}/verify`, {
            method: 'POST',
        });
        if (!res.ok) {
            return { ok: false, status: res.status };
        }
        const body = (await res.json()) as { needs_attending_sign_off?: boolean };
        return { ok: true, needsAttending: body.needs_attending_sign_off === true };
    } catch {
        return { ok: false, status: 0 };
    }
}

export type PatientsFetchResult =
    | { kind: 'ready'; patients: PatientRecord[] }
    | { kind: 'error'; message: string };

/** GET /api/patients — the day schedule behind the sidebar. */
export async function fetchPatients(): Promise<PatientsFetchResult> {
    try {
        const res = await apiFetch('/api/patients');
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
        const res = await apiFetch(`/api/overview/${encodeURIComponent(patientId)}`);
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
        const res = await apiFetch(`/api/brief/${encodeURIComponent(patientId)}`);
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
        const res = await apiFetch(`/api/facts/${encodeURIComponent(patientId)}`);
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

export type EhrSyncFetchResult =
    | { kind: 'synced'; factCount: number; resourceCounts: Record<string, number>; syncedAt: string }
    /** 409 not_linked_to_openemr — the patient has no OpenEMR chart to pull from yet. */
    | { kind: 'not_linked' }
    /** 409 patient_not_found — the sidecar has no such patient. */
    | { kind: 'patient_not_found' }
    /** 503 ehr_sync_not_configured — no read client on this deployment. */
    | { kind: 'not_configured' }
    | { kind: 'error'; message: string };

/**
 * POST /api/ehr-sync/:patientId — a live FHIR R4 pull that rewrites the EHR snapshot. Kept
 * synchronous server-side (a handful of small reads). The caller refetches overview + facts
 * on success; 409/503 map to explicit reasons the tab renders as small inline messages.
 */
export async function syncEhr(patientId: string): Promise<EhrSyncFetchResult> {
    try {
        const res = await apiFetch(`/api/ehr-sync/${encodeURIComponent(patientId)}`, { method: 'POST' });
        if (res.status === 503) {
            return { kind: 'not_configured' };
        }
        if (res.status === 409) {
            const body = (await res.json().catch(() => ({}))) as { reason?: string };
            return body.reason === 'patient_not_found' ? { kind: 'patient_not_found' } : { kind: 'not_linked' };
        }
        if (!res.ok) {
            return { kind: 'error', message: `EHR sync failed (HTTP ${res.status}).` };
        }
        const body = (await res.json()) as { factCount?: number; resourceCounts?: Record<string, number>; syncedAt?: string };
        return {
            kind: 'synced',
            factCount: typeof body.factCount === 'number' ? body.factCount : 0,
            resourceCounts: body.resourceCounts ?? {},
            syncedAt: typeof body.syncedAt === 'string' ? body.syncedAt : '',
        };
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
        const res = await apiFetch(`/api/prep/${encodeURIComponent(patientId)}`, { method: 'POST' });
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

// ---- Chat (routes/chat.ts) ----

export interface ChatHistoryMessage {
    role: 'user' | 'assistant';
    content: string;
    created_at: string;
}

export type ChatHistoryFetchResult =
    | { kind: 'ready'; conversationId: string; messages: ChatHistoryMessage[] }
    | { kind: 'error'; message: string };

/** GET /api/chat — oldest-first replay of a stored conversation. */
export async function fetchChatHistory(patientId: string, conversationId: string): Promise<ChatHistoryFetchResult> {
    try {
        const res = await apiFetch(
            `/api/chat/${encodeURIComponent(patientId)}?conversation_id=${encodeURIComponent(conversationId)}`,
        );
        if (!res.ok) {
            return { kind: 'error', message: `Chat history request failed (HTTP ${res.status}).` };
        }
        const body = (await res.json()) as { conversation_id: string; messages: ChatHistoryMessage[] };
        return { kind: 'ready', conversationId: body.conversation_id, messages: body.messages };
    } catch {
        return { kind: 'error', message: UNREACHABLE };
    }
}

/** The done event's payload — citations were re-verified server-side against the stored documents. */
export interface ChatStreamDone {
    conversationId: string;
    citations: ChatCitation[];
    unverifiedCount: number;
    /** Names of the tools the model invoked this turn (TC3) — [] when it answered from the bundle. */
    toolsUsed: string[];
}

/** A `tool_use` stream event (TC3): the model invoked a read-only, patient-scoped tool. */
export interface ChatToolUse {
    name: string;
    input: Record<string, unknown>;
}

/** A `tool_result` stream event (TC3): that tool returned; `ok` is false on a structured error. */
export interface ChatToolResult {
    name: string;
    ok: boolean;
}

export type ChatSendResult =
    | { kind: 'done'; done: ChatStreamDone }
    /** An in-stream `{type:'error'}` event, or the stream cut before the done event. */
    | { kind: 'stream_error' }
    /** A pre-stream guard answered with plain JSON (400/404/429/503). */
    | { kind: 'rejected'; message: string }
    | { kind: 'error'; message: string };

function guardMessage(status: number): string {
    if (status === 429) {
        return 'Daily AI budget reached — try tomorrow';
    }
    if (status === 404) {
        return 'Patient is not registered in the sidecar.';
    }
    if (status === 400) {
        return 'Message rejected — it must be 1 to 2000 characters.';
    }
    if (status === 503) {
        return 'Chat is unavailable — the sidecar store is not configured.';
    }
    return `Chat request failed (HTTP ${status}).`;
}

/** One `data: {...}` SSE line -> its parsed JSON object, else null (keep-alive noise etc.). */
function parseSseLine(line: string): Record<string, unknown> | null {
    if (!line.startsWith('data:')) {
        return null;
    }
    try {
        const parsed: unknown = JSON.parse(line.slice(5).trim());
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

/** Narrow one wire citation object into a ChatCitation, else null (malformed events are dropped). */
function parseChatCitation(value: unknown): ChatCitation | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const { document_id, document_title, cited_text, start_char, end_char, verified } = record;
    if (
        typeof document_id !== 'string' ||
        typeof document_title !== 'string' ||
        typeof cited_text !== 'string' ||
        typeof start_char !== 'number' ||
        typeof end_char !== 'number' ||
        typeof verified !== 'boolean'
    ) {
        return null;
    }
    return { document_id, document_title, cited_text, start_char, end_char, verified };
}

function chatCitationArray(value: unknown): ChatCitation[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.flatMap((item) => {
        const citation = parseChatCitation(item);
        return citation === null ? [] : [citation];
    });
}

function stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * POST /api/chat — the reply streams as SSE over fetch + getReader (the sidecar's own
 * client in src/prep/anthropic.ts is the parsing reference). Guards answer as plain
 * JSON before the stream opens; after it opens, only delta/citation/done/error events
 * remain. The text is clean prose — provenance rides the citation events, which arrive
 * already server-verified, then the done event repeats the full list authoritatively.
 */
export async function sendChatMessage(
    patientId: string,
    message: string,
    conversationId: string | null,
    onDelta: (text: string) => void,
    onCitation: (citation: ChatCitation) => void,
    onToolUse?: (tool: ChatToolUse) => void,
    onToolResult?: (tool: ChatToolResult) => void,
): Promise<ChatSendResult> {
    let res: Response;
    try {
        res = await apiFetch(`/api/chat/${encodeURIComponent(patientId)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(conversationId !== null ? { message, conversation_id: conversationId } : { message }),
        });
    } catch {
        return { kind: 'error', message: UNREACHABLE };
    }
    if (!res.ok) {
        return { kind: 'rejected', message: guardMessage(res.status) };
    }
    if (res.body === null) {
        return { kind: 'stream_error' };
    }
    let done: ChatStreamDone | null = null;
    let failed = false;
    const handleLine = (line: string): void => {
        const event = parseSseLine(line);
        if (event === null) {
            return;
        }
        if (event.type === 'delta' && typeof event.text === 'string') {
            onDelta(event.text);
        } else if (event.type === 'citation') {
            const citation = parseChatCitation(event.citation);
            if (citation !== null) {
                onCitation(citation);
            }
        } else if (event.type === 'tool_use' && typeof event.name === 'string') {
            // A read-only, patient-scoped tool the model chose to run (TC3). input may be
            // absent/malformed on the wire — normalize to an object the strip can read.
            const input =
                typeof event.input === 'object' && event.input !== null && !Array.isArray(event.input)
                    ? (event.input as Record<string, unknown>)
                    : {};
            onToolUse?.({ name: event.name, input });
        } else if (event.type === 'tool_result' && typeof event.name === 'string') {
            onToolResult?.({ name: event.name, ok: event.ok === true });
        } else if (event.type === 'done' && typeof event.conversation_id === 'string') {
            done = {
                conversationId: event.conversation_id,
                citations: chatCitationArray(event.citations),
                unverifiedCount: typeof event.unverified_count === 'number' ? event.unverified_count : 0,
                toolsUsed: stringArray(event.tools_used),
            };
        } else if (event.type === 'error') {
            failed = true;
        }
    };
    try {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) {
                break;
            }
            buffer += decoder.decode(chunk.value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                handleLine(line);
            }
        }
        handleLine(buffer);
    } catch {
        return { kind: 'stream_error' };
    }
    if (failed || done === null) {
        return { kind: 'stream_error' };
    }
    return { kind: 'done', done };
}

/** GET /api/prep-runs — newest-first run history with live stage progress. */
export async function fetchPrepRuns(patientId: string): Promise<PrepRunsFetchResult> {
    try {
        const res = await apiFetch(`/api/prep-runs/${encodeURIComponent(patientId)}`);
        if (!res.ok) {
            return { kind: 'error', message: `Prep-run request failed (HTTP ${res.status}).` };
        }
        const body = (await res.json()) as { runs: PrepRunRecord[] };
        return { kind: 'ready', runs: body.runs };
    } catch {
        return { kind: 'error', message: UNREACHABLE };
    }
}
