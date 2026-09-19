BEGIN;

CREATE TABLE incident_clusters (
    cluster_id UUID PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES runs (run_id),
    fingerprint TEXT NOT NULL,
    signal TEXT NOT NULL,
    first_trigger_event_id UUID NOT NULL,
    latest_trigger_event_id UUID NOT NULL,
    first_triggered_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    last_triggered_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (run_id, fingerprint),
    FOREIGN KEY (run_id, first_trigger_event_id) REFERENCES events (run_id, event_id),
    FOREIGN KEY (run_id, latest_trigger_event_id) REFERENCES events (run_id, event_id)
);

CREATE TABLE incident_triggers (
    cluster_id UUID NOT NULL REFERENCES incident_clusters (cluster_id),
    run_id UUID NOT NULL REFERENCES runs (run_id),
    event_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (cluster_id, event_id),
    FOREIGN KEY (run_id, event_id) REFERENCES events (run_id, event_id)
);

CREATE TABLE investigation_jobs (
    job_id UUID PRIMARY KEY,
    cluster_id UUID NOT NULL REFERENCES incident_clusters (cluster_id),
    run_id UUID NOT NULL REFERENCES runs (run_id),
    trigger_event_id UUID NOT NULL,
    goal TEXT NOT NULL,
    signal TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'succeeded', 'dead_letter')),
    available_at TIMESTAMPTZ NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
    locked_by TEXT,
    lease_expires_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (cluster_id, generation),
    FOREIGN KEY (run_id, trigger_event_id) REFERENCES events (run_id, event_id)
);

CREATE INDEX investigation_jobs_claim_idx
    ON investigation_jobs (available_at, created_at)
    WHERE status = 'queued';
CREATE INDEX investigation_jobs_lease_idx
    ON investigation_jobs (lease_expires_at)
    WHERE status = 'running';

CREATE TABLE investigation_reports (
    investigation_id UUID NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    job_id UUID NOT NULL REFERENCES investigation_jobs (job_id),
    cluster_id UUID NOT NULL REFERENCES incident_clusters (cluster_id),
    run_id UUID NOT NULL REFERENCES runs (run_id),
    trigger_event_id UUID NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN (
        'UNRECOVERED_FAILURE', 'RECOVERED_FAILURE', 'NO_FAILURE', 'INSUFFICIENT_EVIDENCE'
    )),
    report JSONB NOT NULL CHECK (jsonb_typeof(report) = 'object'),
    model TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (investigation_id, revision),
    UNIQUE (job_id),
    FOREIGN KEY (run_id, trigger_event_id) REFERENCES events (run_id, event_id)
);

CREATE INDEX investigation_reports_run_idx
    ON investigation_reports (run_id, created_at DESC);

CREATE FUNCTION notify_investigation_job() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'queued' AND
       (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status OR
        OLD.available_at IS DISTINCT FROM NEW.available_at) THEN
        PERFORM pg_notify('investigation_jobs', NEW.job_id::text);
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER investigation_jobs_notify
    AFTER INSERT OR UPDATE ON investigation_jobs
    FOR EACH ROW EXECUTE FUNCTION notify_investigation_job();

CREATE FUNCTION notify_investigation_report() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('investigation_reports', NEW.investigation_id::text);
    RETURN NEW;
END;
$$;

CREATE TRIGGER investigation_reports_notify
    AFTER INSERT ON investigation_reports
    FOR EACH ROW EXECUTE FUNCTION notify_investigation_report();

COMMIT;
