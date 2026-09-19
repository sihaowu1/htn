import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { BrowserSession } from './browser.js';
import { config } from './config.js';
import { crawl } from './crawler/index.js';
import { pool, validateMap } from './flow.js';
import { OpenAIModel } from './model.js';
import { orchestratePaths } from './orchestrator/index.js';
import { executeNodeSequence } from './execution/node-sequence.js';
import { Sentry } from './telemetry.js';
import type { AgentExecutionContext, Harness } from './sdk/index.js';
import { type FlowMap, type Run } from './types.js';
import { executeSingleAction } from './worker.js';

export class Runner {
  runs = new Map<string, Run>();
  private active?: { run: Run; controller: AbortController; done: Promise<void> };
  constructor(public harness: Harness, private publish: (run: Run) => void) {}
  start(prompt: string, targetUrl: string, maxWorkers: number, supplied?: FlowMap, testSingleAction = false) {
    if (this.active) throw new Error('A run is already active');
    const run: Run = { id: randomUUID(), prompt, targetUrl, maxWorkers, status: 'starting', sessions: [], findings: [], results: [] };
    const controller = new AbortController();
    this.runs.set(run.id, run);
    const done = Promise.resolve().then(() => this.execute(run, controller, supplied, testSingleAction)).catch(async error => {
      run.status = 'failed';
      await this.harness.start_run({ goal: run.prompt, run_id: run.id }).then(runCtx =>
        this.harness.register_agent_execution(runCtx, { agent_id: 'system' })).then(system =>
        this.harness.emit_event(system, { event_type: 'run.failed', metadata: { error: String(error) } })).catch(() => undefined);
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
    const { harness } = this;
    const runCtx = await harness.start_run({ goal: run.prompt, run_id: run.id });
    const system = await harness.register_agent_execution(runCtx, { agent_id: 'system' });
    const model = new OpenAIModel();
    const sessions = new Set<BrowserSession>();
    const open = async (agent: AgentExecutionContext, scope: AbortSignal) => {
      scope.throwIfAborted();
      const session = await BrowserSession.open(harness, agent, info => {
        if (!run.sessions.some(s => s.sessionId === info.sessionId)) run.sessions.push(info);
        this.publish(run);
      });
      sessions.add(session);
      const close = () => { void session.close(); };
      scope.addEventListener('abort', close, { once: true });
      if (scope.aborted) { await session.close(); scope.throwIfAborted(); }
      return session;
    };
    const emit = (agent: AgentExecutionContext, event_type: string, metadata: Record<string, unknown>) =>
      harness.emit_event(agent, { event_type, metadata });
    await emit(system, 'run.started', { prompt: run.prompt, targetUrl: run.targetUrl, maxWorkers: run.maxWorkers });
    try {
      if (testSingleAction) {
        run.status = 'running';
        run.plan = { summary: 'Execute one simple task using only controls from the initial page, without discovery', paths: [], skipped: [] };
        this.publish(run);
        await emit(system, 'test.single_action.enabled', { discovery: false });
        const worker = await harness.register_agent_execution(runCtx, { agent_id: 'worker-1' });
        const workerSignal = AbortSignal.any([signal, AbortSignal.timeout(config.workerTimeout)]);
        const session = await open(worker, workerSignal);
        try {
          run.results.push(await Sentry.startSpan({ name: 'worker', op: 'agent',
            attributes: { run_id: run.id, agent_execution_id: worker.agent_execution_id } }, () =>
            harness.wrapToolCall(worker, () => executeSingleAction(run.prompt, run.targetUrl,
              url => session.page(url), model, harness, worker, workerSignal), { name: 'worker' })));
        } finally { await session.close(); this.publish(run); }
        run.status = 'succeeded';
        await emit(system, 'run.finished', { status: run.status, results: run.results });
        return;
      }
      const resolveFlowMap = async () => {
        run.status = 'discovering'; this.publish(run);
        await emit(system, 'pipeline.phase.started', { phase: 'sitemap_or_crawler' });
        if (supplied) {
          run.map = validateMap(supplied, run.targetUrl);
          await emit(system, 'map.imported', { status: run.map.status });
        } else {
          const crawler = await harness.register_agent_execution(runCtx, { agent_id: 'crawler' });
          const discoverySignal = AbortSignal.any([signal, AbortSignal.timeout(config.crawlTimeout)]);
          try {
            run.map = await Sentry.startSpan({ name: 'discovery', op: 'agent',
              attributes: { run_id: run.id, agent_execution_id: crawler.agent_execution_id } }, () =>
              harness.wrapToolCall(crawler, () => crawl(run.targetUrl, run.prompt, model, harness, crawler, discoverySignal,
                map => { run.map = map; this.publish(run); }), { name: 'discovery' }));
          } catch (error) {
            if (signal.aborted || !run.map) throw error;
            const note = `Discovery stopped at the ${config.crawlTimeout} ms crawl timeout; unexplored branches remain.`;
            run.map = { ...run.map, status: 'limited', notes: [...run.map.notes, note] };
            await emit(crawler, 'discovery.timeout', { note, states: run.map.states.length, transitions: run.map.transitions.length });
          }
          await mkdir('logs', { recursive: true });
          await writeFile('logs/bestbuy_tree.json', JSON.stringify(run.map, null, 2) + '\n', 'utf8');
          await emit(system, 'map.saved', { file: 'logs/bestbuy_tree.json' });
        }
        await emit(system, 'pipeline.phase.finished', { phase: 'sitemap_or_crawler', mapStatus: run.map.status });
        return run.map;
      };
      const createPlan = async (map: FlowMap) => {
        signal.throwIfAborted();
        run.status = 'planning'; this.publish(run);
        await emit(system, 'pipeline.phase.started', { phase: 'orchestrator' });
        const orchestrator = await harness.register_agent_execution(runCtx, { agent_id: 'orchestrator' });
        const { plan, file } = await Sentry.startSpan({ name: 'orchestration', op: 'agent',
          attributes: { run_id: run.id, agent_execution_id: orchestrator.agent_execution_id } }, () =>
          harness.wrapToolCall(orchestrator, () =>
            orchestratePaths(map, run.prompt, run.id, model, harness, orchestrator, signal), { name: 'orchestration' }));
        run.plan = plan;
        await emit(orchestrator, 'plan.created', { ...plan, file });
        await emit(system, 'pipeline.phase.finished', { phase: 'orchestrator', paths: plan.paths.length, file });
        return plan;
      };

      // These awaits are intentional phase barriers. No worker session can be
      // created until map resolution and orchestration have both completed.
      const map = await resolveFlowMap();
      signal.throwIfAborted();
      const plan = await createPlan(map);
      signal.throwIfAborted();
      run.status = 'running'; this.publish(run);
      await emit(system, 'pipeline.phase.started', { phase: 'workers', paths: plan.paths.length });
      await pool(plan.paths, run.maxWorkers, signal, async (task, index) => {
        const worker = await harness.register_agent_execution(runCtx, { agent_id: `worker-${index + 1}`, assigned_task: task.name });
        const workerSignal = AbortSignal.any([signal, AbortSignal.timeout(config.workerTimeout)]);
        let session: BrowserSession | undefined;
        try {
          await emit(worker, 'agent.started', { assignedTask: task.name, instructions: task.instructions });
          session = await open(worker, workerSignal);
          const result = await Sentry.startSpan({ name: 'worker', op: 'agent',
            attributes: { run_id: run.id, agent_execution_id: worker.agent_execution_id } }, () =>
            harness.wrapToolCall(worker, () => executeNodeSequence(task, map, run.prompt,
              url => session!.page(url), model, harness, worker, workerSignal, instruction => {
                if (!session) return;
                session.info.instruction = instruction;
                this.publish(run);
              }), { name: 'worker', arguments: { task: task.name } }));
          run.results.push(result);
          await harness.finish_execution(worker, { outcome: result.status, summary: result.reason });
        } catch (error) {
          const result = { name: task.name, status: signal.aborted ? 'cancelled' : 'failed', reason: String(error) };
          run.results.push(result); await emit(worker, 'worker.failed', result);
        } finally {
          if (session && !signal.aborted && config.workerLinger > 0) {
            await emit(worker, 'worker.linger.started', { ms: config.workerLinger });
            await new Promise<void>(resolve => {
              const timer = setTimeout(resolve, config.workerLinger);
              signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
            });
          }
          await session?.close(); this.publish(run);
        }
      });
      await emit(system, 'pipeline.phase.finished', { phase: 'workers', results: run.results.length });
      signal.throwIfAborted();
      run.status = !run.results.length ? 'blocked' : run.results.every(r => r.status === 'succeeded') ? 'succeeded' : 'completed_with_failures';
      await emit(system, 'run.finished', { status: run.status, results: run.results });
    } catch (error) {
      run.status = signal.aborted ? 'cancelled' : 'failed';
      await emit(system, 'run.failed', { status: run.status, error: String(error) });
    } finally {
      await Promise.allSettled([...sessions].map(s => s.close()));
      run.status = run.status === 'cancelling' ? 'cancelled' : run.status;
    }
  }
}
