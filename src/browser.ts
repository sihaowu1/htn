import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import Browserbase from '@browserbasehq/sdk';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Action, Snapshot, SessionInfo } from './types.js';
import { Sentry } from './telemetry.js';
import type { AgentExecutionContext, Harness } from './sdk/index.js';
import { FIXTURE_LOGIN_PASSWORD, FIXTURE_PASSWORD_TOKEN } from './fixture-credentials.js';

const snapshotScript = await readFile(new URL('../scripts/dom-snapshot.js', import.meta.url), 'utf8');

export function fingerprint(snapshot: Pick<Snapshot, 'url' | 'dom' | 'elements'>) {
  const url = new URL(snapshot.url);
  return createHash('sha256').update(JSON.stringify({ path: url.pathname + url.search + url.hash,
    dom: snapshot.dom, values: snapshot.elements.map(e => [e.selector, e.value]) })).digest('hex');
}
export async function inspect(page: Page): Promise<Snapshot> {
  const result = await page.evaluate(snapshotScript) as Omit<Snapshot, 'fingerprint'>;
  if (result.dom.length > 150_000 || result.elements.length > 1000) throw new Error('Page exceeds MVP DOM size limit; use a smaller target or supplied flow map');
  return { ...result, fingerprint: fingerprint(result) };
}
export async function settle(page: Page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => undefined);
}
export function pageLiveViewUrl(pages: Array<{ url: string; debuggerFullscreenUrl: string }>, pageUrl: string) {
  return pages.find(candidate => candidate.url === pageUrl)?.debuggerFullscreenUrl || '';
}
async function emitSnapshotEvent(harness: Harness, agent: AgentExecutionContext, eventType: string,
  metadata: Record<string, unknown>, snapshot: Snapshot): Promise<void> {
  try {
    await harness.emit_event(agent, { event_type: eventType, metadata: { ...metadata, snapshot } });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'MetadataTooLargeError') throw error;
    const { artifact_id: snapshotRef, size_bytes: snapshotBytes } = await harness.store_payload(agent,
      { kind: 'page-snapshot', value: snapshot });
    await harness.emit_event(agent, { event_type: eventType, metadata: { ...metadata,
      snapshot_ref: snapshotRef, snapshot_bytes: snapshotBytes, url: snapshot.url, title: snapshot.title,
      fingerprint: snapshot.fingerprint, text_length: snapshot.text.length, element_count: snapshot.elements.length } });
  }
}

