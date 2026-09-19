// Dashboard runs pause here until the graph has been presented. API callers
// opt in explicitly; an abandoned dashboard must never launch workers later.
export class GraphPreview {
  private pending = new Map<string, () => void>();

  wait(id: string, signal: AbortSignal, timeout = 600_000): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.pending.delete(id);
        if (error) reject(error); else resolve();
      };
      const abort = () => finish(signal.reason);
      const timer = setTimeout(() => finish(new Error('Graph preview timed out; no workers were launched')), timeout);
      signal.addEventListener('abort', abort, { once: true });
      this.pending.set(id, () => finish());
    });
  }

  complete(id: string): boolean {
    const finish = this.pending.get(id);
    if (!finish) return false;
    finish();
    return true;
  }
}
