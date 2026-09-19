BEGIN;

CREATE TABLE artifacts (
    artifact_id UUID PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES runs (run_id),
    agent_execution_id UUID,
    kind TEXT NOT NULL CHECK (length(trim(kind)) > 0),
    mime_type TEXT NOT NULL CHECK (length(trim(mime_type)) > 0),
    byte_size BIGINT NOT NULL CHECK (byte_size >= 0),
    sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    storage_path TEXT NOT NULL,
    availability TEXT NOT NULL DEFAULT 'available'
        CHECK (availability IN ('available', 'missing', 'corrupt')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (run_id, agent_execution_id)
        REFERENCES agent_executions (run_id, agent_execution_id)
);

CREATE INDEX artifacts_run_idx ON artifacts (run_id, created_at, artifact_id);

COMMIT;
