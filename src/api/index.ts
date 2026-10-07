import { posix, win32 } from 'node:path';
import { Router, type ErrorRequestHandler, type Request, type Response } from 'express';
import matter from 'gray-matter';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireUser, type User } from '../auth/index.js';
import type { WriteJob } from '../jobs/service.js';
import { ChatStore } from './storage.js';

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, 'invalid_input', result.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; '));
  return result.data;
}

function user(req: Request): User {
  if (!req.user) throw new ApiError(401, 'unauthorized', 'Authentication required');
  return req.user;
}

const limit = z.coerce.number().int().min(1).max(100).default(50);
const sha = z.string().regex(/^[a-f0-9]{7,64}$/i, 'Invalid commit SHA');
const id = z.string().min(1).max(200);
const notePath = z.string().min(1).max(4096).refine((path) =>
  !path.startsWith('/') && !win32.isAbsolute(path) && !path.includes('\\') && !path.includes('\0') &&
  !path.split('/').some((part) => part === '..' || part === '.' || part.toLowerCase() === '.git' || part === '') &&
  path.endsWith('.md'), 'Expected a repository-relative Markdown path');
const role = z.enum(['admin', 'editor', 'viewer']);
const title = z.string().trim().max(200);
function notFound(message: string): never { throw new ApiError(404, 'not_found', message); }

