import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResponseInputContent } from 'openai/resources/responses/responses.js';
import { ApiError, notFound } from '../api/api-error.js';
import { CONFIG, DB, LOGGER } from '../common/tokens.js';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { NoteWriterService } from '../jobs/note-writer.service.js';
import type { Logger } from '../log.js';

export const CHAT_UPLOAD_LIMIT = 20 * 1024 * 1024;
export const IMPORT_UPLOAD_LIMIT = 100 * 1024 * 1024;
const REPLAY_BUDGET = 25 * 1024 * 1024;
const TEXT_LIMIT = 32 * 1024;
export type UploadPurpose = 'chat' | 'import';
export interface Upload {
  id: string; userId: number; name: string; mediaType: string; size: number; createdAt: string; purpose: UploadPurpose;
}
interface UploadRow {
  id: string; user_id: number; name: string; media_type: string; size: number; created_at: string; purpose: UploadPurpose;
}

function detectMedia(buffer: Buffer, name: string, declared: string, purpose: UploadPurpose): string {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  const prefix = buffer.subarray(0, 12).toString('latin1');
  if (prefix.startsWith('GIF87a') || prefix.startsWith('GIF89a')) return 'image/gif';
  if (prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP') return 'image/webp';
  if (prefix.startsWith('%PDF-')) return 'application/pdf';
  if (purpose === 'import' && buffer.length >= 4 && buffer[0] === 80 && buffer[1] === 75
    && ((buffer[2] === 3 && buffer[3] === 4) || (buffer[2] === 5 && buffer[3] === 6))) return 'application/zip';
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new ApiError(415, 'unsupported_media_type', 'Upload must be an allowed image, PDF, UTF-8 text, or import ZIP'); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw new ApiError(415, 'unsupported_media_type', 'Binary data cannot be uploaded as text');
  }
  return declared.split(';')[0]?.trim().toLowerCase() === 'text/markdown' || /\.(md|markdown)$/i.test(name)
    ? 'text/markdown' : 'text/plain';
}

function safeName(name: string): string {
  const cleaned = name.split(/[\\/]/).at(-1)?.replace(/[\u0000-\u001f\u007f]/gu, '').trim();
  return cleaned?.slice(0, 255).toWellFormed() || 'upload';
}

@Injectable()
export class UploadsService implements OnModuleInit, OnModuleDestroy {
  private readonly directory: string;
  private readonly retentionMs: number;
  private timer?: NodeJS.Timeout;
  private readonly saving = new Set<string>();

  constructor(
    @Inject(CONFIG) config: Config,
    @Inject(DB) private readonly db: Db,
    private readonly writer: NoteWriterService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.directory = join(config.dataDir, 'uploads');
    const days = Number(process.env.UPLOAD_RETENTION_DAYS ?? 7);
    if (!Number.isFinite(days) || days <= 0) throw new Error('UPLOAD_RETENTION_DAYS must be positive');
    this.retentionMs = days * 24 * 60 * 60 * 1000;
    mkdirSync(this.directory, { recursive: true });
  }

