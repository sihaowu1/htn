import 'dotenv/config';

function number(name: string, fallback: number) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  return value;
}
export const config = {
  port: number('PORT', 3000), model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
  crawlerModel: process.env.OPENAI_CRAWLER_MODEL || 'gpt-5.6-luna',
  orchestratorModel: process.env.OPENAI_ORCHESTRATOR_MODEL || 'gpt-5.6-luna',
  maxStates: number('CRAWL_MAX_STATES', 100), maxDepth: number('CRAWL_MAX_DEPTH', 10),
  crawlTimeout: number('CRAWL_TIMEOUT_MS', 600_000),
  maxActions: number('WORKER_MAX_ACTIONS', 60), workerTimeout: number('WORKER_TIMEOUT_MS', 300_000),
  workerLinger: number('WORKER_LINGER_MS', 30_000),
  maxWorkers: 3, maxPaths: 3,
};
export function missingCredentials() {
  return ['OPENAI_API_KEY', 'BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID', 'SENTRY_DSN']
    .filter(key => !process.env[key]);
}
