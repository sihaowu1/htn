# Quick start

1. Install Node.js 22+ and dependencies:

   ```sh
   npm ci
   ```

2. Copy `.env.example` to `.env`. Set `OPENAI_API_KEY`, `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, and `SENTRY_DSN`. Change `OPENAI_MODEL` if needed for your account.

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
   ngrok config add-authtoken YOUR_TOKEN # create ur free acc on ngrok
   ngrok update 
   ngrok http 127.0.0.1:8080
   ```

   We NEED Ngrok because we need to give Browserbase a reachable public HTTP(S) url that can be used (browser base cant connect to our localhost) so it must be this. 

4. Start our project app and open http://localhost:3000:

   ```sh
   npm run dev
   ```

5. Paste the target's HTTPS tunnel URL, enter a task, choose maximum simultaneous workers, and click **Start**. Watch discovery, worker browsers, events, and observer reports. Use **Stop** to cancel. Global events are saved to `logs/events.jsonl`; use the event's agent/session IDs to match Browserbase and Sentry.

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
```
