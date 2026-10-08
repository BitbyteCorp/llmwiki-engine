export type Role = 'admin' | 'editor' | 'viewer'
export interface User { id: number; email: string; name: string | null; role: Role; createdAt: string; lastLoginAt: string | null }
export interface Note { path: string; content: string; frontmatter: Record<string, unknown>; body: string; updatedSha: string }
// Search and knowledge catalog contracts.
export interface SearchHit { path: string; title: string; heading: string; snippet: string; score: number; kind: 'wiki' | 'journal' | 'raw' | 'other'; related: string[]; anchor: string | null; excerpt: string; highlights: Array<[number, number]>; tags: string[]; updatedAt: string | null }
export interface SearchFilters { folder?: string; tags?: string; from?: string; to?: string; author?: string }
export interface SearchResult { mode: 'hybrid' | 'keyword'; degraded: { reason: 'no_api_key' | 'embedding_error' | 'vector_mismatch' | 'index_stale' } | null; hits: SearchHit[]; nextCursor: string | null }
export interface CatalogNote { path: string; title: string }
export interface NoteLinks { outgoing: CatalogNote[]; backlinks: CatalogNote[]; unresolved: string[] }
export interface KnowledgeGraph { nodes: Array<CatalogNote & { tags: string[] }>; edges: Array<{ from: string; to: string }> }
export interface DuplicatePair { left: CatalogNote; right: CatalogNote; score: number; reason: 'exact' | 'semantic'; passages: Array<{ left: { anchor: string | null; excerpt: string }; right: { anchor: string | null; excerpt: string } }> }
export interface CommitInfo { sha: string; parents: string[]; authorName: string; authorEmail: string; date: string; committerName: string; committerEmail: string; committedAt: string; subject: string; body: string; trailers: Record<string, string>; path?: string; oldPath?: string }
export interface FileChange { status: 'A' | 'M' | 'D' | 'R'; path: string; oldPath?: string }
export interface WriteJob { id: string; userId: number; kind: 'agent' | 'direct' | 'revert'; source: 'mcp' | 'web' | 'chat' | 'dreaming' | 'import' | 'revert'; client: string | null; input: string; status: 'queued' | 'running' | 'merging' | 'succeeded' | 'failed'; summary: string | null; commits: string[]; conflicts: string[]; mergeSha: string | null; error: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null }
// Dony conversation and persisted generation contracts.
export interface Conversation { id: string; title: string; createdAt: string; updatedAt: string; role?: 'owner' | 'editor' | 'viewer'; snippet?: string }
export interface Citation { path: string; heading?: string; anchor?: string; excerpt?: string; sha?: string }
export interface MessageContext { notePath: string; ref?: string; selection?: string }
export interface MessageUsage { inputTokens: number; outputTokens: number; reasoningTokens: number }
export interface Message { id: string; role: 'user' | 'assistant'; content: string; citations: Citation[]; attachments: string[]; context: MessageContext | null; status: 'completed' | 'running' | 'failed' | 'cancelled' | 'interrupted'; usage: MessageUsage | null; model: string | null; effort: string | null; generationId?: string | null; createdAt: string }
export interface Settings { allowlistEnabled: boolean; allowedDomains: string[] }
export type Requester = Pick<User, 'email' | 'name'>

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); this.name = 'ApiError' }
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(path, { ...init, credentials: 'same-origin', headers })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null
    if (response.status === 401) window.dispatchEvent(new CustomEvent('session-expired'))
    throw new ApiError(response.status, payload?.error?.code ?? 'request_failed', payload?.error?.message ?? `요청에 실패했다 (${response.status}).`)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

function query(values: Record<string, string | number | undefined>) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, String(value))
  return params.size ? `?${params}` : ''
}

