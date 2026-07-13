// Ingestion-time evidence pinning (Wave C.6, REQ §4 Tier 0 — locked decision #4).
// When a document upload's extraction findings drive a retrieval at prep time, the
// resulting protocol chunks are PINNED against the patient: the in-visit chat loop can
// then cite them as a Tier-0 lookup (no live retrieval, no latency). Pins carry the
// ingestion id so every pinned chunk traces back to the document that motivated it.
import type { EvidenceSnippet } from '../retrieval/retriever.js';

export interface PinnedEvidence {
    patient_id: string;
    /** The ingestion whose extracted findings motivated this pin (provenance, G1). */
    ingestion_id: string;
    pinned_at: string;
    snippets: EvidenceSnippet[];
}

export interface PinnedEvidenceStore {
    save(pin: PinnedEvidence): Promise<void>;
    /** Newest first — the freshest document's protocols lead the bundle. */
    listFor(patientId: string): Promise<PinnedEvidence[]>;
}

/** In-memory store; the interface is the contract so a PG swap is invisible to the graph. */
export class MemoryPinnedEvidenceStore implements PinnedEvidenceStore {
    private readonly pins: PinnedEvidence[] = [];

    async save(pin: PinnedEvidence): Promise<void> {
        // Re-ingesting the same document replaces its pin — no duplicate evidence rides
        // the bundle (G1: no silent accumulation).
        const existing = this.pins.findIndex((entry) => entry.ingestion_id === pin.ingestion_id);
        if (existing >= 0) {
            this.pins.splice(existing, 1);
        }
        this.pins.push(pin);
    }

    async listFor(patientId: string): Promise<PinnedEvidence[]> {
        return this.pins
            .filter((pin) => pin.patient_id === patientId)
            .sort((a, b) => b.pinned_at.localeCompare(a.pinned_at));
    }
}
