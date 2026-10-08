import { ApiError, type Note } from '@/lib/api'
import { readCurrentNote, readNoteSnapshot, saveNote, uploadNoteImage } from './api'

export type AutosaveSnapshot = {
  baseline: Note | null
  draft: string
  phase: 'idle' | 'saving' | 'saved' | 'conflict' | 'error'
  busy: boolean
  error: unknown
  external: Note | null
  conflict: { base: Note; theirs: Note; mine: string } | null
}

export interface AutosaveSession {
  getSnapshot(): AutosaveSnapshot
  subscribe(listener: () => void): () => void
  setDraft(value: string): void
  acceptSnapshot(snapshot: Note): void
  observeSnapshot(snapshot: Note): void
  flush(options?: { retry?: boolean; overwrite?: Note }): Promise<void>
  images(files: File[]): Promise<string | undefined>
}

const sessions = new Map<string, Session>()
const debounceMs = 2_000
const maxWaitMs = 20_000
let unloadGuardRegistered = false

function guardUnload(event: BeforeUnloadEvent) {
  for (const session of sessions.values()) {
    const snapshot = session.getSnapshot()
    if (snapshot.busy || (snapshot.baseline && snapshot.draft !== snapshot.baseline.content)) {
      event.preventDefault()
      event.returnValue = ''
      return
    }
  }
}

function syncUnloadGuard() {
  if (typeof window === 'undefined') return
  if (sessions.size && !unloadGuardRegistered) {
    window.addEventListener('beforeunload', guardUnload)
    unloadGuardRegistered = true
  } else if (!sessions.size && unloadGuardRegistered) {
    window.removeEventListener('beforeunload', guardUnload)
    unloadGuardRegistered = false
  }
}

class Session implements AutosaveSession {
  references = 0
  private snapshot: AutosaveSnapshot
  private listeners = new Set<() => void>()
  private queue: Promise<void> = Promise.resolve()
  private pending = 0
  private timer: number | undefined
  private firstChangeAt: number | undefined
  private externalAfterUpload: Note | null = null

  constructor(public path: string, initial?: { baseline: Note | null; draft: string }) {
    this.snapshot = {
      baseline: initial?.baseline ?? null,
      draft: initial?.draft ?? '',
      phase: 'idle', busy: false, error: null, external: null, conflict: null,
    }
    this.schedule()
  }

  getSnapshot = () => this.snapshot

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private update(change: Partial<AutosaveSnapshot>) {
    this.snapshot = { ...this.snapshot, ...change }
    for (const listener of this.listeners) listener()
  }

  private dirty() {
    return Boolean(this.snapshot.baseline && this.snapshot.draft !== this.snapshot.baseline.content)
  }

  private paused() {
    return this.snapshot.phase === 'conflict' || this.snapshot.phase === 'error'
  }

  cancelTimer() {
    clearTimeout(this.timer)
    this.timer = undefined
    this.firstChangeAt = undefined
  }

  private schedule() {
    if (!this.dirty() || this.paused()) {
      this.cancelTimer()
      return
    }
    const now = Date.now()
    this.firstChangeAt ??= now
    clearTimeout(this.timer)
    const delay = Math.max(0, Math.min(debounceMs, this.firstChangeAt + maxWaitMs - now))
    this.timer = window.setTimeout(() => { void this.flush() }, delay)
  }

  setDraft = (value: string) => {
    if (value === this.snapshot.draft) return
    const conflict = this.snapshot.conflict
    this.update({
      draft: value,
      conflict: conflict ? { ...conflict, mine: value } : null,
      phase: this.snapshot.phase === 'saved' ? 'idle' : this.snapshot.phase,
    })
    this.schedule()
  }

  // Explicitly accepting a version discards the draft; save completion never calls this.
  acceptSnapshot = (snapshot: Note) => {
    this.cancelTimer()
    this.externalAfterUpload = null
    this.update({ baseline: snapshot, draft: snapshot.content, phase: 'idle', error: null, external: null, conflict: null })
  }

