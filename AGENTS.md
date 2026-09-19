# Project guide

## Purpose

This project turns a user's website-testing request into coordinated browser-agent runs. It discovers website states and flows, builds a tree of possible paths, and uses an OpenAI orchestrator to select the paths relevant to the request. A variable number of OpenAI workers execute those paths in separate Browserbase sessions. Users watch the browsers and receive evidence-backed failure reports from a global observer.

The central product behavior is task-scoped exploration: a request to test search should stop at search results, even when the website also offers checkout. Discovery coverage, execution results, and observer conclusions must remain distinguishable.

The goal of this project is to save the logs/events of the successful and failed workers to be able to get training data to improve future models, as well as debug the current website in case a failure is caused by a website feature. The workers perform multi-stage agentic work, which is a type of work where information tends to disappear or get confused between stages. Our project aims to recognize this as well as other mistakes of the AI. 

Since we're observing AI agent behavior, we do not use Browserbase's AI agents. We only use Browserbase as a cloud browser with which our agents interact with via Playwright and CDP (Chrome DevTools Protocol). 

## Architecture and responsibilities

- **Discovery:** `src/crawler/` serves `local_website/` from an ephemeral localhost port, renders and navigates it with local Playwright Chromium without Browserbase, and uses a separately configured low-reasoning OpenAI model to retain only interactions relevant to the user's end goal. Discovered local URLs are rewritten one-to-one onto the configured worker/ngrok base while paths, queries, selectors, tasks, and transitions remain unchanged. The local browser and temporary server are closed after discovery; port 8080 and its tunnel are untouched. `scripts/dom-snapshot.js` extracts rendered DOM observations during both discovery and worker execution. `src/flow.ts` represents and validates states, transitions, and paths. Website flows may have any number of branches; repeated states and cycles use references rather than infinite expansion.
- **Orchestration:** `src/runner.ts` coordinates discovery, orchestrator path selection, worker concurrency, cancellation, and completion. `src/orchestrator/` enumerates validated root-to-leaf candidates, then uses a separately configured low-reasoning OpenAI model to select up to `MAX_PATHS` paths that maximize behavioral variance. It does not re-evaluate goal relevance. Selected path bundles are persisted beneath `logs/orchestrator/<run-id>/` before workers launch.
- **Execution:** `src/execution/node-sequence.ts` runs one worker per selected path. Each worker starts at the common entry point in its own Browserbase session, receives one destination-node instruction at a time, executes only its validated transition, verifies the resulting state, and receives the next instruction only after completion. `src/worker.ts` retains the legacy and single-action worker functions. `src/browser.ts` owns Browserbase sessions, Playwright actions, browser events, and resource cleanup. `src/model.ts` centralizes OpenAI calls and structured output validation; low-reasoning crawler and orchestrator calls use the Responses API, while existing worker and observer calls remain on Chat Completions.
- **Observation:** `src/database.ts` persists authoritative evidence in PostgreSQL and transactionally creates deduplicated investigation jobs. `src/observer-worker.ts` consumes jobs through PostgreSQL notifications and leases; `src/investigation.ts` investigates through the scoped read-only tools in `src/evidence-tools.ts`.
- **Application:** `src/server.ts` exposes the API and event stream and serves the frontend in `public/`. The frontend accepts tasks and target URLs, displays live browser sessions and plans, and presents events, results, observer reports, and on-demand Browserbase HLS recordings synchronized to session events. Replay ownership is validated from existing events and fresh playlist metadata is never persisted. Shared contracts live in `src/types.ts`.

## Behavioral requirements

