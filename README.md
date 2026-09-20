# Quick start

1. Install Node.js 22+ and dependencies:

   ```sh
   npm ci
   ```

2. Copy `.env.example` to `.env` in this project directory. Set `OPENAI_API_KEY`, `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, `SENTRY_DSN`, and `DATABASE_URL`; `SENTRY_DSN` is the runtime DSN from **Sentry project settings → Client Keys (DSN)**, not an auth token or ingest URL copied from elsewhere. Change `OPENAI_MODEL` if needed for your account. `DATABASE_URL` must point to an empty or previously migrated PostgreSQL database; migrations are applied automatically. For Supabase team development, copy the **Session pooler** URL and append `?sslmode=require&uselibpqcompat=true`; do not put a teammate-specific `sslrootcert` path in a shared URL. Percent-encode reserved characters in the database password. Use `sslmode=verify-full` only when that machine has been configured with the Supabase CA certificate. Browserbase is used only to provision isolated cloud Chromium sessions; this project controls them with Playwright over CDP and does not use Browserbase AI Agents. `SENTRY_ENVIRONMENT=development` samples all traces and trace-lifecycle profiles; production defaults are `0.2` and `0.1`. Override them with finite values from `0` to `1`. Runtime metrics and Browserbase replay are enabled by default.

3. Add and start your own disposable target website in `local_website/` (left empty). Expose its port using your tunnel tool, for example:

   start local server
   ```sh
   npx ci
   cd local_website
   npx --yes http-server . -a 127.0.0.1 -p 8080
   ``` 

   start ngrok listener in another terminal

   ```sh
   winget install ngrok.ngrok # windows cli idk about mac
   ngrok config add-authtoken YOUR_TOKEN
   ngrok update 
   ngrok http 127.0.0.1:8080
   ```

   The app automatically sends ngrok's `ngrok-skip-browser-warning: true` header from Browserbase, so the free-tier warning page should be skipped. If you open the URL manually, append `?ngrok-skip-browser-warning=true` once. The target needs a reachable public HTTP(S) URL because the cloud browser cannot connect to the app's localhost directly.

4. Start the API and the durable investigation worker in separate terminals, then open http://localhost:3000:

   ```sh
   npm run dev
   ```

   ```sh
npm run dev:observer
```

Optional Elastic Cloud search is enabled with `ELASTICSEARCH_ENABLED=true`,
`ELASTICSEARCH_URL`, and `ELASTICSEARCH_API_KEY`. After enabling it for an
existing database, run `npm run search:backfill` once to build and atomically
activate the event and investigation indices. See
[`docs/architecture/elasticsearch-search.md`](docs/architecture/elasticsearch-search.md)
for the indexing lifecycle, query behavior, trust boundaries, and operations.

5. Paste the target's HTTPS tunnel URL, enter a task, choose maximum simultaneous workers, and click **Start**. Watch discovery, worker browsers, events, and investigation reports. Use **Stop** to cancel. When a Browserbase session closes, choose **Load replay** to fetch fresh provider-hosted HLS metadata and view the recording beside its authoritative event timeline. Replay availability follows Browserbase retention; an unavailable recording does not remove the PostgreSQL timeline. The temporary `TEST SINGLE ACTION` switch skips discovery and normal planning: one worker inspects the initial page, executes one simple requested task using only observed controls, and stops. PostgreSQL is authoritative for evidence. Sentry stores aggregate telemetry and sampled profiles, not prompts or replay video. Failure signals create deduplicated investigation jobs, and completed reports are published on the run event stream; use event agent/session IDs to match Browserbase and Sentry.

6. If discovery is incomplete or does not work, download a flow map, correct it, and select it with the JSON input on the next run. Use `examples/flow-map.json` as a format example. Its `startUrl` must exactly match the target URL. Increase `CRAWL_MAX_STATES`, `CRAWL_MAX_DEPTH`, or `CRAWL_TIMEOUT_MS` in `.env` if needed, then restart. Use a repeatable demo site: discovery may submit forms and fresh sessions do not reset backend data.

## Run checks (not important)

```sh
npm run build
npm test
npx playwright install chromium
```

Run the actual Chromium tests in PowerShell:

```powershell
$env:RUN_BROWSER_TESTS = '1'
npm run test:browser
```

Or on macOS/Linux:

```sh
RUN_BROWSER_TESTS=1 npm run test:browser
```

## Start the compiled app

```sh
npm run build
npm start
npm run start:observer
```
