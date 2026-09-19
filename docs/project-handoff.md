# Multi-agent observability: project brief and subsystem handoff

Date: September 19, 2026

## Scope and status of this document

This document captures the product and architecture discussed by the team. It is
a design handoff for members taking ownership of separate subsystems. Proposed
APIs, event names, worker behavior, and acceptance criteria below are design
contracts, not claims that these capabilities are already implemented.

**The existing uncommitted observer-related implementation is deliberately excluded.**
This document does not describe, depend on, or ask teammates to copy that work.
The observer sections describe the agreed conceptual design from the discussion.
Before branching, establish a shared committed baseline; do not assume another
member's working-tree changes will be available in your branch.

The committed PostgreSQL schema files are concrete handoff artifacts:

- `sql/postgres/001_runs_and_agent_executions.sql`
- `sql/postgres/002_events.sql`
- `sql/postgres/003_event_links.sql`

These files create a standalone proposed schema. They do not establish that the
application has been connected to PostgreSQL or that existing data has been migrated.
Database/runtime integration is an explicit work item.

## Project brief

Build an investigation layer for multi-agent workflows. A lightweight SDK captures
execution evidence from existing agents, tools, and applications. A separate
observer reads that evidence, follows dependencies across agents, and produces
reports explaining observed failures and likely causes with inspectable references.

The intended developer experience is:

> Run your existing agents. When something goes wrong, see the relevant tool calls,
> handoffs, errors, artifacts, and external traces together, with an explanation of
> what the evidence supports and what remains unknown.

The product should work across browser QA, long-running research, code refactoring,
and other workflows. Concurrent agents make investigation harder and increase the
value of the system, but concurrency is not a requirement: one long-running agent
should also be observable.

The initial demonstration uses agents navigating a web store that we control.
Browser sessions make execution visible, and a controlled site lets us introduce
repeatable failures. QA is the demonstration workflow, not a dependency of the
observability architecture.

## Why this project exists

An agent may fail visibly with an exception, silently produce a wrong result, or
pass incorrect information to another agent. Several agents can individually report
success while the overall goal fails. Reading disconnected logs makes it difficult
to identify the first relevant mistake and how it propagated.

The central questions are:

1. What was the workflow trying to accomplish?
2. What did each agent observe, request, and receive?
3. What information crossed agent boundaries?
4. What changed in the application or environment?
5. Which outcome checks failed, and did later actions recover?
6. Which explanation is supported by evidence, and which parts are hypotheses?

The primary value is reducing time to a correct diagnosis. A browser wall is a
useful demonstration and navigation surface, but developers should not need to
watch dozens of sessions to understand an incident.

## Product evolution and decisions

- Early examples included refunds and replacements, procurement, travel,
  onboarding/offboarding, invoice processing, incident response, and QA. These
  illustrated meaningful consequences and shared-state failures; they are not
  separate MVP features.
- Browser QA became the concrete demo: agents navigate the site, one encounters a
  faulty route, and an observer assembles debugging evidence.
- The team reported positive feedback from Sentry sponsors on that demo. This is
  useful direction for the hackathon, not proof of general market demand.
- The core architecture was explicitly broadened again: the observer must remain
  independent of QA and browser execution.
- The product consists of an SDK, evidence backend, observer service, and web GUI.
  A CLI is optional convenience; a TUI is deferred.
- The observer does not emit or modify the workflow's execution logs. Its reports
  are separate derived records referencing original evidence.
- Classical ML classification is not required for the MVP.
- Training-data creation is a possible future use of reviewed traces and corrected
  outcomes, not an implemented or essential first-release feature.

## Differentiation and limits

Code coverage answers which code executed. Assertions test expected behavior.
Execution traces reconstruct actions and state. This project aims to connect those
records across agents and external systems, then assist investigation.

Browser replay, agent traces, and graph visualization already exist in other tools.
The project should build on these capabilities. Its hypothesis is that automatically
assembling relevant evidence and explaining cross-agent failures saves developers
work beyond a conventional trace viewer.

Do not promise a complete reconstruction of hidden model reasoning. Capture
instructions, observable model outputs, tool calls, results, handoffs, and checks.
An agent's explanation is an attributed output, not privileged access to why its
model acted.