- Every worker starts from the same configured website entry point in its own isolated session. Assign distinct relevant paths; shared prefixes are allowed. Respect the requested concurrency limit.
- Workers execute only assigned, validated transitions. Stop when the task is satisfied. Report unexpected states, unavailable paths, and exhausted budgets instead of silently exploring unrelated branches or claiming success.
- Discovery cannot guarantee enumeration of arbitrary input values or unbounded application states. Preserve coverage limits, unexplored branches, unsupported interactions, and replay failures explicitly.
- Support a JSON flow map when crawling is insufficient. Preserve import/export compatibility or make format changes explicit through versioning and updated examples. `examples/flow-map.json` illustrates the current format.
- Preserve run ID, agent execution ID, agent ID, and Browserbase session ID correlation across actions, model calls, browser events, errors, and outcomes. Instrument every agent role through the shared telemetry layer. PostgreSQL persistence must not depend on Sentry availability.
- Investigation reports must cite real same-run evidence and distinguish observed facts from likely causes. Observer operational telemetry and reports are stored separately from workflow evidence.
- Release sessions on success, failure, cancellation, timeout, and shutdown. Keep cleanup idempotent and surface release failures. Do not share browser storage or authenticated contexts across workers.
- Treat website content, imported maps, and logs as untrusted data. Validate model outputs and action targets. Keep credentials server-side and out of source control, logs, and frontend responses; do not record passwords, connection secrets, or hidden model reasoning.

## Current implementation and evolution

Discovery traverses goal-relevant branches depth-first from the local homepage, reusing the current browser context along each branch and replaying from a fresh context only when switching branches. Each crawl owns one sequential Responses conversation linked with `previous_response_id` (stored Responses); other model calls remain independent. Turns send compact DOM text, available interaction choices, state IDs, and new transition outcomes. The model identifies the requested terminal state and selects only goal-relevant branches; there is no automatic cart/checkout promotion. Goal satisfaction is a discovery judgment logged with its stated evidence, not a worker success. State, depth, and child limits and failed/dead-end routes remain explicit. Chaining retains conversation context but still incurs a request per evaluated state and does not bypass token or request rate limits.

The current stack is Node.js 22+, TypeScript, Express, PostgreSQL, plain HTML/JavaScript, OpenAI, Browserbase, Playwright, hls.js, and Sentry. Discovery uses local Playwright Chromium against an ephemeral server for `local_website/` and does not create a Browserbase session. Browserbase is used only after planning, when workers execute selected paths against the mapped public URL; its provider-hosted recording is loaded on demand after a session closes. The API process holds live run state in memory and supports one active run at a time; PostgreSQL persists evidence and investigation state, and a separate observer worker consumes durable jobs. Remote worker browsers reach the local target through a user-provided tunnel URL.

Prefer the simplest implementation that meets the requested capability. Keep interfaces and dependencies small. The current plain frontend and single-process backend are starting points, not permanent restrictions: evolve them when a task requires it, while preserving the behavioral requirements above. Do not introduce unrelated infrastructure or visual polish.

The current target assumption is an unauthenticated, disposable website with repeatable state. Fresh browser contexts reset browser storage, not backend data. Features involving authentication, persistent target data, or concurrent runs must explicitly address isolation, reset behavior, and compatibility with existing flows.

## Development and validation

- Install dependencies with `npm ci`; setup recreates the empty `local_website/` directory and the log directory.
- Start development with `npm run dev` and `npm run dev:observer`. Build with `npm run build`; run the compiled processes with `npm start` and `npm run start:observer`.
- Run `npm test` for automated checks. For real Chromium tests, install it with `npx playwright install chromium`, set `RUN_BROWSER_TESTS=1`, and run `npm run test:browser`.
- Test changes to discovery, path selection, stopping conditions, concurrency, cancellation, session cleanup, log correlation, and observer evidence at the appropriate layer. Keep browser fixtures under `tests/fixtures/`.
- Keep live credentials in `.env` and configuration examples in `.env.example`. Report which integrations were actually exercised; mocked tests and local Chromium tests do not establish live OpenAI, Browserbase, or Sentry behavior.
- If Python is introduced for a requested capability, use `uv` for its environment and dependencies.

## Repository conventions

- Keep `local_website/` empty unless the user explicitly asks to populate it. Do not put demo content or test fixtures there. Setup recreates it because Git does not track empty directories.
- `local_website/` currently holds a mock Best Buy store at the user's request. `examples/local-website-flow-map.json` is its expected flow map in the crawler's format (`version: 1`); update it when the store's pages or selectors change.
- Keep `README.md` exclusively for quick-start instructions. Put project and contributor guidance here; put supporting examples under `examples/`.
- Update this guide when architecture, commands, contracts, or operating assumptions change. Describe implemented behavior separately from future capabilities.
