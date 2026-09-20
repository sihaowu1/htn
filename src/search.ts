import { Client } from '@elastic/elasticsearch';
import { config } from './config.js';

const SECRET_KEY = /(authorization|cookie|password|passwd|secret|token|api[_-]?key|credential)/i;
const BASE64_VALUE = /^[A-Za-z0-9+/]{512,}={0,2}$/;
const MAX_TEXT = 8_000;

export type SearchHit = {
  id: string;
  score: number;
  highlights: string[];
  source: Record<string, any>;
};

export type SearchResult = { hits: SearchHit[]; total: number };

export interface SearchService {
  readonly available: boolean;
  initialize(): Promise<void>;
  indexDocuments(items: Array<{ kind: 'event' | 'investigation'; id: string; payload: Record<string, unknown> }>): Promise<void>;
  searchRunEvidence(input: { runId: string; query: string; eventTypes?: string[]; agentIds?: string[];
    before?: string; after?: string; limit: number }): Promise<SearchResult>;
  findSimilarIncidents(input: { runId: string; query: string; eventType?: string;
    causeCategory?: string; limit: number }): Promise<SearchResult>;
  searchEvents(input: { runId: string; query: string; type?: string; agent?: string;
    limit: number; offset: number }): Promise<SearchResult>;
  searchRuns(input: { query: string; status?: string; workflowType?: string; failureCategory?: string;
    investigationStatus?: string; from?: string; to?: string; limit: number; offset: number }): Promise<SearchResult>;
  rebuildIndex(kind: 'event' | 'investigation', loadPage: (offset: number, limit: number) =>
    Promise<Array<{ id: string; payload: Record<string, unknown> }>>): Promise<number>;
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    if (BASE64_VALUE.test(value) || value.startsWith('data:')) return undefined;
    return value.slice(0, MAX_TEXT);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

export function searchableMetadata(input: unknown): { metadata_text: string; fields: Record<string, string> } {
  const text: string[] = [];
  const fields: Record<string, string> = {};
  const visit = (value: unknown, path: string, depth: number) => {
    if (depth > 5 || text.join(' ').length >= MAX_TEXT || SECRET_KEY.test(path)) return;
    const scalar = scalarText(value);
    if (scalar !== undefined) {
      text.push(scalar);
      const key = path.split('.').at(-1) || '';
      if (['status', 'outcome', 'tool', 'operation', 'name', 'code', 'error', 'reason', 'message', 'check', 'url']
        .includes(key)) fields[key] = scalar.slice(0, 2_000);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 50)) visit(item, path, depth + 1);
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
        visit(child, path ? `${path}.${key}` : key, depth + 1);
      }
    }
  };
  visit(input, '', 0);
  return { metadata_text: text.join(' ').slice(0, MAX_TEXT), fields };
}

export const searchMappings = {
  dynamic: false,
  properties: {
    document_kind: { type: 'keyword' }, event_id: { type: 'keyword' }, investigation_id: { type: 'keyword' },
    run_id: { type: 'keyword' }, agent_execution_id: { type: 'keyword' }, agent_id: { type: 'keyword' },
    assigned_task: { type: 'text' }, run_goal: { type: 'text' }, event_type: { type: 'keyword' },
    occurred_at: { type: 'date' }, created_at: { type: 'date' }, session_id: { type: 'keyword' },
    trace_id: { type: 'keyword' }, status: { type: 'keyword' }, outcome: { type: 'keyword' },
    workflow_type: { type: 'keyword' }, investigation_status: { type: 'keyword' },
    cause_category: { type: 'keyword' }, confidence: { type: 'keyword' },
    tool: { type: 'text' }, operation: { type: 'text' }, error: { type: 'text' }, message: { type: 'text' },
    reason: { type: 'text' }, check: { type: 'text' }, url: { type: 'text' }, metadata_text: { type: 'text' },
    title: { type: 'text' }, summary: { type: 'text' }, observed_failure: { type: 'text' },
    cause_explanation: { type: 'text' }, suggested_next_step: { type: 'text' }, reproduction_step: { type: 'text' },
  },
} as const;