export const api = {
  me: () => request<{ user: User }>('/api/me'),
  tree: () => request<{ files: string[] }>('/api/notes/tree'),
  note: (path: string, ref?: string) => request<Note>(`/api/notes/content${query({ path, ref })}`),
  resolve: (name: string) => request<{ path: string | null; candidates?: string[] }>(`/api/notes/resolve${query({ name })}`),
  // Search and knowledge catalog requests consume TanStack cancellation signals.
  search: (q: string, filters: SearchFilters & { cursor?: string; limit?: number } = {}, signal?: AbortSignal) => request<SearchResult>(`/api/search${query({ q, limit: 20, ...filters })}`, { signal }),
  suggest: (q = '', signal?: AbortSignal) => request<CatalogNote[]>(`/api/search/suggest${query({ q })}`, { signal }),
  similar: (path: string, signal?: AbortSignal) => request<Array<CatalogNote & { score: number }>>(`/api/search/similar${query({ path })}`, { signal }),
  duplicates: (signal?: AbortSignal) => request<DuplicatePair[]>('/api/search/duplicates?limit=100', { signal }),
  links: (path: string, signal?: AbortSignal) => request<NoteLinks>(`/api/links${query({ path })}`, { signal }),
  graph: (path?: string, depth = 1, signal?: AbortSignal) => request<KnowledgeGraph>(`/api/graph${query({ path, depth })}`, { signal }),
  tags: (signal?: AbortSignal) => request<Array<{ tag: string; count: number }>>('/api/tags', { signal }),
  tagNotes: (tag: string, signal?: AbortSignal) => request<CatalogNote[]>(`/api/tags/notes${query({ tag })}`, { signal }),
  history: (path?: string, before?: string) => request<{ commits: CommitInfo[] }>(`/api/history${query({ path, before, limit: 30 })}`),
  commit: (sha: string) => request<{ commit: CommitInfo; files: FileChange[]; patch: string; job: WriteJob | null }>(`/api/history/commits/${encodeURIComponent(sha)}`),
  jobs: (mine = false, before?: string) => request<{ jobs: (WriteJob & { user: Requester })[] }>(`/api/jobs${query({ mine: mine ? '1' : undefined, before, limit: 30 })}`),
  job: (id: string) => request<{ job: WriteJob; user: Requester; commits: CommitInfo[] }>(`/api/jobs/${encodeURIComponent(id)}`),
  conversations: (q?: string) => request<{ conversations: Conversation[] }>(`/api/conversations${query({ q })}`),
  createConversation: (title?: string) => request<{ conversation: Conversation }>('/api/conversations', { method: 'POST', body: JSON.stringify({ title }) }),
  conversation: (id: string) => request<{ conversation: Conversation; messages: Message[] }>(`/api/conversations/${encodeURIComponent(id)}`),
  deleteConversation: (id: string) => request<void>(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  users: () => request<{ users: User[] }>('/api/admin/users'),
  createUser: (input: { email: string; name?: string; role: Role }) => request<{ user: User }>('/api/admin/users', { method: 'POST', body: JSON.stringify(input) }),
  updateUser: (id: number, input: { role?: Role; name?: string }) => request<{ user: User }>(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteUser: (id: number) => request<void>(`/api/admin/users/${id}`, { method: 'DELETE' }),
  settings: () => request<Settings>('/api/admin/settings'),
  updateSettings: (input: Partial<Settings>) => request<Settings>('/api/admin/settings', { method: 'PUT', body: JSON.stringify(input) }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
}

// --- Admin operations and audit contracts ---
export interface OpsJob {
  id: string; userId: number; kind: 'agent' | 'direct' | 'revert'; source: 'mcp' | 'web' | 'chat' | 'dreaming' | 'import' | 'revert'; client: string | null
  status: 'queued' | 'running' | 'merging' | 'succeeded' | 'failed'; summary: string | null; error: string | null
  mergeSha: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null
}
export interface OpsDreamRun {
  id: string; startedAt: string; finishedAt: string | null; status: 'running' | 'succeeded' | 'failed'
  fromSha: string | null; toSha: string | null; mergeSha: string | null; pushed: boolean; error: string | null; summary: string | null
  changedPaths: string[]; journalPath: string | null
  push: { status: 'pending' | 'succeeded' | 'skipped' | 'failed'; remote: string | null; sha: string | null; at: string | null; reason: string | null }
}
export interface OpsIndexStatus {
  indexedSha: string | null; headSha: string; syncing: boolean; lastSyncAt: string | null; lastError: string | null; pendingVectors: number
  embedding: { configured: boolean; model: string; dimensions: number; ready: boolean }
}
export interface OpsStatus {
  queue: { queued: number; running: number; oldestQueuedAt: string | null }; failedJobs: OpsJob[]; index: OpsIndexStatus
  dreams: { last: OpsDreamRun | null; running: OpsDreamRun | null }; backup: { lastAttempt: OpsDreamRun | null; lastSuccess: OpsDreamRun | null }
}
export interface AuditEvent { id: number; actorId: number | null; action: string; target: string; outcome: string; summary: string | null; createdAt: string }
export interface AuditFilters { actor?: number; action?: string; before?: string; limit?: number }
export interface OpsReadyState { ok: true; initialIndex: 'ready'; checks: { database: boolean; repository: boolean; index: boolean } }
export const opsApi = {
  status: (signal?: AbortSignal) => request<OpsStatus>('/api/admin/ops', { signal }),
  ready: (signal?: AbortSignal) => request<OpsReadyState>('/readyz', { signal }),
  audit: (filters: AuditFilters = {}, signal?: AbortSignal) => request<{ events: AuditEvent[]; nextCursor: string | null }>(`/api/admin/audit${query({ limit: 50, ...filters })}`, { signal }),
  retryJob: (id: string) => request<{ job: OpsJob }>(`/api/admin/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
  cancelJob: (id: string) => request<{ job: OpsJob }>(`/api/admin/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  reindex: (full: boolean) => request<OpsIndexStatus>('/api/admin/index/reindex', { method: 'POST', body: JSON.stringify({ full }) }),
  runDream: () => request<OpsDreamRun>('/api/admin/dreams/run', { method: 'POST' }),
  // The jobs API has no status filter: traverse every page so old queued jobs remain actionable.
  activeJobs: async (signal?: AbortSignal): Promise<OpsJob[]> => {
    const active: OpsJob[] = []
    let before: string | undefined
    for (;;) {
      const page: { jobs: OpsJob[] } = await request(`/api/jobs${query({ limit: 100, before })}`, { signal })
      for (const job of page.jobs) if (job.status === 'queued' || job.status === 'running' || job.status === 'merging') active.push(job)
      if (page.jobs.length < 100) return active
      before = page.jobs[page.jobs.length - 1]!.id
    }
  },
}
// --- End admin operations and audit contracts ---

// BEGIN settings client — token secrets must never enter a query/mutation cache.
export type ApiTokenScope = 'read' | 'write'
export interface ApiToken {
  id: string
  userId: number
  name: string
  scopes: ApiTokenScope[]
  createdAt: string
  expiresAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
}
export interface CreateApiTokenInput { name: string; scopes: ApiTokenScope[]; expiresAt?: string }
export interface ExportFile { blob: Blob; filename: string; headSha: string | null }

export const settingsApi = {
  tokens: (all = false, signal?: AbortSignal) => request<{ tokens: ApiToken[] }>(`/api/tokens${query({ all: all ? '1' : undefined })}`, { signal, cache: 'no-store' }),
  createToken: (input: CreateApiTokenInput) => request<ApiToken & { token: string }>('/api/tokens', { method: 'POST', body: JSON.stringify(input), cache: 'no-store' }),
  revokeToken: (id: string) => request<void>(`/api/tokens/${encodeURIComponent(id)}`, { method: 'DELETE', cache: 'no-store' }),
  async exportFile(prefix: string, format: 'zip' | 'bundle', signal?: AbortSignal): Promise<ExportFile> {
    const response = await fetch(`/api/export${query({ prefix, format })}`, { credentials: 'same-origin', cache: 'no-store', signal })
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null
      if (response.status === 401) window.dispatchEvent(new CustomEvent('session-expired'))
      throw new ApiError(response.status, payload?.error?.code ?? 'export_failed', payload?.error?.message ?? `내보내기에 실패했습니다 (${response.status}).`)
    }
    const disposition = response.headers.get('Content-Disposition') ?? ''
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1]
    const plain = /filename="([^"]+)"|filename=([^;]+)/i.exec(disposition)
    let filename = plain?.[1] ?? plain?.[2]?.trim() ?? `llmwiki.${format}`
    if (encoded) {
      try { filename = decodeURIComponent(encoded) } catch { /* Use the ordinary filename if decoding fails. */ }
    }
    filename = filename.replace(/[\\/\u0000-\u001f\u007f]/g, '_')
    return { blob: await response.blob(), filename, headSha: response.headers.get('X-Export-Head') }
  },
}
// END settings client

