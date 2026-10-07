import { win32 } from 'node:path';
import { z } from 'zod';

export const limitSchema = z.coerce.number().int().min(1).max(100).default(50);
export const shaSchema = z.string().regex(/^[a-f0-9]{7,64}$/i, 'Invalid commit SHA');
export const idSchema = z.string().min(1).max(200);
export const notePathSchema = z.string().min(1).max(4096).refine((path) =>
  !path.startsWith('/') && !win32.isAbsolute(path) && !path.includes('\\') && !path.includes('\0') &&
  !path.split('/').some((part) => part === '..' || part === '.' || part.toLowerCase() === '.git' || part === '') &&
  path.endsWith('.md'), 'Expected a repository-relative Markdown path');
export const roleSchema = z.enum(['admin', 'editor', 'viewer']);
export const titleSchema = z.string().trim().max(200);
export const userIdSchema = z.coerce.number().int().positive();

export const noteContentQuerySchema = z.object({ path: notePathSchema });
export const noteResolveQuerySchema = z.object({ name: z.string().trim().min(1).max(4096) });
export const searchQuerySchema = z.object({ q: z.string().trim().min(1).max(10000), limit: limitSchema });
export const historyQuerySchema = z.object({ path: notePathSchema.optional(), limit: limitSchema, before: shaSchema.optional() });
export const jobsQuerySchema = z.object({ mine: z.literal('1').optional(), limit: limitSchema, before: z.iso.datetime().optional() });
export const createConversationSchema = z.object({ title: titleSchema.optional() });
export const messageSchema = z.object({
  content: z.string().min(1).max(100000).refine((value) => value.trim().length > 0, 'Message must not be blank'),
});
export const createUserSchema = z.object({
  email: z.email().trim().toLowerCase(),
  name: z.string().trim().max(200).nullable().optional(),
  role: roleSchema,
});
export const updateUserSchema = z.object({
  role: roleSchema.optional(), name: z.string().trim().max(200).nullable().optional(),
}).refine((value) => value.role !== undefined || value.name !== undefined, 'At least one change is required');
export const settingsSchema = z.object({
  allowlistEnabled: z.boolean().optional(),
  allowedDomains: z.array(z.string().trim().toLowerCase().min(1).max(253)
    .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)).max(1000).optional(),
});
