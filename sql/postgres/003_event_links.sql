BEGIN;

CREATE TABLE event_links (
    run_id UUID NOT NULL REFERENCES runs (run_id),
    source_event_id UUID NOT NULL,
    target_event_id UUID NOT NULL,
    relationship_type TEXT NOT NULL
        CHECK (relationship_type IN ('consumes_output', 'responds_to', 'retries')),
    PRIMARY KEY (source_event_id, target_event_id, relationship_type),
    CHECK (source_event_id <> target_event_id),
    FOREIGN KEY (run_id, source_event_id) REFERENCES events (run_id, event_id),
    FOREIGN KEY (run_id, target_event_id) REFERENCES events (run_id, event_id)
);

CREATE INDEX event_links_target_idx ON event_links (target_event_id);
CREATE INDEX event_links_run_idx ON event_links (run_id);

COMMENT ON TABLE event_links IS
    'Known dependencies, not inferred timestamp order. Source is the consuming/responding/retrying event; target is its antecedent. Insert after both events arrive. Cross-run links are rejected.';

COMMIT;
