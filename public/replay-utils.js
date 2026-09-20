export function eventKey(event) {
  return event.eventId || `${event.agentExecutionId || event.agentId || 'unknown'}:${event.seq}`;
}

export function sortEvents(events) {
  return [...events].sort((a, b) => Date.parse(a.time) - Date.parse(b.time)
    || String(a.agentExecutionId || '').localeCompare(String(b.agentExecutionId || ''))
    || Number(a.seq) - Number(b.seq)
    || eventKey(a).localeCompare(eventKey(b)));
}

export function eventsForSession(events, sessionId) {
  return sortEvents(events.filter(event => event.sessionId === sessionId));
}

export function eventOffsetSeconds(event, page) {
  return (Date.parse(event.time) - page.start_time_ms) / 1000;
}

export function isPlaybackEvent(event) {
  return event.type === 'action.attempt' || event.type === 'action.result'
    || event.type === 'browser.navigation'
    || (event.type === 'browser.console' && ['error', 'assert'].includes(event.data?.level))
    || event.type === 'browser.error' || event.type === 'http.error'
    || event.type === 'request.failed' || event.type === 'session.released'
    || event.type === 'session.release.failed' || event.type === 'agent.completed'
    || event.type === 'worker.failed' || event.type === 'run.finished' || event.type === 'run.failed';
}

export function nearestEventIndex(events, page, currentTimeSeconds) {
  const candidates = events.map((event, index) => ({ event, index }))
    .filter(({ event }) => isPlaybackEvent(event))
    .map(item => ({ ...item, offset: eventOffsetSeconds(item.event, page) }))
    .filter(item => item.offset >= 0 && item.offset <= (page.end_time_ms - page.start_time_ms) / 1000)
    .map(item => ({ ...item, distance: Math.abs(item.offset - currentTimeSeconds) }));
  candidates.sort((a, b) => a.distance - b.distance || a.index - b.index);
  return candidates[0]?.index ?? -1;
}