export function apiRouter(ctx: AppContext): Router {
  const router = Router();
  const chats = new ChatStore(ctx.db);
  router.use(requireUser(ctx));

  const requester = (job: WriteJob) => {
    const owner = ctx.users.getById(job.userId);
    return { email: owner?.email ?? 'deleted user', name: owner?.name ?? null };
  };

  router.get('/me', (req, res) => { res.json({ user: user(req) }); });
  router.get('/notes/tree', async (_req, res) => {
    res.json({ files: await ctx.repo.listFiles(undefined, 'main') });
  });
  router.get('/notes/content', async (req, res) => {
    const { path } = parse(z.object({ path: notePath }), req.query);
    // Read a single main snapshot so content and its revision cannot diverge during a merge.
    const updatedSha = await ctx.repo.headSha();
    const content = await ctx.repo.readFile(path, updatedSha);
    if (content === null) notFound('Note not found');
    const parsed = matter(content);
    res.json({ path, content, frontmatter: parsed.data, body: parsed.content, updatedSha });
  });
  router.get('/notes/resolve', async (req, res) => {
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(4096) }), req.query);
    const target = name.replace(/\.md$/i, '').toLowerCase();
    const files = await ctx.repo.listFiles(undefined, 'main');
    const path = files.sort().find((file) => posix.basename(file).replace(/\.md$/i, '').toLowerCase() === target);
    if (!path) notFound('Note not found');
    res.json({ path });
  });
  router.get('/search', async (req, res) => {
    const query = parse(z.object({ q: z.string().trim().min(1).max(10000), limit }), req.query);
    res.json({ hits: await ctx.search.search(query.q, { limit: query.limit }) });
  });
  router.get('/history', async (req, res) => {
    const query = parse(z.object({ path: notePath.optional(), limit, before: sha.optional() }), req.query);
    res.json({ commits: await ctx.repo.log({ path: query.path, limit: query.limit, beforeSha: query.before }) });
  });
  router.get('/commits/:sha', async (req, res) => {
    const commitSha = parse(sha, req.params.sha);
    const detail = await ctx.repo.show(commitSha);
    const row = ctx.db.prepare(`
      SELECT id FROM write_jobs
      WHERE merge_sha = ? OR EXISTS (
        SELECT 1 FROM json_each(write_jobs.commits) WHERE json_each.value = ?
      )
      ORDER BY created_at DESC LIMIT 1
    `).get(detail.commit.sha, detail.commit.sha) as { id: string } | undefined;
    res.json({ ...detail, job: row ? ctx.jobs.get(row.id) : null });
  });
  router.get('/jobs', (req, res) => {
    const query = parse(z.object({ mine: z.literal('1').optional(), limit, before: z.iso.datetime().optional() }), req.query);
    const jobs = ctx.jobs.list({ userId: query.mine ? user(req).id : undefined, limit: query.limit, before: query.before });
    res.json({ jobs: jobs.map((job) => ({ ...job, user: requester(job) })) });
  });
  router.get('/jobs/:id', async (req, res) => {
    const jobId = parse(id, req.params.id);
    const job = ctx.jobs.get(jobId);
    if (!job) notFound('Write job not found');
    const shas = [...new Set([...job.commits, ...(job.mergeSha ? [job.mergeSha] : [])])];
    const commits = await Promise.all(shas.map(async (commitSha) => (await ctx.repo.show(commitSha)).commit));
    res.json({ job, user: requester(job), commits });
  });

  router.get('/conversations', (req, res) => { res.json({ conversations: chats.list(user(req).id) }); });
  router.post('/conversations', (req, res) => {
    const input = parse(z.object({ title: title.optional() }), req.body);
    res.status(201).json({ conversation: chats.create(user(req).id, input.title) });
  });
  router.get('/conversations/:id', (req, res) => {
    const conversationId = parse(id, req.params.id);
    const ownerId = user(req).id;
    const conversation = chats.get(conversationId, ownerId);
    if (!conversation) notFound('Conversation not found');
    res.json({ conversation, messages: chats.messages(conversationId, ownerId) });
  });
  router.delete('/conversations/:id', (req, res) => {
    const conversationId = parse(id, req.params.id);
    if (!chats.delete(conversationId, user(req).id)) notFound('Conversation not found');
    res.status(204).end();
  });
  router.post('/conversations/:id/messages', async (req, res) => {
    const conversationId = parse(id, req.params.id);
    const { content } = parse(z.object({
      content: z.string().min(1).max(100000).refine((value) => value.trim().length > 0, 'Message must not be blank'),
    }), req.body);
    const ownerId = user(req).id;
    if (!chats.addMessage(conversationId, ownerId, 'user', content)) notFound('Conversation not found');
    const messages = chats.messages(conversationId, ownerId).map(({ role, content }) => ({ role, content }));
    const controller = new AbortController();
    const abort = () => { controller.abort(); };
    req.on('aborted', abort);
    res.on('close', abort);
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const send = (event: string, data: unknown) => {
      if (!controller.signal.aborted && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    try {
      const answer = await ctx.luna.answer(messages, (text) => { send('delta', { text }); }, controller.signal);
      if (!controller.signal.aborted) {
        const message = chats.addMessage(conversationId, ownerId, 'assistant', answer.text, answer.citations);
        if (!message) notFound('Conversation not found');
        send('done', { message });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        ctx.log.error({ err: error, conversationId }, 'Chat answer failed');
        send('error', { message: error instanceof Error ? error.message : 'Answer failed' });
      }
    } finally {
      req.off('aborted', abort);
      res.off('close', abort);
      if (!res.writableEnded) res.end();
    }
  });

  const admin = Router();
  admin.use(requireUser(ctx, 'admin'));
  admin.get('/users', (_req, res) => { res.json({ users: ctx.users.list() }); });
  admin.post('/users', (req, res) => {
    const input = parse(z.object({ email: z.email().trim().toLowerCase(), name: z.string().trim().max(200).nullable().optional(), role }), req.body);
    res.status(201).json({ user: ctx.users.create(input) });
  });
  admin.patch('/users/:id', (req, res) => {
    const userId = parse(z.coerce.number().int().positive(), req.params.id);
    const input = parse(z.object({ role: role.optional(), name: z.string().trim().max(200).nullable().optional() }).refine((value) =>
      value.role !== undefined || value.name !== undefined, 'At least one change is required'), req.body);
    res.json({ user: ctx.users.update(userId, input) });
  });
  admin.delete('/users/:id', (req, res) => {
    const userId = parse(z.coerce.number().int().positive(), req.params.id);
    ctx.users.delete(userId);
    res.status(204).end();
  });
  admin.get('/settings', (_req, res) => { res.json(ctx.users.getSettings()); });
  admin.put('/settings', (req, res) => {
    const input = parse(z.object({
      allowlistEnabled: z.boolean().optional(),
      allowedDomains: z.array(z.string().trim().toLowerCase().min(1).max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)).max(1000).optional(),
    }), req.body);
    res.json(ctx.users.setSettings(input));
  });
  router.use('/admin', admin);

  const errors: ErrorRequestHandler = (error: unknown, _req: Request, res: Response, next) => {
    if (res.headersSent) { next(error); return; }
    const value = error as { status?: unknown; code?: unknown };
    const status = typeof value?.status === 'number' && value.status >= 400 && value.status <= 599 ? value.status : 500;
    const code = typeof value?.code === 'string' ? value.code : status === 500 ? 'internal_error' : 'bad_request';
    if (status === 500) ctx.log.error({ err: error }, 'API request failed');
    res.status(status).json({ error: { code, message: status === 500 ? 'Internal server error' : error instanceof Error ? error.message : 'Request failed' } });
  };
  router.use(errors);
  return router;
}
