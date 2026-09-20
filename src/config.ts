import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

// Resolve the project .env from this module instead of process.cwd(). This keeps
// CLI, IDE, and `npm --prefix` launches consistent for every teammate.
loadEnv({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

function number(name: string, fallback: number) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  return value;
}

export function parseSampleRate(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`Invalid ${name}: expected a finite number from 0 through 1`);
  }
  return parsed;
}

export function parseBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  if (['true', '1'].includes(value.toLowerCase())) return true;
  if (['false', '0'].includes(value.toLowerCase())) return false;
  throw new Error(`Invalid ${name}: expected true, false, 1, or 0`);
}

const sentryEnvironment = process.env.SENTRY_ENVIRONMENT || 'development';
export function sentryDefaults(environment: string) {
  return environment === 'production'
    ? { tracesSampleRate: 0.2, profileSessionSampleRate: 0.1 }
    : { tracesSampleRate: 1, profileSessionSampleRate: 1 };
}
const defaults = sentryDefaults(sentryEnvironment);
export const config = {
  port: number('PORT', 3000), model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
  crawlerModel: process.env.OPENAI_CRAWLER_MODEL || 'gpt-5.6-luna',
  orchestratorModel: process.env.OPENAI_ORCHESTRATOR_MODEL || 'gpt-5.6-luna',
  databaseUrl: process.env.DATABASE_URL || '', artifactDir: process.env.ARTIFACT_DIR || 'artifacts',
  maxStates: number('CRAWL_MAX_STATES', 100), maxDepth: number('CRAWL_MAX_DEPTH', 10),
  crawlTimeout: number('CRAWL_TIMEOUT_MS', 600_000),
  maxActions: number('WORKER_MAX_ACTIONS', 60), workerTimeout: number('WORKER_TIMEOUT_MS', 300_000),
  workerLinger: number('WORKER_LINGER_MS', 30_000),
  maxWorkers: number('MAX_WORKERS', 5), maxPaths: number('MAX_PATHS', 3),
  investigationConcurrency: number('INVESTIGATION_CONCURRENCY', 2),
  investigationMaxAttempts: number('INVESTIGATION_MAX_ATTEMPTS', 3),
  investigationLeaseMs: number('INVESTIGATION_LEASE_MS', 300_000),
  investigationMaxToolCalls: number('INVESTIGATION_MAX_TOOL_CALLS', 30),
  investigationMaxEvents: number('INVESTIGATION_MAX_EVENTS', 200),
  investigationMaxArtifactBytes: number('INVESTIGATION_MAX_ARTIFACT_BYTES', 262_144),
  elasticsearchEnabled: parseBoolean('ELASTICSEARCH_ENABLED', process.env.ELASTICSEARCH_ENABLED, false),
  elasticsearchUrl: process.env.ELASTICSEARCH_URL || '',
  elasticsearchApiKey: process.env.ELASTICSEARCH_API_KEY || '',
  elasticsearchIndexPrefix: process.env.ELASTICSEARCH_INDEX_PREFIX || 'htn',
  elasticsearchTimeoutMs: number('ELASTICSEARCH_TIMEOUT_MS', 10_000),
  sentryEnvironment,
  sentryTracesSampleRate: parseSampleRate('SENTRY_TRACES_SAMPLE_RATE',
    process.env.SENTRY_TRACES_SAMPLE_RATE, defaults.tracesSampleRate),
  sentryProfileSessionSampleRate: parseSampleRate('SENTRY_PROFILE_SESSION_SAMPLE_RATE',
    process.env.SENTRY_PROFILE_SESSION_SAMPLE_RATE, defaults.profileSessionSampleRate),
  sentryRuntimeMetricsEnabled: parseBoolean('SENTRY_RUNTIME_METRICS_ENABLED',
    process.env.SENTRY_RUNTIME_METRICS_ENABLED, true),
  demoMode: parseBoolean('WATCHTOWER_DEMO_MODE', process.env.WATCHTOWER_DEMO_MODE, false),
  browserbaseReplayEnabled: parseBoolean('BROWSERBASE_REPLAY_ENABLED',
    process.env.BROWSERBASE_REPLAY_ENABLED, true),
};
export function missingCredentials() {
  const required = ['OPENAI_API_KEY', 'BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID', 'SENTRY_DSN', 'DATABASE_URL'];
  if (config.elasticsearchEnabled) required.push('ELASTICSEARCH_URL', 'ELASTICSEARCH_API_KEY');
  return required.filter(key => !process.env[key]);
}
