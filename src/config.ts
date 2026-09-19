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
  databaseUrl: process.env.DATABASE_URL || '', artifactDir: process.env.ARTIFACT_DIR || 'artifacts',
  maxStates: number('CRAWL_MAX_STATES', 100), maxDepth: number('CRAWL_MAX_DEPTH', 8),
  crawlTimeout: number('CRAWL_TIMEOUT_MS', 600_000),
  maxActions: number('WORKER_MAX_ACTIONS', 30), workerTimeout: number('WORKER_TIMEOUT_MS', 300_000),
  workerLinger: number('WORKER_LINGER_MS', 30_000),
  maxWorkers: number('MAX_WORKERS', 5), maxPaths: number('MAX_PATHS', 3),
  investigationConcurrency: number('INVESTIGATION_CONCURRENCY', 2),
  investigationMaxAttempts: number('INVESTIGATION_MAX_ATTEMPTS', 3),
  investigationLeaseMs: number('INVESTIGATION_LEASE_MS', 300_000),
  investigationMaxToolCalls: number('INVESTIGATION_MAX_TOOL_CALLS', 30),
  investigationMaxEvents: number('INVESTIGATION_MAX_EVENTS', 200),
  investigationMaxArtifactBytes: number('INVESTIGATION_MAX_ARTIFACT_BYTES', 262_144),
};
export function missingCredentials() {
  return ['OPENAI_API_KEY', 'BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID', 'SENTRY_DSN', 'DATABASE_URL']
    .filter(key => !process.env[key]);
}