// BEGIN imports client contracts
export type ImportKind = 'url' | 'pdf' | 'text' | 'file' | 'obsidian' | 'notion'
export type ImportStatus = 'extracting' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export interface ImportRecord {
  id: string; userId: number; kind: ImportKind; source: string; sha: string | null
  status: ImportStatus; rawPaths: string[]; jobId: string | null; error: string | null
  createdAt: string; updatedAt: string; finishedAt: string | null
}
export interface ImportInput { kind: ImportKind; url?: string; text?: string; uploadId?: string; filename?: string; instructions?: string }
export interface ImportUpload { id: string; userId: number; name: string; mediaType: string; size: number; createdAt: string; purpose: 'import' }
export const importKeys = {
  lists: ['imports'] as const,
  list: (userId: number) => ['imports', userId] as const,
  detail: (id: string) => ['import', id] as const,
}

function uploadImport(file: File, options: { signal?: AbortSignal; onProgress?: (percent: number) => void } = {}): Promise<ImportUpload> {
  // The web client targets ES2022; Promise.withResolvers requires ES2024.
  return new Promise<ImportUpload>((resolve, reject) => {
    if (options.signal?.aborted) { reject(new DOMException('업로드를 취소했습니다.', 'AbortError')); return }
    const xhr = new XMLHttpRequest()
    const abort = () => xhr.abort()
    const cleanup = () => options.signal?.removeEventListener('abort', abort)
    xhr.open('POST', '/api/uploads')
    xhr.withCredentials = true
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(Math.min(100, Math.round(event.loaded / event.total * 100)))
    }
    xhr.onload = () => {
      cleanup()
      let payload: unknown
      try { payload = JSON.parse(xhr.responseText) } catch { payload = null }
      if (xhr.status >= 200 && xhr.status < 300) { resolve(payload as ImportUpload); return }
      if (xhr.status === 401) window.dispatchEvent(new CustomEvent('session-expired'))
      const error = (payload as { error?: { code?: string; message?: string } } | null)?.error
      reject(new ApiError(xhr.status, error?.code ?? 'upload_failed', error?.message ?? `업로드에 실패했습니다 (${xhr.status}).`))
    }
    xhr.onerror = () => { cleanup(); reject(new Error('업로드 연결에 실패했습니다. 네트워크 상태를 확인하고 다시 시도해 주세요.')) }
    xhr.onabort = () => { cleanup(); reject(new DOMException('업로드를 취소했습니다.', 'AbortError')) }
    options.signal?.addEventListener('abort', abort, { once: true })
    const body = new FormData()
    body.append('file', file)
    body.append('purpose', 'import')
    xhr.send(body)
  })
}