export async function perform(page: Page, action: Action, harness: Harness, agent: AgentExecutionContext, signal: AbortSignal) {
  signal.throwIfAborted();
  await Sentry.startSpan({ name: 'browser.action', op: 'agent',
    attributes: { run_id: agent.run_id, agent_execution_id: agent.agent_execution_id,
      action_kind: action.kind, action_selector: action.selector } }, () =>
    harness.wrapToolCall(agent, async () => {
      await harness.emit_event(agent, { event_type: 'action.attempt', metadata: { action } });
      const locator = page.locator(action.selector);
      if (await locator.count() !== 1 || !await locator.isVisible()) throw new Error(`Action selector must match one visible element: ${action.selector}`);
      const target = await locator.evaluate(el => ({ type: el.getAttribute('type'), actionable: el.matches('a[href],button,input,select,textarea,[role="button"],[role="link"]') }));
      if (!target.actionable) throw new Error('Target is not an actionable element');
      if (target.type === 'file') throw new Error('Unsupported input type');
      if (target.type === 'password' && (action.kind !== 'fill' || action.value !== FIXTURE_PASSWORD_TOKEN)) {
        throw new Error('Password inputs only accept the configured fixture credential token');
      }
      if (action.kind === 'click') await locator.click({ timeout: 10_000 });
      if (action.kind === 'fill') await locator.fill(action.value === FIXTURE_PASSWORD_TOKEN ? FIXTURE_LOGIN_PASSWORD : action.value, { timeout: 10_000 });
      if (action.kind === 'select') await locator.selectOption(action.value, { timeout: 10_000 });
      if (action.kind === 'press') {
        if (!['Enter', 'Tab', 'Space', 'Escape', 'ArrowDown', 'ArrowUp'].includes(action.value)) throw new Error('Unsupported key');
        await locator.press(action.value, { timeout: 10_000 });
      }
      await settle(page);
      signal.throwIfAborted();
      await emitSnapshotEvent(harness, agent, 'action.result', { action }, await inspect(page));
    }, { name: 'browser.action', arguments: { action } }));
}
export class BrowserSession {
  private contexts = new Set<BrowserContext>();
  private displayed?: { context: BrowserContext; liveUrl: string };
  private deferredDisposals = new Set<BrowserContext>();
  private pending = new Set<Promise<unknown>>();
  private closePromise?: Promise<void>;
  constructor(private sdk: Browserbase, private browser: Browser, public info: SessionInfo,
    private harness: Harness, private agent: AgentExecutionContext,
    private publish: (info: SessionInfo) => void = () => {}) {}
  static async open(harness: Harness, agent: AgentExecutionContext, publish: (info: SessionInfo) => void,
    role = 'worker'): Promise<BrowserSession> {
    // Browserbase is used strictly as a remote Chromium provider. Do not use
    // sdk.agents or any Browserbase task/agent endpoint here: navigation,
    // interaction, observation, and decisions belong to our own workers.
    const sdk = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY, timeout: 30_000, maxRetries: 1 });
    const session = await sdk.sessions.create({ projectId: process.env.BROWSERBASE_PROJECT_ID!, api_timeout: 1800,
      userMetadata: { run_id: agent.run_id, agent_execution_id: agent.agent_execution_id, agent_id: agent.agent_id } });
    agent.setSessionId(session.id);
    try {
      await harness.emit_event(agent, { event_type: 'session.created', metadata: { sessionId: session.id } });
      // The only browser-control channel is Playwright over the session's CDP
      // endpoint. Browserbase does not receive a task or control the agent.
      const browser = await chromium.connectOverCDP(session.connectUrl, { timeout: 30_000 });
      const info: SessionInfo = { agentId: agent.agent_id, role, sessionId: session.id, liveUrl: '', status: 'running' };
      const owned = new BrowserSession(sdk, browser, info, harness, agent, publish);
      // Do not publish the session-level debugger URL here. At creation time it
      // targets Browserbase's initial about:blank tab; page() publishes the URL
      // for the page after navigation instead.
      publish(info);
      return owned;
    } catch (error) {
      await sdk.sessions.update(session.id, { projectId: process.env.BROWSERBASE_PROJECT_ID!, status: 'REQUEST_RELEASE' }).catch(() => undefined);
      throw error;
    }
  }
  async page(startUrl: string) {
    const context = await this.browser.newContext();
    this.contexts.add(context);
    // Free ngrok endpoints show an interstitial warning to normal browsers.
    // This header tells ngrok that the request is coming from an automated
    // client, so discovery and workers see the target site immediately.
    await context.setExtraHTTPHeaders({ 'ngrok-skip-browser-warning': 'true' });
    const origin = new URL(startUrl).origin;
    await context.route('**/*', async route => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame() === request.frame().page().mainFrame() && new URL(request.url()).origin !== origin) {
        await this.harness.emit_event(this.agent, { event_type: 'navigation.blocked', metadata: { url: request.url() } });
        await route.abort();
      } else await route.continue();
    });
    const page = await context.newPage();
    const record = (type: string, data: unknown) => {
      const metadata = (data && typeof data === 'object' ? data : { value: data }) as Record<string, unknown>;
      const task = this.harness.emit_event(this.agent, { event_type: type, metadata })
        .catch(error => console.error('Log write failed', String(error)));
      this.pending.add(task); void task.finally(() => this.pending.delete(task));
    };
    page.on('console', msg => record('browser.console', { level: msg.type(), text: msg.text() }));
    page.on('pageerror', error => record('browser.error', { error: error.message }));
    page.on('requestfailed', req => record('request.failed', { url: req.url(), error: req.failure()?.errorText }));
    page.on('response', response => { if (response.status() >= 400) record('http.error', { url: response.url(), status: response.status() }); });
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) record('browser.navigation', { url: frame.url() }); });
    page.on('dialog', async dialog => { record('browser.dialog', { type: dialog.type(), message: dialog.message() }); await dialog.dismiss().catch(() => undefined); });
    page.on('popup', popup => { record('browser.unsupported', { reason: 'Popup closed; multi-tab flows are unsupported' }); void popup.close(); });
    try {
      let pageLiveUrl = '';
      await this.harness.emit_event(this.agent, { event_type: 'navigation.attempt', metadata: { url: startUrl } });
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await settle(page);
      // Use the live view for the actual page created in this context. The
      // session-level URL can point at Browserbase's default about:blank tab.
      let liveViewError: unknown;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const debug = await this.sdk.sessions.debug(this.info.sessionId);
          pageLiveUrl = pageLiveViewUrl(debug.pages, page.url());
          if (pageLiveUrl) {
            const previous = this.displayed;
            this.displayed = { context, liveUrl: pageLiveUrl };
            this.info.liveUrl = pageLiveUrl;
            this.publish(this.info);
            // Discovery uses fresh contexts to preserve replay isolation. Keep
            // the old displayed context alive until its replacement is ready,
            // then retire it without exposing the handoff in the UI.
            if (previous && previous.context !== context && this.deferredDisposals.delete(previous.context)) {
              await previous.context.close().catch(() => undefined);
              this.contexts.delete(previous.context);
            }
            break;
          } else if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          liveViewError = error;
          if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      if (!this.info.liveUrl && liveViewError) {
        await this.harness.emit_event(this.agent, { event_type: 'session.live_view.failed', metadata: { error: String(liveViewError) } });
      }
      return { page, dispose: async () => {
        if (this.displayed?.context === context) {
          this.deferredDisposals.add(context);
          return;
        }
        await context.close(); this.contexts.delete(context);
      } };
    } catch (error) { await context.close(); this.contexts.delete(context); throw error; }
  }
  close() {
    return this.closePromise ??= (async () => {
      this.info.liveUrl = '';
      this.publish(this.info);
      await Promise.allSettled([...this.contexts].map(c => c.close()));
      this.contexts.clear();
      this.deferredDisposals.clear();
      this.displayed = undefined;
      try {
        await this.sdk.sessions.update(this.info.sessionId, { projectId: process.env.BROWSERBASE_PROJECT_ID!, status: 'REQUEST_RELEASE' });
        this.info.status = 'closed';
        await this.harness.emit_event(this.agent, { event_type: 'session.released', metadata: {} });
      } catch (error) { this.info.status = 'release failed'; await this.harness.emit_event(this.agent, { event_type: 'session.release.failed', metadata: { error: String(error) } }); }
      await this.browser.close().catch(() => undefined);
      await Promise.allSettled([...this.pending]);
      this.publish(this.info);
    })();
  }
}
