import { newId } from '../common/ids.js';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Cron } from 'croner';
import { ApiError } from '../api/api-error.js';
import { AclService, matchesAclPrefix } from '../acl/acl.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CONFIG, LOGGER } from '../common/tokens.js';
import type { Config } from '../config.js';
import { EventsService } from '../events/events.service.js';
import { KnowledgeRepo, type CommitInfo, type Worktree } from '../knowledge/repo.js';
import { WriteJobsRepository, type FinishedWriteJob } from '../jobs/write-jobs.repository.js';
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
import {
  collectStructureSignals, isDreamingScanPath, restrictStructureSignals, selectDreamMode, type DreamingSnapshot,
} from './structure-signals.js';
import type { DreamRun } from './dream-run.types.js';
import { DreamRunsRepository } from './dream-runs.repository.js';

// Manual callers and the scheduler may use different service instances.
const activeRuns = new WeakMap<KnowledgeRepo, Promise<DreamRun>>();
export const SIMILAR_NOTE_EXCERPT_CHARS = 1_500;
const IMPORTED_NOTES_LIMIT = 20;
const JOB_OUTCOMES_LIMIT = 40;
const dateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
});

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jobReportExcerpt(value: string | null, maxCodePoints: number): string | null {
  if (value === null || value.length <= maxCodePoints) return value;
  let end = 0;
  let count = 0;
  for (const point of value) {
    if (count === maxCodePoints) break;
    end += point.length;
    count++;
  }
  return value.slice(0, end);
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
    private readonly jobs: WriteJobsRepository,
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

      const date = dateFormat.format(new Date(run.startedAt));
      const journalPath = `journal/${date}.md`;
      // Pin and reuse each main snapshot across structure and both link baselines.
      // Only today's journal is inspected: dreaming may append to an existing entry.
      const snapshots = new Map<string, Promise<DreamingSnapshot>>();
      const snapshotAt = (sha: string): Promise<DreamingSnapshot> => {
        let snapshot = snapshots.get(sha);
        if (!snapshot) {
          snapshot = (async () => {
            const paths = (await repo.diffNames(null, sha)).map(({ path }) => path);
            const files = await repo.readFiles(paths.filter((path) => isDreamingScanPath(path) || path === journalPath), sha);
            return { paths, files };
          })();
          snapshots.set(sha, snapshot);
        }
        return snapshot;
      };
      const linkTargets = ({ paths, files }: DreamingSnapshot): Set<string> => unresolvedLinkTargets(paths,
        [...files].flatMap(([path, content]) => content === null ? [] : [{ path, content }]));
      const before = await snapshotAt(run.toSha);
      const structure = await collectStructureSignals(repo, this.catalog, this.comparison, run.toSha, before);
      const choice = selectDreamMode(structure.signals, commits.length > 0 || messages.length > 0,
        structure.folders, runs.lastSucceededSweeps());
      run.mode = choice.mode;
      run.focus = choice.focus;
      runs.setInputRange(run);

      if (run.mode !== null) {
        const changes = (await repo.diffNames(run.fromSha, run.toSha))
          .filter((change) => isDreamingScanPath(change.path) || change.path === journalPath);
        const currentInputs = await repo.readFiles(changes.filter((change) => !before.files.has(change.path))
          .map((change) => change.path), run.toSha);
        const missingInputs = changes.filter((change) => (before.files.get(change.path) ?? currentInputs.get(change.path)) == null);
        const previousInputs = await repo.readFiles(missingInputs.map((change) => change.oldPath ?? change.path), run.fromSha);
        const changedNotes = await Promise.all(changes.map(async (change) => {
          const content = before.files.get(change.path) ?? currentInputs.get(change.path) ?? null;
          const previous = content ?? previousInputs.get(change.oldPath ?? change.path) ?? null;
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
        const importCommits = new Set(commits.filter((commit) => commit.trailers['Wiki-Source'] === 'import')
          .map((commit) => commit.sha));
        const importedNotes: string[] = [];
        if (run.mode !== 'sweep' && importCommits.size > 0) {
          const currentWikiNotes = new Set(structure.folders.flatMap((folder) => folder.files));
          const candidates = changes.map((change) => change.path).filter((path) => currentWikiNotes.has(path)).sort();
          // The structure inventory already excludes schemas and deleted/non-wiki files.
          // Only changed notes need history reads; follow renames at the sampled HEAD.
          for (const path of candidates) {
            const noteHistory = await repo.log({ path, ref: run.toSha, sinceSha: run.fromSha, follow: true, limit: null });
            for (const commit of noteHistory) {
              if (!importCommits.has(commit.sha)) continue;
              const importedChanges = await repo.diffNames(commit.parents[0] ?? null, commit.sha);
              if (importedChanges.some((change) => change.path === commit.path && change.status !== 'D')) {
                importedNotes.push(path);
                break;
              }
            }
          }
        }
        const jobOutcomes = await this.journalJobOutcomes(run, journalPath);
        const beforeLinks = new Set([...linkTargets(before)].map(normalizeLinkTarget));
        worktree = await repo.createWorktree(`dream-${date}`);
        let editingBaseline = beforeLinks;
        const worktreeSha = worktree.baseSha;
        if (worktreeSha !== run.toSha) {
          const initial = await snapshotAt(worktreeSha);
          // Worktree creation may inherit main commits newer than the input.
          editingBaseline = new Set(beforeLinks);
          for (const target of linkTargets(initial)) editingBaseline.add(normalizeLinkTarget(target));
        }
        worktree.setCommitMetadata({ jobId: run.id, source: 'dreaming', requester: config.gitBotEmail });
        const author = { name: config.gitBotName, email: config.gitBotEmail };
        const guarded = guardDreamTools(agent.worktreeTools(worktree, author), this.acl);
        const rejectIntroducedLinks = async (baseline = editingBaseline) => {
          const paths = await worktree!.list();
          const notes = await Promise.all(paths.filter((path) => isDreamingScanPath(path) || path === journalPath).map(async (path) =>
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
              importedNotes: importedNotes.slice(0, IMPORTED_NOTES_LIMIT), importedNotesCount: importedNotes.length,
              ...jobOutcomes,
              mode: run.mode, focus: run.focus, structure: { signals, focus: run.focus, files: focusedFolder?.files ?? [] },
            }),
            tools: guarded.tools,
          });
        } finally {
          run.structuralChanges = guarded.changes();
        }
        run.summary = result.finalText || null;
        if (!(await worktree.read(journalPath))?.trim()) {
          throw new Error(`Dreaming did not write the required journal: ${journalPath}`);
        }
        run.journalPath = journalPath;
        await rejectIntroducedLinks();
        await worktree.commit(`dreaming: ${date}`, author);
        const wt = worktree;
        await repo.withMergeLock(async () => {
          const previousHead = await repo.headSha();
          const main = await snapshotAt(previousHead);
          // Concurrent main changes are not dreaming-introduced link failures.
          // Keep the input baseline too: main may have repaired an older target.
          const mergeBaseline = new Set(beforeLinks);
          for (const target of linkTargets(main)) mergeBaseline.add(normalizeLinkTarget(target));
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

  private async journalJobOutcomes(run: DreamRun, journalPath: string) {
    const jobs = this.jobs.listFinishedBetween(this.runs.lastSucceededStartedAt(), run.startedAt);
    const rules = this.acl.list();
    let eligible = jobs;
    if (rules.length > 0 && jobs.length > 0) {
      const history = await this.repo.log({ ref: run.toSha!, limit: null });
      const bySha = new Map(history.map((commit) => [commit.sha, commit]));
      const jobIds = new Set(jobs.map((job) => job.id));
      const linkedCommits = new Map<string, string[]>();
      for (const commit of history) {
        const jobId = commit.trailers['Wiki-Job'];
        if (!jobIds.has(jobId)) continue;
        const linked = linkedCommits.get(jobId) ?? [];
        linked.push(commit.sha);
        linkedCommits.set(jobId, linked);
      }
      const commitPaths = new Map<string, Promise<string[]>>();
      const pathsForCommit = (sha: string): Promise<string[]> => {
        let paths = commitPaths.get(sha);
        if (!paths) {
          paths = (async () => {
            const commit = bySha.get(sha) ?? (await this.repo.log({ ref: sha, limit: 1 }))[0];
            if (!commit) throw new Error(`Write job commit is unavailable: ${sha}`);
            // Match activity's first-parent paths, retaining both sides of renames.
            const changes = await this.repo.diffNames(commit.parents[0] ?? null, commit.sha);
            return changes.flatMap((change) => change.oldPath ? [change.path, change.oldPath] : [change.path]);
          })();
          commitPaths.set(sha, paths);
        }
        return paths;
      };
      eligible = [];
      for (const job of jobs) {
        const paths = new Set([...this.jobs.sourcePaths(job.id), ...job.conflicts]);
        const commits = new Set([...job.commits, ...(job.mergeSha ? [job.mergeSha] : []), ...(linkedCommits.get(job.id) ?? [])]);
        let complete = true;
        for (const sha of commits) {
          try {
            for (const path of await pathsForCommit(sha)) paths.add(path);
          } catch {
            // Unknown commit paths cannot establish that the journal shares its ACL.
            complete = false;
            break;
          }
        }
        if (complete && paths.size > 0 && [...paths].every((path) =>
          rules.every((rule) => matchesAclPrefix(rule.prefix, path) === matchesAclPrefix(rule.prefix, journalPath)))) {
          eligible.push(job);
        }
      }
    }
    const jobOutcomesCount = eligible.length;
    eligible.sort((a, b) => Number(b.status === 'failed') - Number(a.status === 'failed')
      || b.finishedAt.localeCompare(a.finishedAt) || b.id.localeCompare(a.id));
    const jobOutcomes = eligible.slice(0, JOB_OUTCOMES_LIMIT)
      .sort((a, b) => a.finishedAt.localeCompare(b.finishedAt) || a.id.localeCompare(b.id))
      .map((job): Pick<FinishedWriteJob, 'id' | 'source' | 'status' | 'finishedAt' | 'summary' | 'error'> => ({
        id: job.id, source: job.source, status: job.status, finishedAt: job.finishedAt,
        summary: jobReportExcerpt(job.summary, 800),
        error: job.status === 'failed' ? jobReportExcerpt(job.error, 300) : null,
      }));
    return { jobOutcomes, jobOutcomesCount };
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
깨진 위키링크와 index.md를 고친다. 도니를 호출하는 매 dreaming 실행에서 MEMORY.md를 기본 메모리 계약에 맞게 통합한다. 중복 관례를 합치고 해결된 쟁점을 제거하며 오래 유지할 지식은 wiki 정본으로 옮겨 포인터만 남긴다. 사용자 정정·정리/답변 선호·반복 결정은 작업 관례에, 열린 쟁점은 날짜와 경로를 붙여 진행 중에, 필요한 포인터는 이유와 함께 참조에 반영한다. 유효한 내용을 보존하며 파일 전체를 예산 안에 유지하고 노트 본문 덤프나 비밀값을 넣지 않는다. raw/ 원문은 불변으로 보존한다.
ACL 경계를 넘어 제한된 노트·사용자 자료의 내용이나 의미를 다른 권한 영역의 노트, 색인, 메모리, 일기에 복사·요약·의역하지 않는다. 이 시스템 작업은 전체 저장소를 읽을 수 있지만 공유 범위를 확대할 권한은 없다. 경계가 불명확하면 내용을 옮기지 않고 기존 영역에 보존한다.
입력 structure는 엔진이 계산한 구조 신호이며 mode는 오늘의 정리 범위다.
structure.signals.memoryIssues가 비어 있지 않으면 MEMORY.md의 형식·순서·예산 위반을 뜻한다. 현재 파일을 읽고 유효한 내용을 위의 통합 절차로 보존·정리한 뒤 기본 메모리 계약을 만족하게 고친다.
- local: 변경 노트 주변만 정리한다. 다른 영역의 구조는 바꾸지 않는다.
- structural: structure.signals에 지목된 영역만 정리한다. 변경과 메시지도 평소처럼 처리한다.
- sweep: structure.focus 폴더 하나만 점검한다.
정제: local/structural에서는 importedNotes를 읽고, sweep에서는 점검 폴더의 노트에 같은 잔재가 있으면 작성 규칙에 따라 재사용 가능한 지식으로 다시 쓴다. importedNotesCount는 상한을 적용하기 전의 전체 후보 수이며 importedNotes는 현재 경로순 최대 20개다.
가져오기 과정 설명("가져온 자료에는", "이번 배치", 파일 제외 사유 등), 내보내기 잔재(Notion ID, 의미 없는 "제목 없음", 빈 템플릿 항목, 깨진 첨부 참조)를 제거한다. 실제 식별자나 의미 있는 사실은 잔재로 취급하지 않는다. 반복되는 출처·검증 유보 문구는 정확한 시점·출처 맥락 한 번으로 합치고, 원문 표·목록의 덤프는 그 안의 사실·결정·이유·절차·용어로 정리한다.
출처 링크는 노트 메타데이터 source 또는 출처 절에만 모은다. source는 위키링크나 http(s) URL의 문자열 배열이며 raw 출처 링크를 보존한다. 노트나 그 raw 출처에 없는 사실은 추가하지 않고, 의미 있는 사실은 버리지 않는다. 제거 대상은 과정 설명·중복·잔재뿐이며 raw/는 절대 편집하지 않는다.
정제 후 재사용 가능한 지식이 없는 노트나 가져오기 산물만 남은 노트는 의미 있는 사실과 링크를 보존하며 병합·삭제할 수 있다. 기존 이동·삭제 20건 상한을 함께 적용한다. 정제한 노트와 핵심 내용, 이동·삭제 상한 때문에 남은 후보를 일기의 "정리" 절에 기록한다.
배치·깊이·폴더 이름·공유 정본·schema 우선순위와 허브·색인 연결은 기본 문맥의 엔진 지식 구조 규칙을 따른다. browse_catalog로 현재 main의 기존 주제와 전체 노트 목록을 확인한다.
도메인 구조 신호를 우선 고친다. missingDomainHubs와 unlinkedDomainHubs는 기본 허브·색인 규칙에 맞춰 보완한다. unclassifiedNotes, shallowDomainNotes, tooDeepNotes, invalidFolderNames는 노트의 관심 대상과 주제를 읽고 기본 배치 규칙에 맞게 정리한다.
정리 순서는 도메인 배치·허브, 깨지거나 모호한 링크, 그 밖의 구조 문제, 남은 메타데이터 순서다. 큰 기존 메타데이터 backlog가 탐색 경로와 링크 수리를 밀어내지 않게 한다. 앞선 수리로 이미 편집하는 노트의 메타데이터도 함께 고치고, 그 뒤 invalidMetadata의 후보를 차례로 보완한다. invalidMetadataCount는 점검한 main 전체의 미완료 노트 수이며 후보 목록은 최대 20개다. 남은 메타데이터 후보는 다음 실행에서 다시 계산하므로 일기에 남기지 않는다.
invalidMetadata는 author, date created, date modified처럼 엔진이 채우는 속성을 제외한 오류다. 후보 노트의 본문과 기존 링크를 먼저 읽고 거기에 있는 사실만으로 type, aliases, description, tags를 채운다. description은 300자 이하의 한국어 1~2문장 요약이며, aliases는 실제 다른 이름·약어·번역의 문자열 목록(없으면 []), tags는 하나 이상의 넓고 재사용 가능한 영문 소문자 kebab-case 태그다. 메타데이터를 채우려고 새 사실을 지어내지 않는다.
type은 hub, concept, entity, guide, decision, reference, project, note 중 고른다. wiki/concepts/의 노트는 concept, wiki/entities/의 노트는 entity, wiki/<domain>/index.md는 hub로 맞춘다. updated는 제거하고 날짜는 엔진에 맡긴다. status/category/domain은 제거하되 지식 의미를 담고 있다면 필요한 의미만 본문에 보존한다. author와 생성·수정 날짜는 추측하거나 계산하지 않으며 엔진이 커밋 시 채운다. 그 밖의 도메인 추가 속성은 보존하며 related/source/confidence/importance 같은 유효한 속성을 버리지 않는다.
구조 변경은 탐색이나 검색이 분명히 좋아질 때만 한다. 취향 때문에 이름을 바꾸거나 폴더를 다시 나누지 않는다.
- 합치기: 같은 사실을 다루는 노트는 하나의 정본으로 합치고 나머지는 삭제한다. 삭제한 노트를 가리키던 모든 위키링크는 정본을 가리키게 고친다.
- 옮기기·이름 바꾸기: 기본 엔진 규칙을 따른다. oversizedFolders가 있어도 하위 주제 분리 조건과 실질적인 탐색 개선을 확인한 뒤 이동하며, 조건이 맞지 않으면 중복·범위와 허브를 먼저 정리한다.
- 쪼개기: 한 노트에 서로 독립적인 주제가 섞였을 때만 원자적 노트로 나누고 서로 링크한다.
- 허브: 점검 범위에서 누락된 조회 경로를 기본 엔진 규칙의 큐레이션 형식으로 보완한다.
파일을 옮기거나 삭제하면 그 경로를 가리키던 모든 [[링크]]를 같은 커밋에서 고친다.
raw/, journal/, MEMORY.md, 루트 AGENTS.md, wiki/<domain>/AGENTS.md, 루트 index.md의 위치는 바꾸지 않으며 이동·삭제하지 않는다. 도메인 전용 작성 규칙은 그 도메인의 AGENTS.md에만 둔다.
이동·삭제는 실행당 20건까지다. 일기의 "정리" 절에 이전 경로 → 새 경로와 이유를 모두 적고, 같은 이유의 이동은 경로 쌍을 나열한 한 항목으로 묶는다. 상한 때문에 남은 이동·삭제 후보는 "정리" 절에만 다음 정리 후보로 남긴다.
엔진은 서로 다른 ACL 규칙 집합 사이의 이동을 거절한다. 새로 깨지거나 모호해진 위키링크가 있으면 main 머지 전에 실행 전체를 실패시키므로 모든 역링크를 함께 고친다.
userMessages에는 아직 학습하지 않은 사용자 발언만 있다. 사용자가 직접 말한 사실과 정정만 추출한다.
질문이나 요청을 사실로 바꾸지 않고 도니/assistant 답변을 재학습하지 않으며 대화를 덤프하지 않는다.
대화에서 추출하는 지식은 공용 위키에 공개된다는 점을 고려하고, 비밀값은 저장하지 않으며 개인정보는 마스킹한다.
jobOutcomes는 직전 성공한 꿈꾸기 시작 이후 이번 실행 시작까지 끝난 쓰기 작업의 결과이며 jobOutcomesCount는 상한 전 전체 적격 작업 수다. 실패 작업을 우선하여 최대 40개를 전달한다. 이 결과는 "반영되지 못한 자료" 절의 근거로만 쓰며 summary는 도니의 이전 보고이지 검증된 사실이 아니다. 비밀값·개인정보·제한된 내용은 복사하지 않는다.
입력을 검토한 직후 구조·정리 작업보다 먼저 journalPath에 한국어 일기 초안을 실제로 작성한다. "# YYYY-MM-DD" 아래 "새로 알게 된 것", "바뀐 사실과 정정", "반영되지 못한 자료", "지식 쟁점" 중 근거 있는 절을 아래 순서와 정확한 제목으로 먼저 채운다.
그 뒤 구조·정리 작업을 수행하고 마지막에 "정리" 절을 보완하며 일기의 모든 [[링크]]를 최종적으로 존재하는 노트 경로로 갱신한다. 이동한 노트는 새 경로로만 링크하고, 불확실하면 list_files로 확인하며, 경로를 확인할 수 없으면 위키링크 대신 백틱으로 감싼 경로를 쓴다.
- "## 새로 알게 된 것": commits, changedNotes, userMessages에 근거하여 이번에 새로 담긴 사실·결정·절차를 도메인·주제별로 묶는다. 각 항목은 "[[노트 경로]] — 새로 담긴 지식 한 문장"으로 쓴다. 정리한 행위가 아니라 독자가 얻는 핵심 사실·결정·절차를 직접 서술한다.
- "## 바뀐 사실과 정정": 기존 지식의 정정·폐기·대체를 이전 → 이후와 근거로 적는다.
- "## 반영되지 못한 자료": jobOutcomes에서 실패한 작업이나 summary에 원문 미완독·미반영·부분 반영·민감정보 등 제외가 보고된 작업을 고른다. 작업별 또는 출처 배치별로 한 항목을 쓰고, summary에서 확인되는 자료명(가져오기 이름·raw 경로·파일 수 등), 작업 ID, 반영되지 못한 이유, 다음 조치를 적는다. 서로 다른 작업을 "일부 쓰기 작업" 같은 모호한 문장으로 합치지 않는다.
- "## 지식 쟁점": 노트 사이 모순, 근거가 부족한 주장, 확인할 사실을 지식 수준에서 날짜와 노트 링크를 붙여 적는다. 이동·삭제 상한 때문에 남은 후보는 이 절에 쓰지 않는다.
- "## 정리": 실제 수행한 이동·삭제·병합·분리를 이전 경로 → 새 경로와 이유로 적고, 정제로 다시 쓴 노트 경로와 핵심 내용, 실행당 이동·삭제 20건 상한 때문에 남은 후보를 적는다. 같은 이유의 이동은 이전 → 새 경로 쌍을 나열한 한 항목으로 묶는다.
근거 있는 내용이 없는 절은 생략한다. 빈 절, "없음", "발견하지 않았다", 점검했지만 문제가 없다는 기록은 쓰지 않는다. 일상적인 링크·허브 설명·색인 수리는 git 커밋 이력에 있으므로 일기에 쓰지 않는다. 메타데이터 수정이나 남은 lint·메타데이터 backlog, MEMORY.md가 맡는 작업 관례·운영 메모, 도니 자신의 작업 과정도 쓰지 않는다.
동일 날짜 일기가 있으면 기존 절에 병합하고 항목 중복을 제거하며 유효한 내용을 보존한다. 예전 일기의 유효한 정리 내용도 "정리" 절로 합친다. 입력에 없는 새 사실은 만들지 않는다.
작성 규칙을 지켜 도구로 실제 파일을 편집하고 필요하면 의미 단위로 커밋한다. Git author는 도구에 설정된 봇이다.`;
}
