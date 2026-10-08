import { newId } from '../common/ids.js';
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
import { sliceCodePoints } from '../agent/output.js';
import { AgentService } from '../agent/agent.service.js';
import type { TokenUsage } from '../agent/agent.types.js';
import { IndexerService } from '../rag/indexer.service.js';
import { SearchService } from '../rag/search.service.js';
import { CatalogService } from '../rag/catalog.service.js';
import { ComparisonService } from '../rag/comparison.service.js';
import { normalizeLinkTarget } from '../rag/link-resolver.js';
import { guardDreamTools, unresolvedLinkTargets } from './dream-tools.js';
import { collectStructureSignals, restrictStructureSignals, selectDreamMode } from './structure-signals.js';
import type { DreamRun } from './dream-run.types.js';
import { DreamRunsRepository } from './dream-runs.repository.js';

// Manual callers and the scheduler may use different service instances.
const activeRuns = new WeakMap<KnowledgeRepo, Promise<DreamRun>>();
export const SIMILAR_NOTE_EXCERPT_CHARS = 1_500;
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
    private readonly catalog: CatalogService,
    private readonly comparison: ComparisonService,
  ) {}

  recoverInterrupted(): void {
    // Only HTTP startup calls recovery; CLI contexts may share a live server's DB.
    if (activeRuns.has(this.repo)) return;
    const interrupted = this.runs.failInterrupted(
      'Dreaming interrupted by engine restart; run dreaming again to retry.',
      new Date().toISOString(),
    );
    for (const runId of interrupted) {
      this.events.publish({ type: 'dream.updated', runId, status: 'failed' }, 'all');
    }
  }

  start(): void {
    if (this.config.jobsAutostart === false || this.scheduler) return;
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
      id: newId(), startedAt: new Date().toISOString(), finishedAt: null,
      status: 'running', fromSha: null, toSha: null, mergeSha: null, pushed: false, error: null,
      summary: null, changedPaths: [], journalPath: null,
      mode: null, focus: null, structuralChanges: [],
      push: { status: 'pending', remote: null, sha: null, at: null, reason: null },
    };
    let worktree: Worktree | undefined;
    let recorded = false;
    const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    const onUsage = (delta: TokenUsage) => {
      usage.inputTokens += delta.inputTokens;
      usage.cachedInputTokens += delta.cachedInputTokens ?? 0;
      usage.outputTokens += delta.outputTokens;
      usage.reasoningTokens += delta.reasoningTokens;
    };
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

      const structure = await collectStructureSignals(repo, this.catalog, this.comparison, run.toSha);
      const choice = selectDreamMode(structure.signals, commits.length > 0 || messages.length > 0,
        structure.folders, runs.lastSucceededSweeps());
      run.mode = choice.mode;
      run.focus = choice.focus;
      runs.setInputRange(run);

      if (run.mode !== null) {
        const date = dateFormat.format(new Date(run.startedAt));
        const changes = (await repo.diffNames(run.fromSha, run.toSha)).filter((change) => /\.md$/i.test(change.path));
        const changedNotes = await Promise.all(changes.map(async (change) => {
          const content = await repo.readFile(change.path, run.toSha!);
          const previous = content ?? await repo.readFile(change.oldPath ?? change.path, run.fromSha!);
          const hits = await this.search.search(`${change.path}\n${previous ?? ''}`, { limit: 6 });
          const similarNotes = hits.filter((hit) => hit.path !== change.path).slice(0, 5)
            .map((hit) => ({ path: hit.path, title: hit.title, excerpt: sliceCodePoints(hit.excerpt, 0, SIMILAR_NOTE_EXCERPT_CHARS) }));
          return { change, content, similarNotes };
        }));
        const changedPaths = changes.flatMap((change) => change.oldPath ? [change.oldPath, change.path] : [change.path]);
        const focusedFolder = structure.folders.find((folder) => folder.path === run.focus);
        const signals = run.mode === 'local'
          ? restrictStructureSignals(structure.signals, changedPaths,
            [...new Set(changedPaths.filter((path) => path.startsWith('wiki/')).map((path) => path.slice(0, path.lastIndexOf('/') + 1)))])
          : run.mode === 'sweep'
            ? restrictStructureSignals(structure.signals, focusedFolder?.files ?? [], run.focus ? [run.focus] : [])
            : structure.signals;
        const beforePaths = (await repo.diffNames(null, run.toSha)).map(({ path }) => path);
        const beforeNotes = await Promise.all(beforePaths.filter((path) => /\.md$/i.test(path)).map(async (path) =>
          ({ path, content: (await repo.readFile(path, run.toSha!)) ?? '' })));
        const beforeLinks = new Set([...unresolvedLinkTargets(beforePaths, beforeNotes)].map(normalizeLinkTarget));
        worktree = await repo.createWorktree(`dream-${date}`);
        let editingBaseline = beforeLinks;
        const worktreeSha = worktree.baseSha;
        if (worktreeSha !== run.toSha) {
          const initialPaths = (await repo.diffNames(null, worktreeSha)).map(({ path }) => path);
          const initialNotes = await Promise.all(initialPaths.filter((path) => /\.md$/i.test(path)).map(async (path) =>
            ({ path, content: (await repo.readFile(path, worktreeSha)) ?? '' })));
          // Worktree creation may inherit main commits newer than the input.
          editingBaseline = new Set(beforeLinks);
          for (const target of unresolvedLinkTargets(initialPaths, initialNotes)) editingBaseline.add(normalizeLinkTarget(target));
        }
        worktree.setCommitMetadata({ jobId: run.id, source: 'dreaming', requester: config.gitBotEmail });
        const author = { name: config.gitBotName, email: config.gitBotEmail };
        const journalPath = `journal/${date}.md`;
        const guarded = guardDreamTools(agent.worktreeTools(worktree, author), this.acl);
        const rejectIntroducedLinks = async (baseline = editingBaseline) => {
          const paths = await worktree!.list();
          const notes = await Promise.all(paths.filter((path) => /\.md$/i.test(path)).map(async (path) =>
            ({ path, content: (await worktree!.read(path)) ?? '' })));
          const introduced = [...unresolvedLinkTargets(paths, notes)].filter((target) => !baseline.has(normalizeLinkTarget(target))).sort();
          if (introduced.length) throw new Error(`Dreaming introduced broken links: ${introduced.join(', ')}`);
        };
        let result;
        try {
          result = await agent.runAgent({
            lane: 'dreaming',
            onUsage,
            instructions: `${await agent.baseInstructions()}\n\n${dreamInstructions()}`,
            input: JSON.stringify({
              date, journalPath, fromSha: run.fromSha, toSha: run.toSha, commits, changedNotes, userMessages: messages,
              mode: run.mode, focus: run.focus, structure: { signals, focus: run.focus, files: focusedFolder?.files ?? [] },
            }),
            tools: guarded.tools,
          });
        } finally {
          run.structuralChanges = guarded.changes();
        }
        run.summary = result.text || null;
        if (!(await worktree.read(journalPath))?.trim()) {
          throw new Error(`Dreaming did not write the required journal: ${journalPath}`);
        }
        run.journalPath = journalPath;
        await rejectIntroducedLinks();
        await worktree.commit(`dreaming: ${date}`, author);
        const wt = worktree;
        await repo.withMergeLock(async () => {
          const previousHead = await repo.headSha();
          const mainPaths = (await repo.diffNames(null, previousHead)).map(({ path }) => path);
          const mainNotes = await Promise.all(mainPaths.filter((path) => /\.md$/i.test(path)).map(async (path) =>
            ({ path, content: (await repo.readFile(path, previousHead)) ?? '' })));
          // Concurrent main changes are not dreaming-introduced link failures.
          // Keep the input baseline too: main may have repaired an older target.
          const mergeBaseline = new Set(beforeLinks);
          for (const target of unresolvedLinkTargets(mainPaths, mainNotes)) mergeBaseline.add(normalizeLinkTarget(target));
          const merge = await wt.mergeMain();
          if (!merge.ok) {
            await agent.resolveConflicts(wt, merge.conflicts, undefined, { onUsage });
            await wt.finishMerge(author);
          }
          await rejectIntroducedLinks(mergeBaseline);
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
        log.warn({ runId: run.id, err: error }, 'Dreaming backup push failed');
      }
      run.finishedAt = new Date().toISOString();
      if (aclWarning) run.summary = [aclWarning, run.summary].filter(Boolean).join('\n\n');
      if (recorded) {
        runs.finish(run);
        this.events.publish({ type: 'dream.updated', runId: run.id, status: run.status }, 'all');
        await this.notify(run);
      }
    }
    if (run.status === 'failed') log.error({ runId: run.id, error: run.error, usage }, 'Dreaming failed');
    else log.info({ runId: run.id, mergeSha: run.mergeSha, pushed: run.pushed, usage }, 'Dreaming completed');
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

function dreamInstructions(): string {
  return `입력 JSON의 date는 오늘의 한국 표준시(Asia/Seoul) 날짜다. dreaming 정리 작업을 수행한다.
입력 JSON의 커밋과 changedNotes는 직전 성공한 실행 이후 main의 변경이며 similarNotes는 관련 기존 노트의 경로·제목과 최대 1500자 발췌다. 발췌를 전체 본문으로 간주하지 않고 더 많은 근거가 필요하면 read_file로 읽는다.
변경과 관련 노트를 읽고 근거에 따라 모순과 중복을 정리한다. read_file은 페이지 JSON을 반환하므로 truncated이면 nextOffset과 nextCharOffset(있을 때)으로 이어 읽는다. 기존 파일을 write_file로 교체할 때는 모든 필요한 페이지를 읽고 유효한 기존 내용을 포함한 전체 파일을 저장한다. list_files는 같은 prefix와 nextOffset으로 이어 조회하거나 폴더를 좁힌다. 최신 근거가 불명확하면 열린 쟁점으로 남기고 지어내지 않는다.
깨진 위키링크와 index.md를 고치고 MEMORY.md의 낡은 항목을 정리한다. raw/ 원문은 불변으로 보존한다.
ACL 경계를 넘어 제한된 노트·사용자 자료의 내용이나 의미를 다른 권한 영역의 노트, 색인, 메모리, 일기에 복사·요약·의역하지 않는다. 이 시스템 작업은 전체 저장소를 읽을 수 있지만 공유 범위를 확대할 권한은 없다. 경계가 불명확하면 내용을 옮기지 않고 기존 영역에 보존한다.
입력 structure는 엔진이 계산한 구조 신호이며 mode는 오늘의 정리 범위다.
- local: 변경 노트 주변만 정리한다. 다른 영역의 구조는 바꾸지 않는다.
- structural: structure.signals에 지목된 영역만 정리한다. 변경과 메시지도 평소처럼 처리한다.
- sweep: structure.focus 폴더 하나만 점검한다.
구조 변경은 탐색이나 검색이 분명히 좋아질 때만 한다. 취향 때문에 이름을 바꾸거나 폴더를 다시 나누지 않는다.
- 합치기: 같은 사실을 다루는 노트는 하나의 정본으로 합치고 나머지는 삭제한다. 삭제한 노트를 가리키던 모든 위키링크는 정본을 가리키게 고친다.
- 옮기기·이름 바꾸기: 저장소의 기존 폴더와 파일명 관례를 따른다. 새 폴더는 같은 주제의 노트가 3개 이상일 때만 만든다.
- 쪼개기: 한 노트에 서로 독립적인 주제가 섞였을 때만 원자적 노트로 나누고 서로 링크한다.
- 허브: 같은 주제의 노트가 흩어져 있으면 지식을 복제하지 않는 허브 노트를 만들고 index.md에 연결한다.
파일을 옮기거나 삭제하면 그 경로를 가리키던 모든 [[링크]]를 같은 커밋에서 고친다.
raw/, journal/, MEMORY.md, AGENTS.md, index.md의 위치는 바꾸지 않는다.
이동·삭제는 하루 20건까지다. 일기의 "구조 정리" 절에 이전 경로 → 새 경로와 이유를 모두 적고, 남은 후보는 다음 정리 후보로 남긴다.
엔진은 서로 다른 ACL 규칙 집합 사이의 이동을 거절한다. 새로 깨지거나 모호해진 위키링크가 있으면 main 머지 전에 실행 전체를 실패시키므로 모든 역링크를 함께 고친다.
userMessages에는 아직 학습하지 않은 사용자 발언만 있다. 사용자가 직접 말한 사실과 정정만 추출한다.
질문이나 요청을 사실로 바꾸지 않고 도니/assistant 답변을 재학습하지 않으며 대화를 덤프하지 않는다.
대화에서 추출하는 지식은 공용 위키에 공개된다는 점을 고려하고, 비밀값은 저장하지 않으며 개인정보는 마스킹한다.
입력 JSON의 journalPath에 오늘의 변경, 정리한 내용, 남은 쟁점을 요약한 한국어 일기를 반드시 작성한다.
동일 날짜 일기가 있으면 기존 내용을 보존하며 이번 정리 내용을 반영한다. 입력에 없는 새 사실은 만들지 않는다.
작성 규칙을 지켜 도구로 실제 파일을 편집하고 필요하면 의미 단위로 커밋한다. Git author는 도구에 설정된 봇이다.`;
}
