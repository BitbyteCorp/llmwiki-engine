import { randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Cron } from 'croner';
import { ApiError } from '../api/api-error.js';
import { AclService } from '../acl/acl.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CONFIG, LOGGER } from '../common/tokens.js';
import type { Config } from '../config.js';
import { EventsService } from '../events/events.service.js';
import { KnowledgeRepo, type CommitInfo, type Worktree } from '../knowledge/repo.js';
import type { Logger } from '../log.js';
import { AgentService } from '../agent/agent.service.js';
import { IndexerService } from '../rag/indexer.service.js';
import { SearchService } from '../rag/search.service.js';
import type { DreamRun } from './dream-run.types.js';
import { DreamRunsRepository } from './dream-runs.repository.js';

// Manual callers and the scheduler may use different service instances.
const activeRuns = new WeakMap<KnowledgeRepo, Promise<DreamRun>>();
const dateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
});

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ancestors(sha: string, history: Map<string, CommitInfo>, incremental = false): Set<string> {
  const result = new Set<string>();
  const pending = [sha];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (result.has(current)) continue;
    result.add(current);
    const commit = history.get(current);
    // git log checkpoint..main omits the checkpoint and all its ancestors.
    if (!commit) {
      if (incremental) continue;
      throw new Error(`Dreaming checkpoint commit is unavailable: ${current}`);
    }
    pending.push(...commit.parents);
  }
  return result;
}

@Injectable()
export class DreamingService implements OnApplicationShutdown {
  private scheduler: Cron | null = null;

  constructor(
    private readonly repo: KnowledgeRepo,
    private readonly agent: AgentService,
    private readonly indexer: IndexerService,
    private readonly search: SearchService,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(LOGGER) private readonly log: Logger,
    private readonly runs: DreamRunsRepository,
    private readonly events: EventsService,
    private readonly acl: AclService,
    private readonly audit: AuditService,
  ) {}

  start(): void {
    if (this.scheduler) return;
    this.scheduler = new Cron(this.config.dreamCron, {
      timezone: this.config.tzDream,
      protect: true,
      catch: (error) => this.log.error({ err: error }, 'Dreaming scheduler failed'),
    }, async () => { await this.runOnce(); });
  }

  async stop(): Promise<void> {
    this.scheduler?.stop();
    this.scheduler = null;
    await activeRuns.get(this.repo);
  }

  onApplicationShutdown(): Promise<void> {
    return this.stop();
  }

  runOnce(): Promise<DreamRun> {
    const existing = activeRuns.get(this.repo);
    if (existing) return existing;
    // Register before execution publishes its synchronous start event.
    const running = Promise.resolve().then(() => this.execute()).finally(() => activeRuns.delete(this.repo));
    activeRuns.set(this.repo, running);
    return running;
  }

  runManual(): Promise<DreamRun> {
    if (activeRuns.has(this.repo)) {
      return Promise.reject(new ApiError(409, 'dream_running', 'Dreaming is already running'));
    }
    return this.runOnce();
  }

