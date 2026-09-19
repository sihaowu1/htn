import * as Sentry from '@sentry/node';
import './config.js';

Sentry.init({ dsn: process.env.SENTRY_DSN, enabled: !!process.env.SENTRY_DSN,
  tracesSampleRate: 1, enableLogs: true, sendDefaultPii: false,
  integrations: [Sentry.openAIIntegration({ recordInputs: false, recordOutputs: false })] });
export { Sentry };

const secretKeys = /^(authorization|cookie|password|token|apiKey|connectUrl|liveUrl)$/i;
export function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    let text = value;
    for (const key of ['OPENAI_API_KEY', 'BROWSERBASE_API_KEY', 'SENTRY_DSN']) {
      const secret = process.env[key];
      if (secret) text = text.split(secret).join('[redacted]');
    }
    return text.replace(/(https?:\/\/[^\s"<>]*[?&](?:token|api_key|key|password)=)[^&\s"<>]*/gi, '$1[redacted]');
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, secretKeys.test(key) ? '[redacted]' : redact(val)]));
  return value;
}
