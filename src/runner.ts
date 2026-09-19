import { randomUUID } from 'node:crypto';
import { BrowserSession } from './browser.js';
import { config } from './config.js';
import { crawl } from './crawler/index.js';
import { pool, validateMap } from './flow.js';
import { OpenAIModel } from './model.js';
import { Observer } from './observer.js';
import { orchestratePaths } from './orchestrator/index.js';
import { EventLog, Trace } from './telemetry.js';
import { type FlowMap, type Run, type Identity } from './types.js';
import { executeSingleAction, executeTask } from './worker.js';

export class Runner {
  runs = new Map<string, Run>();
  private active?: { run: Run; controller: AbortController; done: Promise<void> };
  constructor(public log: EventLog, private publish: (run: Run) => void) {}
  start(prompt: string, targetUrl: string, maxWorkers: number, supplied?: FlowMap, testSingleAction = false) {
    if (this.active) throw new Error('A run is already active');
    const run: Run = { id: randomUUID(), prompt, targetUrl, maxWorkers, status: 'starting', sessions: [], findings: [], results: [] };
    const controller = new AbortController();
    this.runs.set(run.id, run);
    const done = Promise.resolve().then(() => this.execute(run, controller, supplied, testSingleAction)).catch(async error => {
      run.status = 'failed';
      await this.log.write({ runId: run.id, agentId: 'system', role: 'system' }, 'run.failed', { error: String(error) }).catch(() => undefined);
    }).finally(() => { this.active = undefined; this.publish(run); });
    this.active = { run, controller, done };
    return run;
  }
  cancel(id: string) {
    if (this.active?.run.id !== id) return false;
    this.active.controller.abort(new Error('Cancelled by user'));
    this.active.run.status = 'cancelling'; this.publish(this.active.run); return true;
  }
  async shutdown() { if (this.active) { this.active.controller.abort(new Error('Server shutdown')); await this.active.done; } }
  private async execute(run: Run, controller: AbortController, supplied?: FlowMap, testSingleAction = false) {
    const signal = controller.signal;
    const trace = (role: Identity['role'], agentId: string = role) => new Trace(this.log, { runId: run.id, agentId, role });
    const system = trace('system');
    const model = new OpenAIModel();
    const sessions = new Set<BrowserSession>();
    const open = async (t: Trace, scope: AbortSignal) => {
      scope.throwIfAborted();
      const session = await BrowserSession.open(t, info => {
        if (!run.sessions.some(s => s.sessionId === info.sessionId)) run.sessions.push(info);
        this.publish(run);
      });
      sessions.add(session);
      const close = () => { void session.close(); };
      scope.addEventListener('abort', close, { once: true });
      if (scope.aborted) { await session.close(); scope.throwIfAborted(); }
      return session;
    };
    const observer = new Observer(model, trace('observer'), report => { run.findings.push(report); this.publish(run); });
    await system.event('run.started', { prompt: run.prompt, targetUrl: run.targetUrl, maxWorkers: run.maxWorkers });
    observer.start();
    try {
      if (testSingleAction) {
        run.status = 'running';
        run.plan = { summary: 'Execute one simple task using only controls from the initial page, without discovery', paths: [], skipped: [] };
        this.publish(run);
        await system.event('test.single_action.enabled', { discovery: false });
        const t = trace('worker', 'worker-1');
        const workerSignal = AbortSignal.any([signal, AbortSignal.timeout(config.workerTimeout)]);
        const session = await open(t, workerSignal);
        try {
          run.results.push(await t.span('worker', () => executeSingleAction(run.prompt, run.targetUrl,
            url => session.page(url), model, t, workerSignal)));
        } finally { await session.close(); this.publish(run); }
        run.status = 'succeeded';
        await system.event('run.finished', { status: run.status, results: run.results });
        return;
      }
      const resolveFlowMap = async () => {
        run.status = 'discovering'; this.publish(run);
        await system.event('pipeline.phase.started', { phase: 'sitemap_or_crawler' });
        if (supplied) {
          run.map = validateMap(supplied, run.targetUrl);
          await system.event('map.imported', { status: run.map.status });
        } else {
          const t = trace('crawler');
          const discoverySignal = AbortSignal.any([signal, AbortSignal.timeout(config.crawlTimeout)]);
          run.map = await t.span('discovery', () => crawl(run.targetUrl, run.prompt, model, t, discoverySignal,
            map => { run.map = map; this.publish(run); }));
        }
        await system.event('pipeline.phase.finished', { phase: 'sitemap_or_crawler', mapStatus: run.map.status });
        return run.map;
      };
      const createPlan = async (map: FlowMap) => {
        signal.throwIfAborted();
        run.status = 'planning'; this.publish(run);
        await system.event('pipeline.phase.started', { phase: 'orchestrator' });
        const orchestrator = trace('orchestrator');
        const { plan, file } = await orchestrator.span('orchestration', () =>
          orchestratePaths(map, run.prompt, run.id, model, orchestrator, signal));
        run.plan = plan;
        await orchestrator.event('plan.created', { ...plan, file });
        await system.event('pipeline.phase.finished', { phase: 'orchestrator', paths: plan.paths.length, file });
        return plan;
      };

      // These awaits are intentional phase barriers. No worker session can be
      // created until map resolution and orchestration have both completed.
      const map = await resolveFlowMap();
      signal.throwIfAborted();
      const plan = await createPlan(map);
      signal.throwIfAborted();
      run.status = 'running'; this.publish(run);
      await system.event('pipeline.phase.started', { phase: 'workers', paths: plan.paths.length });
      await pool(plan.paths, run.maxWorkers, signal, async (task, index) => {
        const t = trace('worker', `worker-${index + 1}`);
        const workerSignal = AbortSignal.any([signal, AbortSignal.timeout(config.workerTimeout)]);
        let session: BrowserSession | undefined;
        try {
          session = await open(t, workerSignal);
          const result = await t.span('worker', () => executeTask(task, map, run.prompt, url => session!.page(url), model, t, workerSignal));
          run.results.push(result);
        } catch (error) {
          const result = { name: task.name, status: signal.aborted ? 'cancelled' : 'failed', reason: String(error) };
          run.results.push(result); await t.event('worker.failed', result);
        } finally { await session?.close(); this.publish(run); }
      });
      await system.event('pipeline.phase.finished', { phase: 'workers', results: run.results.length });
      signal.throwIfAborted();
      run.status = !run.results.length ? 'blocked' : run.results.every(r => r.status === 'succeeded') ? 'succeeded' : 'completed_with_failures';
      await system.event('run.finished', { status: run.status, results: run.results });
    } catch (error) {
      run.status = signal.aborted ? 'cancelled' : 'failed';
      await system.event('run.failed', { status: run.status, error: String(error) });
    } finally {
      await Promise.allSettled([...sessions].map(s => s.close()));
      run.status = run.status === 'cancelling' ? 'cancelled' : run.status;
      const finalStatus = run.status;
      run.status = 'observing'; this.publish(run);
      await observer.stop();
      run.status = finalStatus;
      await this.log.flush();
    }
  }
}