  observeSnapshot = (snapshot: Note) => {
    if (this.snapshot.busy) return
    const baseline = this.snapshot.baseline
    if (baseline && baseline.content === snapshot.content && baseline.updatedSha === snapshot.updatedSha) return
    if (this.paused()) {
      if (snapshot.content !== this.snapshot.baseline?.content) this.update({ external: snapshot })
      return
    }
    if (!this.snapshot.baseline || !this.dirty()) {
      this.acceptSnapshot(snapshot)
    } else if (snapshot.content !== this.snapshot.baseline.content) {
      this.update({ external: snapshot })
      // The optimistic write, not the notification, decides whether there is a conflict.
      void this.flush()
    } else if (snapshot.updatedSha !== this.snapshot.baseline.updatedSha) {
      this.update({ baseline: snapshot, external: null })
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.pending += 1
    this.update({ busy: true })
    const result = this.queue.then(operation)
    const settled = result.finally(() => {
      this.pending -= 1
      if (this.pending) return
      this.update({ busy: false })
      const external = this.externalAfterUpload
      this.externalAfterUpload = null
      if (external) this.observeSnapshot(external)
      if (!this.pending && this.timer === undefined) this.schedule()
    })
    // Every request shares this queue, including failed requests and multi-image uploads.
    this.queue = settled.then(() => undefined, () => undefined)
    return settled
  }

  private async failure(error: unknown, base: Note) {
    this.cancelTimer()
    if (error instanceof ApiError && error.status === 409 && error.code === 'stale_note') {
      try {
        const theirs = await readCurrentNote(this.path)
        this.externalAfterUpload = null
        this.cancelTimer()
        this.update({ phase: 'conflict', error: null, external: theirs, conflict: { base, theirs, mine: this.snapshot.draft } })
        return
      } catch (refreshError) { error = refreshError }
    }
    this.cancelTimer()
    this.update({ phase: 'error', error })
  }

  flush = (options?: { retry?: boolean; overwrite?: Note }): Promise<void> => {
    this.cancelTimer()
    if (this.paused() && !options?.retry && !options?.overwrite) return Promise.resolve()
    return this.enqueue(async () => {
      if (this.paused() && !options?.retry && !options?.overwrite) return
      // Capture at execution, after earlier saves/uploads have advanced the baseline.
      const base = options?.overwrite ?? this.snapshot.baseline
      if (!base) return
      const content = this.snapshot.draft
      if (content === base.content) {
        if (options?.overwrite || options?.retry) {
          this.update({ baseline: base, phase: 'idle', error: null, conflict: null, external: null })
        }
        return
      }
      const title = typeof base.frontmatter.title === 'string' && base.frontmatter.title.trim()
        ? base.frontmatter.title.trim() : this.path.split('/').pop()?.replace(/\.md$/i, '') || '노트'
      this.update({ phase: 'saving', error: null, conflict: null })
      try {
        const result = await saveNote(this.path, content, base.updatedSha, `docs(wiki): update ${title}`)
        const saved = await readNoteSnapshot(this.path, result.mergeSha)
        this.externalAfterUpload = null
        this.update({ baseline: saved, phase: 'saved', error: null, external: null, conflict: null })
      } catch (error) {
        await this.failure(error, base)
      }
    })
  }

  images = (files: File[]): Promise<string | undefined> => {
    if (!files.length || this.paused()) return Promise.resolve(undefined)
    return this.enqueue(async () => {
      if (this.paused() || !this.snapshot.baseline) return undefined
      const links: string[] = []
      let sha = this.snapshot.baseline.updatedSha
      try {
        for (const file of files) {
          const result = await uploadNoteImage(file, this.path, sha)
          sha = result.mergeSha
          links.push(result.markdown)
          const current = await readNoteSnapshot(this.path, sha)
          if (current.content === this.snapshot.baseline!.content) {
            this.externalAfterUpload = null
            this.update({ baseline: current })
          } else {
            // Asset commits may include somebody else's note edit. Never rebase a draft
            // onto it just because this request advanced the repository SHA.
            this.externalAfterUpload = current
          }
        }
      } catch (error) {
        this.cancelTimer()
        this.update({ phase: 'error', error })
      }
      return links.length ? links.join('\n') : undefined
    })
  }
}

export function acquireAutosave(path: string, initial?: { baseline: Note | null; draft: string }): AutosaveSession {
  let session = sessions.get(path)
  if (!session) {
    session = new Session(path, initial)
    sessions.set(path, session)
  }
  session.references += 1
  syncUnloadGuard()
  return session
}

export function releaseAutosave(session: AutosaveSession): void {
  if (!(session instanceof Session)) return
  session.references = Math.max(0, session.references - 1)
  const snapshot = session.getSnapshot()
  const clean = !snapshot.baseline || snapshot.draft === snapshot.baseline.content
  if (!session.references && clean && !snapshot.busy && snapshot.phase !== 'conflict' && snapshot.phase !== 'error' && sessions.get(session.path) === session) {
    sessions.delete(session.path)
    syncUnloadGuard()
  }
}

export async function flushAutosaves(paths: string[]): Promise<boolean> {
  const pending = [...new Set(paths)].flatMap(path => {
    const session = sessions.get(path)
    return session ? [session] : []
  })
  await Promise.all(pending.map(session => session.flush()))
  return pending.every(session => {
    const snapshot = session.getSnapshot()
    return !snapshot.busy && snapshot.phase !== 'conflict' && snapshot.phase !== 'error'
      && (!snapshot.baseline || snapshot.draft === snapshot.baseline.content)
  })
}

export function clearAutosave(path: string): void {
  sessions.get(path)?.cancelTimer()
  sessions.delete(path)
  syncUnloadGuard()
}

export function renameAutosave(from: string, to: string): void {
  if (from === to) return
  const session = sessions.get(from)
  if (!session) return
  clearAutosave(to)
  sessions.delete(from)
  session.path = to
  sessions.set(to, session)
}