  private async execute(): Promise<DreamRun> {
    const { repo, agent, indexer, config, log, runs } = this;
    const run: DreamRun = {
      id: randomUUID(), startedAt: new Date().toISOString(), finishedAt: null,
      status: 'running', fromSha: null, toSha: null, mergeSha: null, pushed: false, error: null,
      summary: null, changedPaths: [], journalPath: null,
      push: { status: 'pending', remote: null, sha: null, at: null, reason: null },
    };
    let worktree: Worktree | undefined;
    let recorded = false;
    // Dreaming is explicitly an unrestricted internal system process.
    const aclWarning = this.acl.list().length
      ? 'ACL warning: dreaming has unrestricted system access. Semantic paraphrase or copying across ACL boundaries cannot be guaranteed detectable.'
      : null;
    const fail = (error: unknown) => {
      run.status = 'failed';
      run.error = [run.error, errorText(error)].filter(Boolean).join('; ');
    };

    try {
      runs.create(run);
      recorded = true;
      if (aclWarning) {
        this.audit.record({ actorId: null, action: 'dreaming.acl_warning', target: run.id, outcome: 'warning', summary: aclWarning });
        log.warn({ runId: run.id }, aclWarning);
      }
      this.events.publish({ type: 'dream.updated', runId: run.id, status: run.status }, 'all');
      run.toSha = await repo.headSha();
      const checkpoint = runs.lastSuccessfulCheckpoint();
      // Pin incremental history to the sampled HEAD even if main advances
      // before git log runs. Only the first run needs complete history.
      const history = await repo.log({ sinceSha: checkpoint, limit: Number.MAX_SAFE_INTEGER });
      const bySha = new Map(history.map((commit) => [commit.sha, commit]));
      const toAncestors = ancestors(run.toSha, bySha, checkpoint !== undefined);
      run.fromSha = checkpoint ?? history.findLast((commit) =>
        toAncestors.has(commit.sha) && commit.parents.length === 0)?.sha ?? null;
      if (!run.fromSha) throw new Error('Dreaming requires an initial knowledge commit');
      if (!toAncestors.has(run.fromSha)) throw new Error('Dreaming checkpoint is not an ancestor of main');
      const commits = history.filter((commit) => toAncestors.has(commit.sha) && commit.sha !== run.fromSha).reverse();
      runs.setInputRange(run);

      // Include missed days after failures; only the captured batch is marked
      // learned. Assistant responses never enter the learning input.
      const messages = runs.unlearnedUserMessages(run.startedAt);

      if (commits.length > 0 || messages.length > 0) {
        const date = dateFormat.format(new Date(run.startedAt));
        const changes = (await repo.diffNames(run.fromSha, run.toSha)).filter((change) => change.path.endsWith('.md'));
        const changedNotes = await Promise.all(changes.map(async (change) => {
          const content = await repo.readFile(change.path, run.toSha!);
          const previous = content ?? await repo.readFile(change.oldPath ?? change.path, run.fromSha!);
          const hits = await this.search.search(`${change.path}\n${previous ?? ''}`, { limit: 6 });
          const similarNotes = await Promise.all(hits.filter((hit) => hit.path !== change.path).slice(0, 5)
            .map(async (hit) => ({ ...hit, content: await repo.readFile(hit.path, run.toSha!) })));
          return { change, content, similarNotes };
        }));
        worktree = await repo.createWorktree(`dream-${date}`);
        worktree.setCommitMetadata({ jobId: run.id, source: 'dreaming', requester: config.gitBotEmail });
        const author = { name: config.gitBotName, email: config.gitBotEmail };
        const journalPath = `journal/${date}.md`;
        const result = await agent.runAgent({
          instructions: `${await agent.baseInstructions()}\n\n${dreamInstructions(date, journalPath)}`,
          input: JSON.stringify({ date, fromSha: run.fromSha, toSha: run.toSha, commits, changedNotes, userMessages: messages }),
          tools: agent.worktreeTools(worktree, author),
        });
        run.summary = result.text || null;
        if (!(await worktree.read(journalPath))?.trim()) {
          throw new Error(`Dreaming did not write the required journal: ${journalPath}`);
        }
        run.journalPath = journalPath;
        await worktree.commit(`dreaming: ${date}`, author);
        const wt = worktree;
        await repo.withMergeLock(async () => {
          const merge = await wt.mergeMain();
          if (!merge.ok) {
            await agent.resolveConflicts(wt, merge.conflicts);
            await wt.finishMerge(author);
          }
          const previousHead = await repo.headSha();
          run.mergeSha = await wt.fastForwardMain();
          const changes = await repo.diffNames(previousHead, run.mergeSha);
          run.changedPaths = [...new Set(changes.flatMap((change) => change.oldPath
            ? [change.oldPath, change.path] : [change.path]))];
          this.events.publish({ type: 'main.updated', sha: run.mergeSha, paths: run.changedPaths }, 'all');
          await indexer.syncToHead();
          runs.markLearned(messages, new Date().toISOString());
        });
      }
      run.status = 'succeeded';
    } catch (error) {
      fail(error);
    } finally {
      if (worktree) {
        try { await worktree.dispose(); } catch (error) { fail(error); }
      }
      // Backup is independent of maintenance: even failures and idle days
      // must attempt to preserve already-merged main changes remotely.
      try {
        const result = await repo.withMergeLock(() => repo.pushMain());
        run.pushed = result.pushed;
        run.push = {
          status: result.pushed ? 'succeeded' : 'skipped',
          remote: result.remote ?? null, sha: result.sha ?? null,
          at: new Date().toISOString(), reason: result.reason ?? null,
        };
        if (!result.pushed) log.info({ reason: result.reason }, 'Dreaming backup push skipped');
      } catch (error) {
        run.push = { status: 'failed', remote: null, sha: null, at: new Date().toISOString(), reason: errorText(error) };
        fail(error);
      }
      run.finishedAt = new Date().toISOString();
      if (aclWarning) run.summary = [aclWarning, run.summary].filter(Boolean).join('\n\n');
      if (recorded) {
        runs.finish(run);
        this.events.publish({ type: 'dream.updated', runId: run.id, status: run.status }, 'all');
        await this.notify(run);
      }
    }
    if (run.status === 'failed') log.error({ runId: run.id, error: run.error }, 'Dreaming failed');
    else log.info({ runId: run.id, mergeSha: run.mergeSha, pushed: run.pushed }, 'Dreaming completed');
    return run;
  }