Likewise, a generic observer cannot know every domain's definition of success.
Instrumentation supplies what happened; task contracts and domain checks supply
what should have happened. A successful HTTP response or an agent saying “done” is
not sufficient proof of task success.

## Architecture and boundaries

```text
Existing workflow / orchestrator
  ├─ Agent A → tools / MCP clients
  ├─ Agent B → tools / MCP clients
  └─ Agent C → tools / MCP clients
                │
         SDK / framework adapters
                │ structured events + artifacts + external references
                ▼
       Ingestion API and evidence store
                │
       Detection and investigation queue
                │
       Observer with read-only evidence tools
                │
       Separate investigation/report store
                │
       Web dashboard and evidence viewer
```

### Workflow and execution layer

The workflow owns task decomposition, agent prompts, scheduling, concurrency,
actual handoffs, tool execution, retries, and external side effects. The SDK records
these activities without becoming the orchestrator.

For the demo, Browserbase supplies browser sessions. Our agent code controls the
browsers through tools. A browser grid can show separate sessions like panes in
tmux. The observer is not responsible for operating those browsers.

### SDK and adapters

The SDK captures common execution details around tool/model calls and accepts
explicit domain events from application code. A framework adapter may automate
capture, but the first version can use explicit wrappers.

Conceptual interface:

```text
start_run(goal, constraints?)
register_agent_execution(run_id, agent_id, assigned_task)
emit_event(identity, event_type, metadata)
record_tool_call(arguments, result/error, timing)
record_event_link(source, target, relationship)
attach_artifact(content_or_reference)
finish_execution(outcome)
```

Recording a handoff must not require the SDK to perform that handoff. Existing
orchestrators must remain usable without our CLI.

### Ingestion and evidence backend

The backend validates event envelopes, preserves attribution, stores evidence,
supports scoped queries, and resolves external references. It must accept retries
and late arrivals without silently rewriting history.

Use structured database records for searchable fields and relationships. Use object
storage or another artifact store for large payloads, screenshots, DOM snapshots,
documents, diffs, and recordings. Storing only blob links in the database would make
ordinary queries require downloading and parsing every log bundle.

### Observer

The observer is a separate investigator. It receives a trigger, retrieves relevant
evidence, follows dependencies, considers recovery and alternative explanations,
and generates a structured report. It does not launch or alter the observed work.

### User interface

Three initial views are sufficient:

1. Runs: goal, agent count, state, and detected incidents.
2. Run details: agents, relationships, event timeline, and artifacts.
3. Investigation details: observed failure, likely explanation, evidence citations,
   affected executions, uncertainty, and suggested debugging steps.

Browser panes and replay are optional artifact-specific views. Research workflows
show sources and citations; coding workflows show diffs, commands, and test output.

## Telemetry vocabulary

