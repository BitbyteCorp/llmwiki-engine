import { randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Cron } from 'croner';
import { CONFIG, LOGGER } from '../common/tokens.js';
import type { Config } from '../config.js';
import { KnowledgeRepo, type CommitInfo, type Worktree } from '../knowledge/repo.js';
import type { Logger } from '../log.js';
import { LunaService } from '../luna/luna.service.js';
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
    private readonly luna: LunaService,
    private readonly indexer: IndexerService,
    private readonly search: SearchService,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(LOGGER) private readonly log: Logger,
    private readonly runs: DreamRunsRepository,
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
    const running = this.execute().finally(() => activeRuns.delete(this.repo));
    activeRuns.set(this.repo, running);
    return running;
  }

  private async execute(): Promise<DreamRun> {
    const { repo, luna, indexer, config, log, runs } = this;
    const run: DreamRun = {
      id: randomUUID(), startedAt: new Date().toISOString(), finishedAt: null,
      status: 'running', fromSha: null, toSha: null, mergeSha: null, pushed: false, error: null,
    };
    let worktree: Worktree | undefined;
    let recorded = false;
    const fail = (error: unknown) => {
      run.status = 'failed';
      run.error = [run.error, errorText(error)].filter(Boolean).join('; ');
    };

    try {
      runs.create(run);
      recorded = true;
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
        const author = { name: config.gitBotName, email: config.gitBotEmail };
        const journalPath = `journal/${date}.md`;
        await luna.runAgent({
          instructions: `${await luna.baseInstructions()}\n\n${dreamInstructions(date, journalPath)}`,
          input: JSON.stringify({ date, fromSha: run.fromSha, toSha: run.toSha, commits, changedNotes, userMessages: messages }),
          tools: luna.worktreeTools(worktree, author),
        });
        if (!(await worktree.read(journalPath))?.trim()) {
          throw new Error(`Dreaming did not write the required journal: ${journalPath}`);
        }
        await worktree.commit(`dreaming: ${date}`, author);
        const wt = worktree;
        await repo.withMergeLock(async () => {
          const merge = await wt.mergeMain();
          if (!merge.ok) {
            await luna.resolveConflicts(wt, merge.conflicts);
            await wt.finishMerge(author);
          }
          run.mergeSha = await wt.fastForwardMain();
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
        const result = await repo.pushMain();
        run.pushed = result.pushed;
        if (!result.pushed) log.info({ reason: result.reason }, 'Dreaming backup push skipped');
      } catch (error) {
        fail(error);
      }
      run.finishedAt = new Date().toISOString();
      if (recorded) runs.finish(run);
    }
    if (run.status === 'failed') log.error({ runId: run.id, error: run.error }, 'Dreaming failed');
    else log.info({ runId: run.id, mergeSha: run.mergeSha, pushed: run.pushed }, 'Dreaming completed');
    return run;
  }
}

function dreamInstructions(date: string, journalPath: string): string {
  return `오늘은 한국 표준시(Asia/Seoul) ${date}다. dreaming 정리 작업을 수행한다.
입력 JSON의 커밋과 changedNotes는 직전 성공한 실행 이후 main의 변경이며 similarNotes는 관련 기존 노트다.
변경과 관련 노트를 읽고 근거에 따라 모순과 중복을 정리한다. 최신 근거가 불명확하면 열린 쟁점으로 남기고 지어내지 않는다.
깨진 위키링크와 index.md를 고치고 MEMORY.md의 낡은 항목을 정리한다. raw/ 원문은 불변으로 보존한다.
userMessages에는 아직 학습하지 않은 사용자 발언만 있다. 사용자가 직접 말한 사실과 정정만 추출한다.
질문이나 요청을 사실로 바꾸지 않고 Luna/assistant 답변을 재학습하지 않으며 대화를 덤프하지 않는다.
대화에서 추출하는 지식은 공용 위키에 공개된다는 점을 고려하고, 비밀값은 저장하지 않으며 개인정보는 마스킹한다.
${journalPath}에 오늘의 변경, 정리한 내용, 남은 쟁점을 요약한 한국어 일기를 반드시 작성한다.
동일 날짜 일기가 있으면 기존 내용을 보존하며 이번 정리 내용을 반영한다. 입력에 없는 새 사실은 만들지 않는다.
작성 규칙을 지켜 도구로 실제 파일을 편집하고 필요하면 의미 단위로 커밋한다. Git author는 도구에 설정된 봇이다.`;
}