export class ElasticsearchService implements SearchService {
  readonly available: boolean;
  private client?: Client;
  private eventsAlias: string;
  private investigationsAlias: string;

  constructor(input: { enabled?: boolean; url?: string; apiKey?: string; prefix?: string; timeout?: number } = {}) {
    const enabled = input.enabled ?? config.elasticsearchEnabled;
    const url = input.url ?? config.elasticsearchUrl;
    const apiKey = input.apiKey ?? config.elasticsearchApiKey;
    const prefix = input.prefix ?? config.elasticsearchIndexPrefix;
    this.available = Boolean(enabled && url && apiKey);
    this.eventsAlias = `${prefix}-events`;
    this.investigationsAlias = `${prefix}-investigations`;
    if (this.available) this.client = new Client({ node: url, auth: { apiKey },
      requestTimeout: input.timeout ?? config.elasticsearchTimeoutMs });
  }

  async initialize() {
    if (!this.client) return;
    await this.ensureIndex(this.eventsAlias, `${this.eventsAlias}-v1`);
    await this.ensureIndex(this.investigationsAlias, `${this.investigationsAlias}-v1`);
  }

  private async ensureIndex(alias: string, index: string) {
    const exists = await this.client!.indices.existsAlias({ name: alias });
    if (exists) return;
    const indexExists = await this.client!.indices.exists({ index });
    if (!indexExists) await this.client!.indices.create({ index, mappings: searchMappings });
    await this.client!.indices.updateAliases({ actions: [{ add: { index, alias, is_write_index: true } }] });
  }

  async indexDocuments(items: Array<{ kind: 'event' | 'investigation'; id: string; payload: Record<string, unknown> }>) {
    if (!this.client || !items.length) return;
    const operations = items.flatMap(item => [
      { index: { _index: item.kind === 'event' ? this.eventsAlias : this.investigationsAlias, _id: item.id } },
      item.payload,
    ]);
    const response = await this.client.bulk({ refresh: false, operations });
    if (response.errors) {
      const failures = response.items.filter(item => item.index?.error).map(item => item.index?.error?.reason).filter(Boolean);
      throw new Error(`Elasticsearch bulk indexing failed: ${failures.slice(0, 3).join('; ')}`);
    }
  }

  private hits(response: any): SearchResult {
    const values = response.hits?.hits || [];
    const total = typeof response.hits?.total === 'number' ? response.hits.total : Number(response.hits?.total?.value || 0);
    return { total, hits: values.map((hit: any) => ({ id: hit._id, score: Number(hit._score || 0),
      highlights: Object.values(hit.highlight || {}).flat().map(String).slice(0, 5), source: hit._source || {} })) };
  }

  async searchRunEvidence(input: { runId: string; query: string; eventTypes?: string[]; agentIds?: string[];
    before?: string; after?: string; limit: number }) {
    if (!this.client) throw new Error('Elasticsearch is not configured');
    const filter: any[] = [{ term: { run_id: input.runId } }];
    if (input.eventTypes?.length) filter.push({ terms: { event_type: input.eventTypes } });
    if (input.agentIds?.length) filter.push({ terms: { agent_id: input.agentIds } });
    if (input.before || input.after) filter.push({ range: { occurred_at: { ...(input.before ? { lt: input.before } : {}), ...(input.after ? { gt: input.after } : {}) } } });
    const response = await this.client.search({ index: this.eventsAlias, size: input.limit,
      query: { bool: { filter, must: [this.textQuery(input.query)] } }, highlight: this.highlight() });
    return this.hits(response);
  }

  async findSimilarIncidents(input: { runId: string; query: string; eventType?: string; causeCategory?: string; limit: number }) {
    if (!this.client) throw new Error('Elasticsearch is not configured');
    const filter: any[] = [];
    if (input.eventType) filter.push({ term: { event_type: input.eventType } });
    if (input.causeCategory) filter.push({ term: { cause_category: input.causeCategory } });
    const response = await this.client.search({ index: this.investigationsAlias, size: input.limit,
      query: { bool: { filter, must_not: [{ term: { run_id: input.runId } }], must: [this.textQuery(input.query)] } },
      highlight: this.highlight() });
    return this.hits(response);
  }

