import type { Report, LogEvent } from './types.js';

export function verifyReport(report: Report, events: LogEvent[]): Report {
  const ids = new Set(events.map(e => e.seq));
  const findings = report.findings.filter(f => f.eventIds.length > 0 && f.eventIds.every(id => ids.has(id)));
  const cited = new Set(findings.flatMap(f => f.eventIds));
  return { ...report, findings, references: events.filter(e => cited.has(e.seq)).map(e => ({ eventId: e.seq, agentId: e.agentId, sessionId: e.sessionId || null, type: e.type })) };
}
