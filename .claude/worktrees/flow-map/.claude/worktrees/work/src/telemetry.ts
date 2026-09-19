import { mkdir, appendFile, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import * as Sentry from '@sentry/node';
import './config.js';
import type { Identity, LogEvent } from './types.js';

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
export class EventLog extends EventEmitter {
  private seq = 0;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(public file = 'logs/events.jsonl', private sink: boolean | ((event: LogEvent) => void) = true) { super(); }
  async init() {
    await mkdir(dirname(this.file), { recursive: true });
    const events = await this.read();
    this.seq = events.reduce((max, e) => Math.max(max, e.seq), 0);
    const existing = await readFile(this.file, 'utf8').catch(() => '');
    if (existing && !existing.endsWith('\n')) await appendFile(this.file, '\n');
  }
  write(identity: Identity, type: string, data: unknown = {}): Promise<LogEvent> {
    const operation = this.tail.then(async () => {
      const event = { ...identity, seq: ++this.seq, time: new Date().toISOString(), type, data: redact(data) };
      await appendFile(this.file, JSON.stringify(event) + '\n');
      if (this.sink) {
        try {
          if (typeof this.sink === 'function') this.sink(event);
          else Sentry.withScope(scope => {
            scope.setTags({ runId: identity.runId, agentId: identity.agentId, role: identity.role, sessionId: identity.sessionId || 'none' });
            Sentry.logger.info(type, { ...identity, seq: event.seq, payload: JSON.stringify(event.data) });
            if (/error|failed|failure/.test(type)) Sentry.captureException(new Error(type), { extra: { event } });
          });
        } catch { /* Local persistence does not depend on Sentry availability. */ }
      }
      this.emit('event', event);
      return event;
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }
  async read(runId?: string): Promise<LogEvent[]> {
    await this.tail;
    let text: string;
    try { text = await readFile(this.file, 'utf8'); } catch (e: any) { if (e.code === 'ENOENT') return []; throw e; }
    return text.split('\n').filter(Boolean).flatMap(line => {
      try { const event = JSON.parse(line) as LogEvent; return !runId || event.runId === runId ? [event] : []; }
      catch { return []; } // A partial last line from a crash must not hide earlier events.
    });
  }
  async flush() { await this.tail; }
}
export class Trace {
  constructor(public log: EventLog, public identity: Identity) {}
  event(type: string, data: unknown = {}) { return this.log.write(this.identity, type, data); }
  async span<T>(name: string, work: () => Promise<T>): Promise<T> {
    return Sentry.startSpan({ name, op: name === 'model.call' ? 'gen_ai.request' : 'agent', attributes: { ...this.identity } }, async () => {
      await this.event(`${name}.started`);
      try { const result = await work(); await this.event(`${name}.succeeded`); return result; }
      catch (error) { await this.event(`${name}.failed`, { error: String(error) }); throw error; }
    });
  }
}