export const importsApi = {
  list: (before?: string, limit = 30, signal?: AbortSignal) => request<{ imports: ImportRecord[] }>(`/api/imports${query({ before, limit })}`, { signal }),
  detail: (id: string, signal?: AbortSignal) => request<ImportRecord>(`/api/imports/${encodeURIComponent(id)}`, { signal }),
  create: (input: ImportInput) => request<{ importId: string; jobId: string }>('/api/imports', { method: 'POST', body: JSON.stringify(input) }),
  upload: uploadImport,
}
// END imports client contracts

// --- ACL client contracts ---
export type AclAccess = 'none' | 'read' | 'write'
export type AclSubjectType = 'user' | 'role' | 'everyone'
export interface AclRule {
  id: number
  prefix: string
  subjectType: AclSubjectType
  subject: string
  access: AclAccess
  createdBy: number | null
  createdAt: string
}
export interface AclRuleInput { prefix: string; subjectType: AclSubjectType; subject: string; access: AclAccess }
export interface AclCheck {
  userId: number
  path: string
  access: AclAccess
  rule: AclRule | null
  reason: 'admin' | 'rule' | 'role_default'
}
export const aclApi = {
  rules: (signal?: AbortSignal) => request<{ rules: AclRule[] }>('/api/admin/acl', { signal }),
  create: (input: AclRuleInput) => request<{ rule: AclRule }>('/api/admin/acl', { method: 'POST', body: JSON.stringify(input) }),
  delete: (id: number) => request<void>(`/api/admin/acl/${id}`, { method: 'DELETE' }),
  check: (userId: number, path: string, signal?: AbortSignal) => request<AclCheck>(`/api/admin/acl/check${query({ userId, path })}`, { signal }),
}
// --- End ACL client contracts ---

