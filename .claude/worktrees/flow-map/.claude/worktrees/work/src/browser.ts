import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import Browserbase from '@browserbasehq/sdk';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Action, Snapshot, SessionInfo } from './types.js';
import type { Trace } from './telemetry.js';

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
export async function perform(page: Page, action: Action, trace: Trace, signal: AbortSignal) {
  signal.throwIfAborted();
  await trace.span('browser.action', async () => {
    await trace.event('action.attempt', { action });
    const locator = page.locator(action.selector);
    if (await locator.count() !== 1 || !await locator.isVisible()) throw new Error(`Action selector must match one visible element: ${action.selector}`);
    const target = await locator.evaluate(el => ({ type: el.getAttribute('type'), actionable: el.matches('a[href],button,input,select,textarea,[role="button"],[role="link"]') }));
    if (!target.actionable) throw new Error('Target is not an actionable element');
    if (target.type === 'password' || target.type === 'file') throw new Error('Unsupported input type');
    if (action.kind === 'click') await locator.click({ timeout: 10_000 });
    if (action.kind === 'fill') await locator.fill(action.value, { timeout: 10_000 });
    if (action.kind === 'select') await locator.selectOption(action.value, { timeout: 10_000 });
    if (action.kind === 'press') {
      if (!['Enter', 'Tab', 'Space', 'Escape', 'ArrowDown', 'ArrowUp'].includes(action.value)) throw new Error('Unsupported key');
      await locator.press(action.value, { timeout: 10_000 });
    }
    await settle(page);
    signal.throwIfAborted();
    await trace.event('action.result', { action, snapshot: await inspect(page) });
  });
}
export class BrowserSession {
  private contexts = new Set<BrowserContext>();
  private pending = new Set<Promise<unknown>>();
  private closePromise?: Promise<void>;
  constructor(private sdk: Browserbase, private browser: Browser, public info: SessionInfo, private trace: Trace,
    private publish: (info: SessionInfo) => void = () => {}) {}
  static async open(trace: Trace, publish: (info: SessionInfo) => void): Promise<BrowserSession> {
    // Browserbase is used strictly as a remote Chromium provider. Do not use
    // sdk.agents or any Browserbase task/agent endpoint here: navigation,
    // interaction, observation, and decisions belong to our own workers.
    const sdk = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY, timeout: 30_000, maxRetries: 1 });
    const session = await sdk.sessions.create({ projectId: process.env.BROWSERBASE_PROJECT_ID!, api_timeout: 1800,
      userMetadata: { ...trace.identity } });
    trace.identity.sessionId = session.id;
    try {
      await trace.event('session.created', { sessionId: session.id });
      // The only browser-control channel is Playwright over the session's CDP
      // endpoint. Browserbase does not receive a task or control the agent.
      const browser = await chromium.connectOverCDP(session.connectUrl, { timeout: 30_000 });
      const info: SessionInfo = { agentId: trace.identity.agentId, role: trace.identity.role, sessionId: session.id, liveUrl: '', status: 'running' };
      const owned = new BrowserSession(sdk, browser, info, trace, publish);
      try { info.liveUrl = (await sdk.sessions.debug(session.id)).debuggerFullscreenUrl; }
      catch (error) { await trace.event('session.live_view.failed', { error: String(error) }); }
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
    const origin = new URL(startUrl).origin;
    await context.route('**/*', async route => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame() === request.frame().page().mainFrame() && new URL(request.url()).origin !== origin) {
        await this.trace.event('navigation.blocked', { url: request.url() });
        await route.abort();
      } else await route.continue();
    });
    const page = await context.newPage();
    const record = (type: string, data: unknown) => {
      const task = this.trace.event(type, data).catch(error => console.error('Log write failed', String(error)));
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
      await this.trace.event('navigation.attempt', { url: startUrl });
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await settle(page);
      try {
        const debug = await this.sdk.sessions.debug(this.info.sessionId);
        this.info.liveUrl = debug.pages.find(p => p.url === page.url())?.debuggerFullscreenUrl || debug.debuggerFullscreenUrl;
        this.publish(this.info);
      } catch (error) { await this.trace.event('session.live_view.failed', { error: String(error) }); }
      return { page, dispose: async () => { await context.close(); this.contexts.delete(context); } };
    } catch (error) { await context.close(); this.contexts.delete(context); throw error; }
  }
  close() {
    return this.closePromise ??= (async () => {
      await Promise.allSettled([...this.contexts].map(c => c.close()));
      try {
        await this.sdk.sessions.update(this.info.sessionId, { projectId: process.env.BROWSERBASE_PROJECT_ID!, status: 'REQUEST_RELEASE' });
        this.info.status = 'closed';
        await this.trace.event('session.released');
      } catch (error) { this.info.status = 'release failed'; await this.trace.event('session.release.failed', { error: String(error) }); }
      await this.browser.close().catch(() => undefined);
      await Promise.allSettled([...this.pending]);
      this.publish(this.info);
    })();
  }
}
