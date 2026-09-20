BEGIN;

CREATE TABLE search_index_outbox (
    outbox_id BIGSERIAL PRIMARY KEY,
    document_kind TEXT NOT NULL CHECK (document_kind IN ('event', 'investigation')),
    document_id TEXT NOT NULL,
    run_id UUID NOT NULL REFERENCES runs (run_id),
    payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'completed')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    available_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    locked_by TEXT,
    lease_expires_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (document_kind, document_id)
);

CREATE INDEX search_index_outbox_claim_idx
    ON search_index_outbox (available_at, outbox_id)
    WHERE status = 'queued';
CREATE INDEX search_index_outbox_lease_idx
    ON search_index_outbox (lease_expires_at)
    WHERE status = 'running';

COMMIT;