  onModuleInit(): void {
    this.cleanup();
    this.timer = setInterval(() => {
      try { this.cleanup(); } catch (err) { this.logger.error({ err }, 'Upload cleanup failed'); }
    }, 60 * 60 * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async save(userId: number, input: { name: string; mediaType: string; buffer: Buffer; purpose?: UploadPurpose }): Promise<Upload> {
    const purpose = input.purpose ?? 'chat';
    if (purpose !== 'chat' && purpose !== 'import') throw new ApiError(400, 'invalid_input', 'Unknown upload purpose');
    const limit = purpose === 'import' ? IMPORT_UPLOAD_LIMIT : CHAT_UPLOAD_LIMIT;
    if (input.buffer.length > limit) throw new ApiError(413, 'upload_too_large', `Upload exceeds ${limit / 1024 / 1024} MiB`);
    const name = safeName(input.name);
    const mediaType = detectMedia(input.buffer, name, input.mediaType, purpose);
    const upload: Upload = { id: randomUUID(), userId, name, mediaType, size: input.buffer.length, createdAt: new Date().toISOString(), purpose };
    const path = join(this.directory, upload.id);
    writeFileSync(path, input.buffer, { flag: 'wx', mode: 0o600 });
    try {
      this.db.prepare('INSERT INTO uploads (id, user_id, name, media_type, size, created_at, purpose) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(upload.id, userId, name, mediaType, upload.size, upload.createdAt, purpose);
    } catch (error) {
      unlinkSync(path);
      throw error;
    }
    return upload;
  }

  get(userId: number, id: string): { upload: Upload; path: string } {
    const row = this.db.prepare('SELECT * FROM uploads WHERE id = ? AND user_id = ?').get(id, userId) as UploadRow | undefined;
    if (!row) notFound('Upload not found');
    const path = join(this.directory, row.id);
    if (!existsSync(path)) notFound('Upload file not found');
    return { upload: { id: row.id, userId: row.user_id, name: row.name, mediaType: row.media_type, size: row.size, createdAt: row.created_at, purpose: row.purpose }, path };
  }

  async saveAsset(userId: number, id: string, path: string, baseSha: string): Promise<{ jobId: string; mergeSha: string }> {
    const segments = path.split('/');
    if (segments[0] !== 'assets' || segments.length < 2 || segments.some((segment) => !segment || segment === '.' || segment === '..')
      || /[\\\u0000-\u001f\u007f]/u.test(path)) throw new ApiError(400, 'invalid_path', 'Upload assets must use a relative path under assets/');
    const stored = this.get(userId, id);
    this.saving.add(id);
    try {
      const result = await this.writer.apply({ userId, source: 'web', baseSha, ops: [{ op: 'put', path, contentBase64: readFileSync(stored.path).toString('base64') }] });
      this.db.prepare('UPDATE uploads SET saved_at = ? WHERE id = ?').run(new Date().toISOString(), id);
      return { jobId: result.jobId, mergeSha: result.mergeSha };
    } finally { this.saving.delete(id); }
  }

  async parts(userId: number, ids: string[], budget = REPLAY_BUDGET): Promise<ResponseInputContent[]> {
    if (!Number.isFinite(budget) || budget < 0) throw new ApiError(400, 'invalid_input', 'Replay budget must be non-negative');
    // Validate every owner and purpose before considering the replay budget.
    const stored = ids.map((id) => this.get(userId, id));
    for (const { upload } of stored) {
      if (upload.purpose !== 'chat' || upload.mediaType === 'application/zip') throw new ApiError(400, 'invalid_attachment', 'Import uploads cannot be used as chat attachments');
    }
    const parts: ResponseInputContent[] = [];
    for (const { upload, path } of stored) {
      const cost = upload.mediaType.startsWith('text/') ? Math.min(upload.size, TEXT_LIMIT) : upload.size;
      if (cost > budget) continue;
      let buffer: Buffer;
      if (upload.mediaType.startsWith('text/')) {
        buffer = Buffer.alloc(cost);
        const fd = openSync(path, 'r');
        try { readSync(fd, buffer, 0, cost, 0); } finally { closeSync(fd); }
      } else buffer = readFileSync(path);
      if (upload.mediaType.startsWith('image/')) {
        parts.push({ type: 'input_image', image_url: `data:${upload.mediaType};base64,${buffer.toString('base64')}`, detail: 'auto' });
      } else if (upload.mediaType === 'application/pdf') {
        parts.push({ type: 'input_file', filename: upload.name, file_data: `data:application/pdf;base64,${buffer.toString('base64')}` });
      } else {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer, { stream: upload.size > TEXT_LIMIT });
        parts.push({ type: 'input_text', text: `Attachment: ${upload.name}\n${text}` });
      }
      budget -= cost;
    }
    return parts;
  }

  cleanup(now = Date.now()): number {
    const cutoff = new Date(now - this.retentionMs).toISOString();
    const rows = this.db.prepare(`SELECT u.id FROM uploads u WHERE u.saved_at IS NULL AND u.created_at < ?
      AND NOT EXISTS (SELECT 1 FROM messages m, json_each(m.attachments) a WHERE a.value = u.id)`).all(cutoff) as Array<{ id: string }>;
    let removed = 0;
    for (const { id } of rows) {
      if (this.saving.has(id)) continue;
      const path = join(this.directory, id);
      if (existsSync(path)) unlinkSync(path);
      this.db.prepare('DELETE FROM uploads WHERE id = ?').run(id);
      removed++;
    }
    // A crash between creating the file and inserting its row can leave an orphan.
    const known = new Set((this.db.prepare('SELECT id FROM uploads').all() as Array<{ id: string }>).map(({ id }) => id));
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || known.has(entry.name)) continue;
      const path = join(this.directory, entry.name);
      if (statSync(path).mtimeMs < now - this.retentionMs) { unlinkSync(path); removed++; }
    }
    return removed;
  }
}