  async searchEvents(input: { runId: string; query: string; type?: string; agent?: string; limit: number; offset: number }) {
    if (!this.client) throw new Error('Elasticsearch is not configured');
    const filter: any[] = [{ term: { run_id: input.runId } }];
    if (input.type) filter.push({ term: { event_type: input.type } });
    if (input.agent) filter.push({ term: { agent_id: input.agent } });
    return this.hits(await this.client.search({ index: this.eventsAlias, from: input.offset, size: input.limit,
      query: { bool: { filter, must: [this.textQuery(input.query)] } }, highlight: this.highlight() }));
  }

  async searchRuns(input: { query: string; status?: string; workflowType?: string; failureCategory?: string;
    investigationStatus?: string; from?: string; to?: string; limit: number; offset: number }) {
    if (!this.client) throw new Error('Elasticsearch is not configured');
    const filter: any[] = [];
    if (input.status) filter.push({ term: { status: input.status } });
    if (input.workflowType) filter.push({ term: { workflow_type: input.workflowType } });
    if (input.failureCategory) filter.push({ term: { cause_category: input.failureCategory } });
    if (input.investigationStatus) filter.push({ term: { investigation_status: input.investigationStatus } });
    if (input.from || input.to) filter.push({ range: { created_at: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) } } });
    const result = await this.client.search({ index: [this.eventsAlias, this.investigationsAlias],
      from: input.offset, size: input.limit, query: { bool: { filter, must: [this.textQuery(input.query)] } },
      collapse: { field: 'run_id' }, aggs: { unique_runs: { cardinality: { field: 'run_id', precision_threshold: 40000 } } },
      highlight: this.highlight() });
    const parsed = this.hits(result);
    return { hits: parsed.hits.map(hit => ({ ...hit, id: String(hit.source.run_id) })),
      total: Number((result.aggregations as any)?.unique_runs?.value || parsed.total) };
  }

  async rebuildIndex(kind: 'event' | 'investigation', loadPage: (offset: number, limit: number) =>
    Promise<Array<{ id: string; payload: Record<string, unknown> }>>) {
    if (!this.client) throw new Error('Elasticsearch is not configured');
    const alias = kind === 'event' ? this.eventsAlias : this.investigationsAlias;
    const index = `${alias}-v${Date.now()}`;
    await this.client.indices.create({ index, mappings: searchMappings });
    let offset = 0;
    try {
      for (;;) {
        const page = await loadPage(offset, 500);
        if (!page.length) break;
        const operations = page.flatMap(item => [{ index: { _index: index, _id: item.id } }, item.payload]);
        const response = await this.client.bulk({ operations, refresh: false });
        if (response.errors) throw new Error(`Elasticsearch backfill failed for ${kind} documents`);
        offset += page.length;
      }
      await this.client.indices.refresh({ index });
      const current = await this.client.indices.getAlias({ name: alias }).catch(() => ({} as any));
      const actions: any[] = Object.keys(current).map(old => ({ remove: { index: old, alias } }));
      actions.push({ add: { index, alias, is_write_index: true } });
      await this.client.indices.updateAliases({ actions });
      return offset;
    } catch (error) {
      await this.client.indices.delete({ index }).catch(() => undefined);
      throw error;
    }
  }

  private textQuery(query: string): any {
    return { multi_match: { query, type: 'best_fields', fuzziness: 'AUTO', fields: [
      'event_type^4', 'agent_id^3', 'run_goal^3', 'assigned_task^2', 'error^4', 'message^3', 'reason^3',
      'operation^3', 'tool^3', 'check^3', 'url', 'metadata_text', 'title^3', 'summary^2',
      'observed_failure^4', 'cause_explanation^3', 'suggested_next_step', 'reproduction_step',
    ] } };
  }

  private highlight(): any {
    return { pre_tags: [''], post_tags: [''], number_of_fragments: 2, fragment_size: 160,
      fields: { '*': {} } };
  }
}

export function createSearchService(): SearchService {
  return new ElasticsearchService();
}