// BEGIN history client contracts
export interface HistoryCommitDetail { commit: CommitInfo; files: FileChange[]; patch: string; job: WriteJob | null }
export interface HistoryComparison { base: string; head: string; files: FileChange[]; patch: string }
export interface HistoryRevertPreview { files: FileChange[]; patch: string }
export interface HistoryRevertResult { jobId: string; mergeSha: string }
export interface JobEvent { phase: 'queued' | 'preparing' | 'editing' | 'committing' | 'merging' | 'resolving_conflict' | 'indexing' | 'cleanup' | 'done' | 'failed'; at: string; detail: Record<string, unknown> | null }
export interface JobDetail { job: WriteJob; user: Requester; commits: CommitInfo[]; events: JobEvent[] }
export const historyApi = {
  list: (options: { path?: string; before?: string; limit?: number; follow?: boolean } = {}, signal?: AbortSignal) => request<{ commits: CommitInfo[] }>(`/api/history${query({ path: options.path, before: options.before, limit: options.limit ?? 30, follow: options.follow ? '1' : undefined })}`, { signal }),
  commit: (sha: string, parent = 1, signal?: AbortSignal) => request<HistoryCommitDetail>(`/api/history/commits/${encodeURIComponent(sha)}${query({ parent })}`, { signal }),
  compare: (base: string, head: string, path?: string, signal?: AbortSignal) => request<HistoryComparison>(`/api/history/compare${query({ base, head, path })}`, { signal }),
  previewRevert: (sha: string, paths?: string[]) => request<HistoryRevertPreview>('/api/history/revert', { method: 'POST', body: JSON.stringify({ sha, paths, preview: true }) }),
  revert: (sha: string, paths?: string[]) => request<HistoryRevertResult>('/api/history/revert', { method: 'POST', body: JSON.stringify({ sha, paths, preview: false }) }),
}
// END history client contracts

// BEGIN jobs client contracts
export interface JobsListItem extends WriteJob { user: Requester }
export interface JobsPage { jobs: JobsListItem[]; nextCursor: string | null }
export const jobsApi = {
  // The server has no status filter. Walk raw pages before slicing a filtered page.
  async list(options: { before?: string; status?: WriteJob['status'] } = {}, signal?: AbortSignal): Promise<JobsPage> {
    const matches: JobsListItem[] = []
    let before = options.before
    for (;;) {
      const page = await request<{ jobs: JobsListItem[] }>(`/api/jobs${query({ mine: '1', before, limit: 100 })}`, { signal })
      for (const job of page.jobs) {
        if (!options.status || job.status === options.status) matches.push(job)
        if (matches.length === 31) return { jobs: matches.slice(0, 30), nextCursor: matches[29]!.id }
      }
      if (page.jobs.length < 100) return { jobs: matches, nextCursor: null }
      before = page.jobs.at(-1)!.id
    }
  },
  detail: (id: string, signal?: AbortSignal) => request<JobDetail>(`/api/jobs/${encodeURIComponent(id)}`, { signal }),
  retry: (id: string) => request<{ job: WriteJob }>(`/api/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
  cancel: (id: string) => request<{ job: WriteJob }>(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
}
// END jobs client contracts

// BEGIN dreams and journal client contracts
export interface JournalEntry { date: string; path: string; dreamRunId: string | null }
export const dreamsApi = {
  list: (options: { before?: string; limit?: number } = {}, signal?: AbortSignal) => request<{ runs: OpsDreamRun[]; nextCursor: string | null }>(`/api/dreams${query({ limit: 30, ...options })}`, { signal }),
  detail: (id: string, signal?: AbortSignal) => request<OpsDreamRun>(`/api/dreams/${encodeURIComponent(id)}`, { signal }),
  journal: (signal?: AbortSignal) => request<JournalEntry[]>('/api/journal', { signal }),
}
// END dreams and journal client contracts

// BEGIN activity timeline client contracts
export type ActivityKind = 'commit' | 'job' | 'dream' | 'backup'
export type ActivitySource = 'git' | 'mcp' | 'web' | 'chat' | 'dreaming' | 'import' | 'revert'
export interface ActivityFilters { type?: ActivityKind; source?: ActivitySource; path?: string }
export interface ActivityItem {
  id: string; type: ActivityKind; at: string; source: string; paths: string[]; summary: string | null
  commit?: CommitInfo
  job?: Omit<WriteJob, 'input' | 'error'> & { input?: string; error?: string | null }
  dream?: OpsDreamRun
  push?: OpsDreamRun['push']
}
export interface ActivityPageResult { items: ActivityItem[]; nextCursor: string | null }
export interface BackupStatus { lastAttempt: OpsDreamRun | null; lastSuccess: OpsDreamRun | null }
export const activityApi = {
  list: (options: ActivityFilters & { before?: string; limit?: number } = {}, signal?: AbortSignal) => request<ActivityPageResult>(`/api/activity${query({ limit: 30, ...options })}`, { signal }),
  backup: (signal?: AbortSignal) => request<BackupStatus>('/api/backup/status', { signal }),
  noteHistory: (path: string, signal?: AbortSignal) => request<{ commits: CommitInfo[] }>(`/api/history${query({ path, limit: 10, follow: '1' })}`, { signal }),
}
// END activity timeline client contracts
