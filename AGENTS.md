# Working on this MVP

- Keep the UI plain HTML and the backend one TypeScript/Express process. Do not add a database, UI framework, authentication, or deployment scaffolding without a task requiring it.
- Node 22+ is required. Install with `npm ci`; develop with `npm run dev`; check with `npm run build` and `npm test`. Browser tests require `npx playwright install chromium` and `RUN_BROWSER_TESTS=1`.
- `src/crawler.ts` discovers transitions; `src/flow.ts` validates maps and paths. The orchestrator analyzes the map and never operates a browser. Workers may execute only their assigned observed transitions and must verify stopping conditions using browser evidence.
- Discovery is bounded and uses sampled inputs. Preserve explicit coverage limits, unknown branches, state references, and replay failures. A flow-map JSON import can replace discovery when crawling does not work; export from the UI or adapt `examples/flow-map.json`.
- All agents and browser actions use `Trace` and the serialized global JSONL logger. Preserve run, agent, and Browserbase session correlation. Local persistence must not depend on Sentry availability. Do not log API keys, connection URLs, passwords, or hidden model reasoning.
- Sessions belong to one agent. Release sessions in success, failure, cancellation, timeout, and shutdown paths. Never reuse logged-in browser contexts across workers.
- The target is an unauthenticated disposable demo site with repeatable state. Context resets do not reset backend data. Do not silently continue when replay diverges.
- Keep `local_website/` empty. Setup recreates it because Git does not track empty directories. Test fixtures belong under `tests/fixtures/`.
- README content must contain only quick-start instructions. Put implementation guidance here and map-format examples under `examples/`.
- Keep live credentials in `.env`. Mocked tests do not prove live OpenAI, Browserbase, or Sentry behavior; state which integrations were actually exercised.
