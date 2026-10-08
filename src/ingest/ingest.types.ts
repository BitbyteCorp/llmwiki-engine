import { z } from 'zod';
import { idSchema } from '../common/ids.js';
export const importKindSchema = z.enum(['url', 'pdf', 'text', 'obsidian', 'notion', 'file']);
export type ImportKind = z.infer<typeof importKindSchema>;
export const ingestSchema = z.object({
  kind: importKindSchema,
  url: z.string().max(4096).optional(), uploadId: idSchema.optional(),
  text: z.string().max(20 * 1024 * 1024).optional(), filename: z.string().min(1).max(255).optional(),
  instructions: z.string().trim().max(10_000).optional(),
}).strict().superRefine((value, ctx) => {
  const inputs = Number(value.url !== undefined) + Number(value.uploadId !== undefined) + Number(value.text !== undefined);
  if (inputs !== 1) ctx.addIssue({ code: 'custom', message: 'Exactly one of url, uploadId or text is required' });
  if (value.kind === 'url' && !value.url) ctx.addIssue({ code: 'custom', message: 'URL import requires url' });
  if (value.kind === 'text' && !value.text?.trim()) ctx.addIssue({ code: 'custom', message: 'Text import requires nonblank text' });
  if (['obsidian','notion','file'].includes(value.kind) && !value.uploadId) ctx.addIssue({ code: 'custom', message: 'File and vault imports require uploadId' });
  if (value.kind === 'pdf' && !value.url && !value.uploadId) ctx.addIssue({ code: 'custom', message: 'PDF import requires url or uploadId' });
});
export type IngestInput = z.infer<typeof ingestSchema> & { userId: number };
export interface ImportJob {
  batch: number; jobId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  error: string | null; files: number;
}
export interface ImportRecord {
  id: string; userId: number; kind: ImportKind; source: string; sha: string | null;
  status: 'extracting' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  rawPaths: string[]; jobs: ImportJob[]; error: string | null;
  createdAt: string; updatedAt: string; finishedAt: string | null;
}
