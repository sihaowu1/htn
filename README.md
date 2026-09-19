<div align="center">

<img src="assets/banner.png" alt="Watchtower">

Your agents. Every action. All in view.

[![GitHub stars](https://img.shields.io/github/stars/sihaowu1/htn?style=social)](https://github.com/sihaowu1/htn)
[![GitHub forks](https://img.shields.io/github/forks/sihaowu1/htn?style=social)](https://github.com/sihaowu1/htn/network/members)

</div>

---

**Know what your AI agents actually did.**

Watchtower turns a website-testing request into coordinated browser-agent runs. Watch agents follow distinct paths in isolated browsers, inspect their actions, and read failure reports backed by logged evidence. Successful and failed runs leave a record for debugging and future model training.

## Quick Start

You'll need **Node.js 22+**, OpenAI and Browserbase credentials, a Sentry DSN, and a tunnel such as ngrok.

### 1. Install dependencies

From the repository root:

```sh
npm ci
npx playwright install chromium
```

### 2. Configure the environment

Copy `.env.example` to `.env`:

```sh
# macOS / Linux
cp .env.example .env
```

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```

Fill in the credentials below. Keep `.env` local. Change model settings if needed for your account, using models that support the required API and structured outputs.

| Variable | Purpose | Required |
| --- | --- | --- |
| `OPENAI_API_KEY` | Model access for discovery, planning, workers, and observation | Yes |
| `BROWSERBASE_API_KEY` | Create isolated cloud browser sessions | Yes |
| `BROWSERBASE_PROJECT_ID` | Browserbase project for those sessions | Yes |
| `SENTRY_DSN` | Error and performance reporting | Yes, for the current run API |
| `OPENAI_MODEL` | Worker and observer model | Set in `.env.example` |
| `OPENAI_CRAWLER_MODEL` | Discovery model | Set in `.env.example` |
| `OPENAI_ORCHESTRATOR_MODEL` | Path-selection model | Set in `.env.example` |
| `PORT` | Watchtower server port | No; defaults to `3000` |

Although `.env.example` labels Sentry optional, the current server requires `SENTRY_DSN` to start a run. Events are also saved locally in `logs/events.jsonl`.

### 3. Serve the target website

The included `local_website/` contains a mock Best Buy store. Start it in a separate terminal from the repository root:

```sh
npx --yes http-server local_website -a 127.0.0.1 -p 8080
```

To test your own site, replace the contents of `local_website/` with your disposable static website. Discovery reads this directory using local Chromium; workers must reach the same site through its public URL. Use repeatable test data: fresh browser sessions reset browser storage, but do not reset backend data.

### 4. Expose the target

With ngrok installed, configure your account token and start the tunnel in another terminal:

```sh
ngrok config add-authtoken YOUR_TOKEN
ngrok http 127.0.0.1:8080
```

Copy the HTTPS forwarding URL. Browserbase runs in the cloud and needs this public address to reach your target. Watchtower automatically sends the header that skips ngrok's browser warning for worker requests.

### 5. Start Watchtower

From the repository root, in another terminal:

```sh
npm run dev
```

Open **[http://localhost:3000](http://localhost:3000)** and click **Get started**. Keep the target server and tunnel running.

## Your First Run

1. Paste the HTTPS tunnel URL into **Target website** under **Task Assignment**.
2. Enter a specific task, such as: **“Test search with matching and no-result queries. Stop at the results.”**
3. Choose **Maximum simultaneous workers** and click **Start run**.
4. Watch discovery and the worker browsers, then inspect **Results**, **Events**, and **Observer** for outcomes and supporting evidence. Click **Stop** to cancel.

Discovery explores locally before cloud workers launch. A discovered path is a candidate for execution; check worker results and observer evidence to see what actually happened. Watchtower supports one active run at a time.

For a smaller smoke test, open **Run options** and enable **Test single action**. This skips discovery and planning, runs one worker on a simple task using controls observed on the initial page, and stops.

## Replay with a Flow Map

If discovery misses a route, use **Download flow map**, correct the JSON, and upload it under **Run options → Flow map** on the next run.

- [Example flow map](examples/flow-map.json): the supported version 1 format.
- [Mock store flow map](examples/local-website-flow-map.json): expected routes for the included store. Replace every placeholder host with your tunnel address before uploading.

The map's `startUrl` must match the target URL exactly, including its path and trailing slash. To allow more discovery, adjust `CRAWL_MAX_STATES`, `CRAWL_MAX_DEPTH`, or `CRAWL_TIMEOUT_MS` in `.env` and restart Watchtower. `MAX_PATHS` limits selected paths; `MAX_WORKERS` caps simultaneous workers.

## Find Your Run Logs

| Location | What you'll find |
| --- | --- |
| `logs/events.jsonl` | Global event history, including actions, errors, and outcomes |
| `logs/orchestrator/<run-id>/` | Selected path bundles saved before workers launch |
| Control Room | Live browsers, discovery coverage, worker results, and observer reports |

Use run, agent, and Browserbase session IDs to correlate events with browser sessions and Sentry reports.

## Run the Compiled App

```sh
npm run build
npm start
```

For architecture, contributor guidance, and test commands, see [AGENTS.md](AGENTS.md).
