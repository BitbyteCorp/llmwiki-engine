import { ApiError, request, type Note } from '@/lib/api'

export type NoteWrite = { jobId: string; mergeSha: string }

export function saveNote(path: string, content: string, baseSha: string, message: string) {
  return request<NoteWrite>('/api/notes', { method: 'PUT', body: JSON.stringify({ path, content, baseSha, message }) })
}

export async function uploadNoteImage(file: File, notePath: string, baseSha: string) {
  const form = new FormData()
  form.set('purpose', 'chat')
  form.set('file', file)
  // Multipart must retain the browser-generated boundary, unlike JSON request().
  const response = await fetch('/api/uploads', { method: 'POST', credentials: 'same-origin', body: form })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null
    if (response.status === 401) window.dispatchEvent(new CustomEvent('session-expired'))
    throw new ApiError(response.status, payload?.error?.code ?? 'upload_failed', payload?.error?.message ?? '이미지 업로드에 실패했습니다.')
  }
  const upload = await response.json() as { id: string; name: string; mediaType: string }
  if (!upload.mediaType.startsWith('image/')) throw new Error('이미지 파일만 노트에 첨부할 수 있습니다.')
  const name = upload.name.replace(/[\\/\u0000-\u001f\u007f]/g, '-').replace(/\s+/g, '-').replace(/[()\[\]#?%]/g, '-') || 'image'
  const assetPath = `assets/${new Date().toISOString().slice(0, 10)}/${upload.id.slice(0, 8)}-${name}`
  const result = await request<NoteWrite>(`/api/uploads/${encodeURIComponent(upload.id)}/save`, { method: 'POST', body: JSON.stringify({ path: assetPath, baseSha }) })
  const noteFolders = notePath.split('/').slice(0, -1)
  const assetParts = assetPath.split('/')
  while (noteFolders.length && noteFolders[0] === assetParts[0]) { noteFolders.shift(); assetParts.shift() }
  const relative = [...noteFolders.map(() => '..'), ...assetParts].map(part => part === '..' ? part : encodeURIComponent(part)).join('/')
  return { ...result, markdown: `![${upload.name.replace(/[\\\[\]]/g, '')}](${relative})` }
}

export function readNoteSnapshot(path: string, ref?: string) {
  const query = new URLSearchParams({ path })
  if (ref) query.set('ref', ref)
  return request<Note>(`/api/notes/content?${query}`)
}

// Deleted notes still need the current repository snapshot for conflict/restore.
export async function readCurrentNote(path: string): Promise<Note> {
  try { return await readNoteSnapshot(path) }
  catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error
    const history = await request<{ commits: { sha: string }[] }>('/api/history?limit=1')
    const head = history.commits[0]?.sha
    if (!head) throw error
    return { path, content: '', body: '', frontmatter: {}, updatedSha: head }
  }
}
