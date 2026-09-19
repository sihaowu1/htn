import Browserbase from '@browserbasehq/sdk';

export type ReplayPage = {
  page_id: string;
  start_time_ms: number;
  end_time_ms: number;
  playlist_url: string;
};

export type ReplayResponse =
  | { status: 'available'; session_id: string; pages: ReplayPage[] }
  | { status: 'pending'; retry_after_ms: 2000 };

type BrowserbaseReplay = {
  pageCount: number;
  pages: Array<{ pageId: string; startTimeMs: number; endTimeMs: number; url: string }>;
};

export type ReplayClient = {
  sessions: { replays: { retrieve(sessionId: string): Promise<BrowserbaseReplay> } };
};

export class ReplayNotFoundError extends Error {}
export class ReplayProviderError extends Error {}

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  const value = candidate.status ?? candidate.statusCode;
  return typeof value === 'number' ? value : undefined;
}

export class ReplayService {
  constructor(
    private ownsSession: (runId: string, sessionId: string) => Promise<boolean>,
    private client?: ReplayClient,
  ) {}

  async get(runId: string, sessionId: string): Promise<ReplayResponse> {
    if (!await this.ownsSession(runId, sessionId)) {
      throw new ReplayNotFoundError('Run/session association not found');
    }
    let replay: BrowserbaseReplay;
    try {
      const client = this.client ??= new Browserbase({
        apiKey: process.env.BROWSERBASE_API_KEY,
        timeout: 30_000,
        maxRetries: 1,
      }) as ReplayClient;
      replay = await client.sessions.replays.retrieve(sessionId);
    } catch (error) {
      if (statusCode(error) === 404) throw new ReplayNotFoundError('Recording not found');
      throw new ReplayProviderError('Browserbase replay retrieval failed');
    }
    const pages = replay.pages
      .filter(page => page.url && Number.isFinite(page.startTimeMs) && Number.isFinite(page.endTimeMs))
      .map(page => ({ page_id: page.pageId, start_time_ms: page.startTimeMs,
        end_time_ms: page.endTimeMs, playlist_url: page.url }));
    if (!pages.length) return { status: 'pending', retry_after_ms: 2000 };
    return { status: 'available', session_id: sessionId, pages };
  }
}
