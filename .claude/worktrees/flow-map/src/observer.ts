import { reportSchema, type Report, type LogEvent } from './types.js';
import type { Model } from './model.js';
import type { Trace } from './telemetry.js';

export function verifyReport(report: Report, events: LogEvent[]): Report {
  const ids = new Set(events.map(e => e.seq));
  const findings = report.findings.filter(f => f.eventIds.length > 0 && f.eventIds.every(id => ids.has(id)));
  const cited = new Set(findings.flatMap(f => f.eventIds));
  return { ...report, findings, references: events.filter(e => cited.has(e.seq)).map(e => ({ eventId: e.seq, agentId: e.agentId, sessionId: e.sessionId || null, type: e.type })) };
}
export class Observer {
  private cursor = 0;
  private active?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private summary = '';
  constructor(private model: Model, private trace: Trace, private publish: (report: Report) => void) {}
  start() { this.timer = setInterval(() => { void this.tick(false); }, 5000); }
  tick(final: boolean): Promise<void> {
    if (this.active) return this.active;
    this.active = this.analyze(final).catch(async error => {
      await this.trace.event('observer.failed', { error: String(error) });
    }).finally(() => { this.active = undefined; });
    return this.active;
  }
  private async analyze(final: boolean) {
    const all = (await this.trace.log.read(this.trace.identity.runId)).filter(e => e.role !== 'observer');
    const pending = all.filter(e => e.seq > this.cursor);
    if (!pending.length && !final) return;
    // Process every event in bounded batches; reduce large DOM payloads for the observer.
    const batches = pending.length ? Array.from({ length: Math.ceil(pending.length / 40) }, (_, i) => pending.slice(i * 40, i * 40 + 40)) : [[]];
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const inputEvents = batch.map(e => ({ ...e, data: JSON.stringify(e.data).slice(0, 3000) }));
      const report = verifyReport(await this.model.call(this.trace, 'report_findings', reportSchema,
        'You are the global observer. Analyze these global log events for browser failures, blocked tasks, model errors, coverage limits, and successes. Distinguish observed facts from suspected causes. Cite only supplied event sequence IDs. Do not claim a root cause without evidence. Avoid repeating findings from the prior summary. End with the current run assessment.',
        { final: final && i === batches.length - 1, previousSummary: this.summary, events: inputEvents }, AbortSignal.timeout(60_000)), batch);
      this.summary = report.summary;
      this.publish(report);
      await this.trace.event('observer.report', report);
      if (batch.length) this.cursor = batch[batch.length - 1].seq;
    }
  }
  async stop() {
    clearInterval(this.timer);
    await this.active;
    await this.tick(true);
  }
}
