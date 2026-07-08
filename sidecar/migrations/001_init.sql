-- 001_init.sql — Clinical Co-Pilot fact store (execution plan S1.6).
-- This store is a derived view of the EHR (ARCHITECTURE.md §2): wipeable and rebuildable
-- at any time, never a second source of truth. Lean scalar columns for identity/indexing;
-- jsonb for the payloads whose shapes the Zod schemas own at the boundary.

CREATE TABLE patients (
    id                 text PRIMARY KEY,
    openemr_patient_id text,
    name               text NOT NULL,
    demographics       jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE source_documents (
    id            text PRIMARY KEY,
    patient_id    text NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    document_type text NOT NULL,
    document_date date NOT NULL,
    content       jsonb NOT NULL,
    metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
    extras        jsonb NOT NULL DEFAULT '{}'::jsonb,
    inserted_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX source_documents_patient_idx ON source_documents (patient_id, document_date);

CREATE TABLE patient_facts (
    id                 text PRIMARY KEY,
    patient_id         text NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    fact_type          text NOT NULL,
    content            jsonb NOT NULL,
    is_current         boolean NOT NULL DEFAULT true,
    laterality         text,
    verification       jsonb NOT NULL DEFAULT '{"status": "unverified"}'::jsonb,
    source_document_id text NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
    sources            jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_date       text,
    updated_date       text,
    inserted_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX patient_facts_patient_idx ON patient_facts (patient_id);

CREATE INDEX patient_facts_fact_type_idx ON patient_facts (fact_type);

CREATE INDEX patient_facts_patient_current_idx ON patient_facts (patient_id, is_current);

CREATE TABLE contradictions (
    id          text PRIMARY KEY,
    patient_id  text NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    status      text NOT NULL DEFAULT 'active',
    severity    text NOT NULL,
    payload     jsonb NOT NULL,
    inserted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX contradictions_patient_idx ON contradictions (patient_id, status);

CREATE TABLE image_records (
    id                text PRIMARY KEY,
    patient_id        text NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    capture_date      timestamptz NOT NULL,
    modality          text NOT NULL,
    laterality        text NOT NULL,
    storage_key       text,
    image_metadata    jsonb NOT NULL,
    ai_analysis       jsonb,
    treatment_context jsonb,
    extras            jsonb NOT NULL DEFAULT '{}'::jsonb,
    inserted_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX image_records_patient_idx ON image_records (patient_id, capture_date);

CREATE TABLE treatments (
    id             text PRIMARY KEY,
    patient_id     text NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    treatment_date date NOT NULL,
    payload        jsonb NOT NULL,
    inserted_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX treatments_patient_idx ON treatments (patient_id, treatment_date);

CREATE TABLE briefs (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id     text NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    prepared_at    timestamptz NOT NULL DEFAULT now(),
    correlation_id text NOT NULL,
    content        jsonb NOT NULL,
    status         text NOT NULL DEFAULT 'complete'
);

CREATE INDEX briefs_patient_idx ON briefs (patient_id, status, prepared_at DESC);

-- Operational log of prep-pipeline runs. Intentionally NOT FK-bound to patients: a run can
-- start before registration, and the audit trail must survive wipePatient/wipeAll rebuilds.
CREATE TABLE prep_runs (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id     text NOT NULL,
    correlation_id text NOT NULL,
    started_at     timestamptz NOT NULL DEFAULT now(),
    finished_at    timestamptz,
    status         text NOT NULL DEFAULT 'running',
    error          text
);

CREATE INDEX prep_runs_patient_idx ON prep_runs (patient_id, started_at DESC);
