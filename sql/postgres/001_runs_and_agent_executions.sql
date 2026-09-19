-- Apply once, in filename order. This schema is separate from the SQLite runtime.
BEGIN;

CREATE TABLE runs (
    run_id UUID PRIMARY KEY,
    goal TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE agent_executions (
    agent_execution_id UUID PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES runs (run_id),
    agent_id TEXT NOT NULL,
    assigned_task TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (run_id, agent_execution_id)
);

COMMENT ON COLUMN agent_executions.agent_id IS
    'Logical agent identity; each restart or new execution gets a new agent_execution_id.';

COMMIT;
