export type Role = 'admin' | 'editor' | 'viewer'
export interface User { id: number; email: string; name: string | null; role: Role; createdAt: string; lastLoginAt: string | null }
export interface Note { path: string; content: string; frontmatter: Record<string, unknown>; body: string; updatedSha: string }
export interface SearchHit { path: string; title: string; heading: string; snippet: string; score: number; kind: 'wiki' | 'journal' | 'raw' | 'other'; related: string[] }
export interface CommitInfo { sha: string; parents: string[]; authorName: string; authorEmail: string; date: string; subject: string; body: string }
export interface FileChange { status: 'A' | 'M' | 'D' | 'R'; path: string; oldPath?: string }
export interface WriteJob { id: string; userId: number; source: 'mcp' | 'dreaming'; input: string; status: 'queued' | 'running' | 'merging' | 'succeeded' | 'failed'; summary: string | null; commits: string[]; mergeSha: string | null; error: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null }
export interface Conversation { id: string; title: string; createdAt: string; updatedAt: string }
export interface Message { id: string; role: 'user' | 'assistant'; content: string; citations: string[]; createdAt: string }
export interface Settings { allowlistEnabled: boolean; allowedDomains: string[] }
export type Requester = Pick<User, 'email' | 'name'>
export type ChatEvent = { event: 'delta'; data: { text: string } } | { event: 'done'; data: { message: Message } } | { event: 'error'; data: { message: string } }

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
  note: (path: string) => request<Note>(`/api/notes/content${query({ path })}`),
  resolve: (name: string) => request<{ path: string }>(`/api/notes/resolve${query({ name })}`),
  search: (q: string) => request<{ hits: SearchHit[] }>(`/api/search${query({ q, limit: 30 })}`),
  history: (path?: string, before?: string) => request<{ commits: CommitInfo[] }>(`/api/history${query({ path, before, limit: 30 })}`),
  commit: (sha: string) => request<{ commit: CommitInfo; files: FileChange[]; patch: string; job: WriteJob | null }>(`/api/commits/${encodeURIComponent(sha)}`),
  jobs: (mine = false, before?: string) => request<{ jobs: (WriteJob & { user: Requester })[] }>(`/api/jobs${query({ mine: mine ? '1' : undefined, before, limit: 30 })}`),
  job: (id: string) => request<{ job: WriteJob; user: Requester; commits: CommitInfo[] }>(`/api/jobs/${encodeURIComponent(id)}`),
  conversations: () => request<{ conversations: Conversation[] }>('/api/conversations'),
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
