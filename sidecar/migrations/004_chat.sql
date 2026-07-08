-- Chat persistence (S2.3): one row per turn. Conversations are per patient; the panel
-- groups by conversation_id. Operational table like prep_runs — survives corpus wipes.
CREATE TABLE chat_messages (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id      text NOT NULL,
    conversation_id text NOT NULL,
    role            text NOT NULL CHECK (role IN ('user', 'assistant')),
    content         text NOT NULL,
    correlation_id  text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX chat_messages_conversation_idx ON chat_messages (patient_id, conversation_id, created_at);