| Term | Meaning |
| --- | --- |
| Run | One overall goal spanning one or more agent executions |
| Agent | Logical role or identity, reusable across executions |
| Agent execution | A specific invocation of an agent; restart means a new execution |
| Session | External context such as a Browserbase session; not the run itself |
| Event | A structured record of one occurrence |
| Log | A diagnostic message, ideally correlated with structured event identity |
| Span | An operation P{PPawith duration, such as a tool call |
| Trace | Related operations spanning execution boundaries |
| Event link | An explicitly recorded dependency between events |
| Artifact | Large or specialized evidence referenced by an event |
| Metric | Numeric measurement such as latency, cost, or error count |
| Investigation | Derived interpretation referencing recorded evidence |

Proposed event names include `agent.started`, `tool.started`, `tool.completed`,
`tool.failed`, `artifact.created`, `handoff.sent`, `check.completed`, `check.failed`,
and `agent.completed`. The SQL permits extensible event types. Finalize a small
versioned catalog with the SDK and backend owners before independent implementation.

## Where metadata comes from

Metadata is an event-specific JSON object. It is not invented by the observer.

| Producer | Typical metadata |
| --- | --- |
| SDK wrapper | Tool name, arguments, result reference, duration, error |
| Application code | Validation check name, expected outcome, actual outcome |
| Executing agent | Assessment, produced artifact, or stated conclusion, clearly attributed |

For example, application code can pass this payload after a verification step:

```json
{
  "check": "supplier_exists",
  "supplier": "Example Batteries",
  "result": "unverified",
  "assessment_source": "agent",
  "explanation": "No supporting source found",
  "artifact_id": "shortlist_01"
}
```

The SDK adds the event envelope: IDs, timestamps, execution identity, and type.
“No supporting source found” establishes an unverified claim, not proof that a
supplier does not exist.

A tool wrapper should emit a start event, execute the real call, record its result
or exception, and preserve the original return/exception behavior. Redact secrets
before persistence. Large results should become artifact references.

For MCP calls, record the server/tool identity, request identity, sanitized
arguments, result or error, timing, and attempt information at the instrumented
client boundary. MCP traffic is not automatically visible without integration.

## Database contract

The committed migrations define four tables: `runs`, `agent_executions`, `events`,
and `event_links`. Artifact and investigation storage remain separate design work.

### Runs and agent executions

`runs`: `run_id UUID` primary key, `goal TEXT`, and `created_at TIMESTAMPTZ`.

`agent_executions`: `agent_execution_id UUID` primary key, `run_id UUID`,
`agent_id TEXT`, optional `assigned_task TEXT`, and `created_at TIMESTAMPTZ`.
The composite unique key `(run_id, agent_execution_id)` supports enforcement of
consistent run membership on events.

### Events

| Column | Type | Meaning |
| --- | --- | --- |
| `event_id` | UUID primary key | Producer-generated identity, stable across delivery retries |
| `run_id` | UUID, required | Overall workflow |
| `agent_execution_id` | UUID, required | Owning execution |
| `session_id` | TEXT, optional | External session reference |
| `occurred_at` | TIMESTAMPTZ, required | Producer's event time |
| `ingested_at` | TIMESTAMPTZ, server default | Database receipt time |
| `sequence_number` | BIGINT, required | Nonnegative local execution sequence |
| `event_type` | TEXT, required | Nonempty event name |
| `trace_id` | TEXT, optional | External trace correlation |
| `span_id` | TEXT, optional | Operation correlation |
| `parent_span_id` | TEXT, optional | Enclosing operation |
| `metadata` | JSONB, object, default `{}` | Event-specific evidence |
| `schema_version` | INTEGER, positive, default 1 | Event schema version |

Constraints and indexes:

- Composite foreign key ensures the execution belongs to the stated run.
- `(agent_execution_id, sequence_number)` is unique.
- Indexes support run/time, run/event type, and trace/span retrieval.
- An update trigger rejects changes to event rows. It does not itself prohibit
  deletion; database permissions and explicit retention policies must govern that.
- Parent spans have no foreign key because external telemetry may arrive later or
  never arrive.

Create runs and agent executions before inserting events. Producer IDs and local
sequence numbers must remain stable on redelivery. Identical retries can use
`ON CONFLICT (event_id) DO NOTHING`; the ingestion layer must detect ID reuse with
different contents rather than silently accept it.

### Event relationships

`event_links` contains `run_id`, `source_event_id`, `target_event_id`, and
`relationship_type`. Supported types in the current SQL are `consumes_output`,
`responds_to`, and `retries`.

**Direction matters:** the source is the consuming/responding/retrying event; the
target is the earlier evidence or attempt on which it depends. Both endpoints must
belong to the same run. Self-links are rejected. Insert links after both events
exist; ingestion should queue or retry unresolved links.

A single `prev_event` field is insufficient because an event can consume outputs
from several agents. Local sequence represents order; dependency links represent
known relationships. Temporal adjacency alone does not prove causality.

### Remaining persistence work

- Artifact records: ownership, kind, content location, MIME type, size, digest,
  availability state, and correlation references.
- Investigations: trigger, status, report, cited events, affected executions, and
  observer/model version. These are proposed fields, not existing migrations.
- Reliable investigation jobs, trigger deduplication, retries, and checkpoints.
- Workflow task constraints and outcome checks beyond the minimal `goal` field.
- Runtime database integration and any data migration strategy.

Do not use occurrence time or the greatest producer sequence as a global polling
cursor. Concurrent transactions and delayed delivery can make naive polling miss
events. Use durable ingestion-to-job delivery, such as a transactional outbox,
or another explicitly tested delivery/checkpoint mechanism.

## Observer execution design

### Detection

Start with deterministic signals: tool failures, explicit failed checks, deadlines,
missing completion, repeated failures, and exceeded budgets. The workflow should
supply semantic success checks. A failed tool call alone does not mean the run
failed; retries may recover.

Also support explicit user investigation and run-completion review. Periodic review
of long-running work is optional and should operate over bounded new evidence.

### Investigation

Create a job with a run ID, trigger event ID, goal, and signal. Give the observer a
compact summary and nearby evidence first, not all logs from all agents.

Proposed read-only tools:

```text
get_run_summary(run_id)
get_agent_events(agent_execution_id, before, after, limit)
get_event(event_id)
get_related_events(event_id)
read_artifact(artifact_id, offset, limit)
get_sentry_trace(trace_id)
```

Backend code enforces run scope, permissions, payload limits, and budgets. The
observer chooses what evidence to retrieve. It should inspect upstream handoffs,
downstream effects, and recovery before deciding the incident's significance.

Treat retrieved webpages, tool output, and logs as untrusted evidence, never as
instructions to change the observer's task or disclose credentials.

### Reporting

A report should include:

- Observed failure or an explicit recovered/no-failure/insufficient-evidence outcome.
- Earliest relevant evidence available, without claiming access to missing history.
- Likely cause, separated from directly observed facts.
- Evidence event IDs and artifact/external links.
- Affected agent executions and known downstream effects.
- Missing evidence and unresolved alternatives.
- Suggested next debugging or verification step.

Validate output structure and citation existence/run membership in application code.
Valid citations do not establish that the narrative is true; evaluate whether the
referenced evidence actually supports it. Avoid treating model confidence as a
calibrated probability.

Store conclusions separately from source events. Any operational telemetry for the
observer itself must stay outside the workflow evidence it analyzes.

### Cost and reliability

Deduplicate related triggers, limit concurrent investigations, bound tool calls and
tokens, and retry transient failures. A broken route generating 100 errors should
not automatically launch 100 independent investigations. Failed or unavailable
external integrations should produce explicit evidence gaps.

## Classical ML and evaluation

No model training is necessary for the MVP. Use rules for detection and an existing
LLM with evidence tools for investigation.

Later, supervised classifiers may route known incident categories, anomaly
detection may flag unusual latency/cost/action patterns, and clustering may group
duplicate incidents. These require useful data and evaluation. Classification
does not prove root cause and cannot replace evidence-backed investigation.

Build a small evaluation set containing known failures, clean runs, recovered
errors, agent mistakes, application defects, and deliberately incomplete evidence.
Keep injected ground-truth labels out of the observer's input.

Measure correct diagnosis, false accusations, evidence support, useful handling of
uncertainty, investigation cost/latency, and developer time to diagnosis. A fluent
report or many citations alone is not a success criterion.

## Sentry and Browserbase integration

Sentry can contribute application exceptions, traces, and replay references.
Browserbase supplies session identity and browser viewing/recording capabilities.
The integration owner must preserve correlation between run, execution, browser
session, tool calls, and external telemetry.

Session replay is not a universal recording of every external website. Instrument
our controlled demo site for Sentry replay. For external sites, use the browser
provider's supported recording mechanism and correlate it with execution events.
Validate current APIs, project configuration, and access permissions during build.

Providing a replay link is different from the observer analyzing video. The first
version can use structured evidence for diagnosis and offer replay for human
verification. Do not claim visual analysis unless it is actually implemented.

Reference capabilities discussed during planning:

- [Browserbase observability](https://www.browserbase.com/observability)
- [Browserbase session replay](https://www.browserbase.com/blog/session-replay)
- [Sentry agent monitoring](https://sentry.io/changelog/ai-agent-monitoring--open-beta/)
- [Sentry conversation views](https://sentry.io/changelog/conversations-beta/)
- [Langfuse agent graphs](https://langfuse.com/docs/observability/features/agent-graphs)

These establish context and existing overlap, not a pinned implementation contract.

## Demonstration plan

1. Enter a goal and controlled web-store URL.
2. Start several agents on distinct journeys and show live browser panes.
3. Let one agent encounter an injected faulty route while others continue.
4. Record the failed action, request/result, relevant application error, and identity.
5. Trigger an observer investigation automatically.
6. Show a report with reproduction steps and citations into the original evidence.
7. Open the trace/replay to verify the report.

Add a contrasting agent-side mistake if time permits. For example, an agent selects
an ineligible product variant and incorrectly expects a discount. A useful observer
distinguishes this from the application calculating a discount incorrectly.

A shared-state race, such as two customers buying the last item, is another useful
fixture but demonstrates application concurrency more directly than agent handoff
diagnosis. Do not require an elaborate coordination failure to ship the first demo.

To demonstrate workflow independence, add a small non-browser fixture using the
same SDK/events and observer, such as a researcher passing an unsupported claim to
a verifier. No second browser-specific observer should be necessary.

## Subsystem ownership and branch boundaries

Suggested workstreams below are planning assignments, not instructions to spawn
agents or create branches automatically. Agree on named owners and a shared base
commit before beginning.

| Workstream | Owns | Consumes / delivers | Acceptance criteria |
| --- | --- | --- | --- |
| SDK and contracts | Event envelope, wrappers, explicit domain events, attribution/redaction | Delivers schema-validated event fixtures to backend and observer teams | Tool success/failure captured; original tool behavior preserved; IDs stable on retry; secrets excluded |
| Storage and ingestion | SQL integration, ingestion validation, query APIs, artifacts, job delivery | Consumes SDK events; provides bounded evidence APIs | No duplicate rows on retry; mismatched identities rejected; late events/links retained; stored evidence retrievable |
| Observer and detection | Trigger rules, investigation tools/prompt, citation validation, separate reports | Consumes evidence APIs and fixtures; delivers report contract | Diagnoses known fixture; recognizes recovery; cites real evidence; reports missing evidence |
| Browser demo and integrations | Controlled site, browser sessions, tool instrumentation, Sentry correlation | Uses SDK; supplies live demo and recorded fixtures | Agents visible; failures reproducible; report can link to matching external evidence |
| Dashboard | Run list, timeline, incident/evidence views, browser panes | Consumes agreed API/event/report fixtures | Every citation opens correct evidence; unavailable artifacts explicit; no dependence on browser fields for generic runs |

Suggested isolated ownership paths are `sql/postgres/` for database work, a new
SDK module directory for capture, and separate new modules for investigation and
API/UI work. These paths need coordination with the actual committed baseline;
do not overwrite existing modules or working-tree changes to match this plan.

Avoid multiple owners editing shared types simultaneously. One owner should merge
contract changes and versioned fixtures first. Others can implement against mocks
until the ingestion/query endpoints are available.

### Shared contracts to agree on first

1. Exact event envelope, initial event catalog, and metadata schemas.
2. Run/agent registration and ingestion request/response shapes.
3. Event-link direction, delivery retry behavior, and artifact identity format.
4. Read APIs, pagination, bounded artifact reads, and external reference resolution.
5. Investigation trigger/job format and report schema.
6. Frontend delivery mechanism for live updates and disconnected-client recovery.

Metrics can initially be derived from event durations, counts, and statuses. A
dedicated metrics backend is not necessary to establish the investigation flow.

## Delivery order and definition of done

First freeze the envelope and create fixtures. Next complete one vertical path:
tool call → persisted event → observer retrieval → cited report → evidence opened
in the dashboard. Then add multiple agents, live views, external traces, and more
failure scenarios.

The MVP is complete when:

- A real demo workflow emits evidence without the observer controlling execution.
- Events from multiple agents retain correct run/execution/session correlation.
- A known failure triggers an investigation and a supported report.
- The report links to original evidence and exposes gaps rather than inventing data.
- A recovered error or successful run does not automatically become a false incident.
- The same observer interfaces can consume a non-browser fixture.
- Team members can distinguish implemented features from the longer-term design.

Defer arbitrary framework compatibility, enormous swarms, TUI development,
automatic remediation, model training, production multi-tenancy, and training-data
export. Authentication, tenant isolation, retention, and sensitive-site recording
policies must be designed before expanding beyond a controlled demo deployment.

## Open decisions for the team

- Who owns each subsystem and the shared contract files?
- Which committed baseline will all branches use?
- When will PostgreSQL become the runtime store, and is existing data in scope?
- Which model/provider and orchestration framework will the demo use?
- Which exact two or three failure scenarios will be evaluated?
- Which Sentry/Browserbase capabilities are verified in the team's projects?
- What are the investigation concurrency, token, and artifact-read limits?
- Where will artifacts and reports be stored for the demo?

Resolve these as implementation choices without broadening the core promise:
record execution faithfully, investigate failures with bounded evidence access,
and help a developer reach the correct diagnosis faster.
