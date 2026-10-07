import { Inject, Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';
import { DB } from '../common/tokens.js';
import type { Db } from '../db/index.js';
import { IndexerService } from '../rag/indexer.service.js';

type HttpLabels = 'method' | 'route' | 'status';

@Injectable()
export class MetricsService {
  private readonly registry = new Registry();
  private readonly requests = new Counter<HttpLabels>({
    name: 'llmwiki_http_requests_total', help: 'Finished HTTP requests by registered route and status.',
    labelNames: ['method', 'route', 'status'], registers: [this.registry],
  });
  private readonly latency = new Histogram<HttpLabels>({
    name: 'llmwiki_http_request_duration_seconds', help: 'HTTP duration until response finish, including SSE connection lifetime.',
    labelNames: ['method', 'route', 'status'], buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 15, 60], registers: [this.registry],
  });
  private readonly queue = new Gauge<'status'>({
    name: 'llmwiki_write_queue_depth', help: 'Persisted nonterminal write jobs by status.',
    labelNames: ['status'], registers: [this.registry],
  });
  private readonly outcomes = new Counter<'result'>({
    name: 'llmwiki_write_jobs_total', help: 'Terminal write jobs retained in the database.',
    labelNames: ['result'], registers: [this.registry],
  });
  private readonly dreams = new Counter<'result'>({
    name: 'llmwiki_dream_runs_total', help: 'Terminal dream runs retained in the database.',
    labelNames: ['result'], registers: [this.registry],
  });
  private readonly dreamDuration = new Histogram<'result'>({
    name: 'llmwiki_dream_duration_seconds', help: 'Duration of terminal dream runs retained in the database.',
    labelNames: ['result'], buckets: [1, 10, 30, 60, 300, 900, 1800, 3600], registers: [this.registry],
  });
  private readonly indexLag = new Gauge({
    name: 'llmwiki_index_lag_seconds', help: 'Time since last completed index sync when HEAD differs; -1 if never synced.', registers: [this.registry],
  });
  private readonly indexStale = new Gauge({
    name: 'llmwiki_index_stale', help: 'One when indexed SHA differs from HEAD or no SHA is indexed.', registers: [this.registry],
  });
  private readonly pendingVectors = new Gauge({
    name: 'llmwiki_index_pending_vectors', help: 'Indexed chunks still awaiting embeddings.', registers: [this.registry],
  });

  constructor(@Inject(DB) private readonly db: Db, private readonly indexer: IndexerService) {}

  get contentType(): string { return this.registry.contentType; }

  observeRequest(method: string, route: string, status: number, seconds: number): void {
    const labels = { method, route, status: String(status) };
    this.requests.inc(labels);
    this.latency.observe(labels, seconds);
  }

  async scrape(): Promise<string> {
    const index = await this.indexer.status();
    const jobs = this.db.prepare('SELECT status, count(*) AS count FROM write_jobs GROUP BY status').all() as Array<{ status: string; count: number }>;
    const counts = new Map(jobs.map((job) => [job.status, job.count]));
    for (const status of ['queued', 'running', 'merging']) this.queue.set({ status }, counts.get(status) ?? 0);
    this.outcomes.reset();
    for (const result of ['succeeded', 'failed']) this.outcomes.inc({ result }, counts.get(result) ?? 0);

    const dreams = this.db.prepare("SELECT status, started_at, finished_at FROM dream_runs WHERE status IN ('succeeded', 'failed')").all() as Array<{ status: string; started_at: string; finished_at: string | null }>;
    this.dreams.reset();
    this.dreamDuration.reset();
    for (const result of ['succeeded', 'failed']) {
      this.dreams.inc({ result }, 0);
      this.dreamDuration.zero({ result });
    }
    for (const dream of dreams) {
      this.dreams.inc({ result: dream.status });
      if (dream.finished_at === null) continue;
      const seconds = (Date.parse(dream.finished_at) - Date.parse(dream.started_at)) / 1000;
      if (Number.isFinite(seconds) && seconds >= 0) this.dreamDuration.observe({ result: dream.status }, seconds);
    }
    const stale = index.indexedSha === null || index.indexedSha !== index.headSha;
    const lastSync = index.lastSyncAt === null ? NaN : Date.parse(index.lastSyncAt);
    this.indexStale.set(stale ? 1 : 0);
    this.indexLag.set(!stale ? 0 : Number.isFinite(lastSync) ? Math.max(0, (Date.now() - lastSync) / 1000) : -1);
    this.pendingVectors.set(index.pendingVectors);
    return this.registry.metrics();
  }
}