  private async notify(run: DreamRun): Promise<void> {
    if (!this.config.slackWebhookUrl) return;
    // Deliberate allowlist: neither the summary, note contents, input nor
    // error/reason strings may leave the engine through a webhook.
    const durationMs = Date.parse(run.finishedAt!) - Date.parse(run.startedAt);
    const text = `Dreaming ${run.status}; duration_ms=${durationMs}; merge_sha=${run.mergeSha ?? 'none'}; `
      + `push=${run.push.status}; push_sha=${run.push.sha ?? 'none'}`;
    try {
      const response = await fetch(this.config.slackWebhookUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }), signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`Slack returned HTTP ${response.status}`);
      await response.body?.cancel();
    } catch (error) {
      this.log.warn({ runId: run.id, err: error }, 'Dreaming Slack notification failed');
    }
  }
}

function dreamInstructions(date: string, journalPath: string): string {
  return `오늘은 한국 표준시(Asia/Seoul) ${date}다. dreaming 정리 작업을 수행한다.
입력 JSON의 커밋과 changedNotes는 직전 성공한 실행 이후 main의 변경이며 similarNotes는 관련 기존 노트다.
변경과 관련 노트를 읽고 근거에 따라 모순과 중복을 정리한다. 최신 근거가 불명확하면 열린 쟁점으로 남기고 지어내지 않는다.
깨진 위키링크와 index.md를 고치고 MEMORY.md의 낡은 항목을 정리한다. raw/ 원문은 불변으로 보존한다.
ACL 경계를 넘어 제한된 노트·사용자 자료의 내용이나 의미를 다른 권한 영역의 노트, 색인, 메모리, 일기에 복사·요약·의역하지 않는다. 이 시스템 작업은 전체 저장소를 읽을 수 있지만 공유 범위를 확대할 권한은 없다. 경계가 불명확하면 내용을 옮기지 않고 기존 영역에 보존한다.
userMessages에는 아직 학습하지 않은 사용자 발언만 있다. 사용자가 직접 말한 사실과 정정만 추출한다.
질문이나 요청을 사실로 바꾸지 않고 도니/assistant 답변을 재학습하지 않으며 대화를 덤프하지 않는다.
대화에서 추출하는 지식은 공용 위키에 공개된다는 점을 고려하고, 비밀값은 저장하지 않으며 개인정보는 마스킹한다.
${journalPath}에 오늘의 변경, 정리한 내용, 남은 쟁점을 요약한 한국어 일기를 반드시 작성한다.
동일 날짜 일기가 있으면 기존 내용을 보존하며 이번 정리 내용을 반영한다. 입력에 없는 새 사실은 만들지 않는다.
작성 규칙을 지켜 도구로 실제 파일을 편집하고 필요하면 의미 단위로 커밋한다. Git author는 도구에 설정된 봇이다.`;
}
