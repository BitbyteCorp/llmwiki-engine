import { win32 } from 'node:path';
import { z } from 'zod';
import { idSchema } from '../common/ids.js';
import { NOTE_TYPES } from '../knowledge/note-metadata.js';

export const limitSchema = z.coerce.number().int().min(1).max(100).default(50);
export const shaSchema = z.string().regex(/^[a-f0-9]{7,64}$/i, 'Invalid commit SHA');
export { idSchema };
export const notePathSchema = z.string().min(1).max(4096).refine((path) =>
  !path.startsWith('/') && !win32.isAbsolute(path) && !path.includes('\\') && !path.includes('\0') &&
  !path.split('/').some((part) => part === '..' || part === '.' || part.toLowerCase() === '.git' || part === '') &&
  path.endsWith('.md'), 'Expected a repository-relative Markdown path');
export const repositoryPathSchema = z.string().min(1).max(4096).refine((path) =>
  !path.startsWith('/') && !win32.isAbsolute(path) && !path.includes('\\') && !path.includes('\0') &&
  !path.split('/').some((part) => part === '..' || part === '.' || part.toLowerCase() === '.git' || part === ''),
  'Expected a repository-relative file path');
export const roleSchema = z.enum(['admin', 'editor', 'viewer']);
export const titleSchema = z.string().trim().max(200);
export const userIdSchema = z.coerce.number().int().positive();

export const refSchema = z.string().min(1).max(200).refine((ref) => !ref.includes('\0'), 'Invalid reference');
export const noteContentQuerySchema = z.object({ path: notePathSchema, ref: refSchema.optional() });
export const noteRawQuerySchema = z.object({
  path: repositoryPathSchema.refine((path) => path.startsWith('assets/') && !/[\u0000-\u001f\u007f]/u.test(path),
    'Expected a repository-relative asset path under assets/'),
  ref: refSchema.optional(),
});
export const noteResolveQuerySchema = z.object({ name: z.string().trim().min(1).max(4096) });
export const searchLimitSchema = z.coerce.number().int().min(1).max(100).default(20);
const searchDateSchema = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(10000), limit: searchLimitSchema,
  cursor: z.string().min(1).max(200).optional(),
  type: z.enum(NOTE_TYPES).optional(),
  folder: z.string().trim().min(1).max(4096).optional(),
  tags: z.string().max(2000).transform((value) => value.split(',').map((tag) => tag.trim()).filter(Boolean)).optional(),
  from: searchDateSchema.optional(), to: searchDateSchema.optional(),
  author: z.string().trim().min(1).max(320).optional(),
});
export const searchSuggestQuerySchema = z.object({ q: z.string().trim().max(200).default('') });
export const searchSimilarQuerySchema = z.object({ path: notePathSchema, limit: searchLimitSchema });
export const searchDuplicatesQuerySchema = z.object({ limit: searchLimitSchema });
export const historyQuerySchema = z.object({ path: repositoryPathSchema.optional(), follow: z.literal('1').optional(), limit: limitSchema, before: shaSchema.optional() });
export const jobsQuerySchema = z.object({ mine: z.literal('1').optional(), limit: limitSchema, before: z.union([idSchema, z.iso.datetime()]).optional() });
export const notePutSchema = z.object({
  path: notePathSchema, content: z.string().max(10_000_000), baseSha: shaSchema,
  create: z.boolean().optional(), message: z.string().trim().min(1).max(2000).optional(),
}).strict();
export const noteMoveSchema = z.object({ from: notePathSchema, to: notePathSchema, baseSha: shaSchema }).strict();
export const noteDeleteSchema = z.object({ path: notePathSchema, baseSha: shaSchema });
export const noteBlameQuerySchema = noteContentQuerySchema;
export const historyCompareQuerySchema = z.object({ base: refSchema, head: refSchema, path: repositoryPathSchema.optional() });
export const commitParentQuerySchema = z.object({ parent: z.coerce.number().int().min(1).max(100).optional() });
export const historyRevertSchema = z.object({ sha: shaSchema, paths: z.array(repositoryPathSchema).min(1).max(1000).optional(), preview: z.boolean().optional() }).strict();
export const createConversationSchema = z.object({ title: titleSchema.optional() });
export const messageSchema = z.object({
  content: z.string().min(1).max(100000).refine((value) => value.trim().length > 0, 'Message must not be blank'),
  attachments: z.array(idSchema).max(10).optional(),
  context: z.object({ notePath: notePathSchema, ref: refSchema.optional(), selection: z.string().max(32000).optional() }).strict().optional(),
  clientId: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(200).optional(),
  effort: z.enum(['low','medium','high']).optional(),
});
export const conversationQuerySchema = z.object({ q: z.string().trim().max(1000).optional() });
export const renameConversationSchema = z.object({ title: titleSchema }).strict();
export const editMessageSchema = z.object({ content: messageSchema.shape.content }).strict();
export const conversationMemberSchema = z.object({ email: z.email().trim().toLowerCase(), role: z.enum(['editor','viewer']) }).strict();
export const presenceSchema = z.object({ typing: z.boolean() }).strict();
export const proposalSchema = z.object({ mode: z.enum(['new','edit']), path: notePathSchema.optional() }).strict()
  .refine(input => input.mode !== 'edit' || !!input.path, 'Edit proposals require a note path');
export const uploadPurposeSchema = z.object({ purpose: z.enum(['chat','import']).default('chat') });
export const uploadSaveSchema = z.object({ path: z.string().min(1).max(4096), baseSha: shaSchema }).strict();
export const createUserSchema = z.object({
  email: z.email().trim().toLowerCase(),
  name: z.string().trim().max(200).nullable().optional(),
  role: roleSchema,
  password: z.string().optional(),
});
export type UserCreateDto = z.infer<typeof createUserSchema>;
export const passwordLoginSchema = z.object({
  email: z.email().trim().toLowerCase(),
  password: z.string(),
  next: z.string().max(4096).optional(),
  request: z.string().min(1).max(200).optional(),
}).strict();
export type PasswordLoginDto = z.infer<typeof passwordLoginSchema>;
export const changePasswordSchema = z.object({
  currentPassword: z.string().optional(),
  newPassword: z.string(),
}).strict();
export type ChangePasswordDto = z.infer<typeof changePasswordSchema>;
export const setPasswordSchema = z.object({ password: z.string() }).strict();
export type SetPasswordDto = z.infer<typeof setPasswordSchema>;
export const updateUserSchema = z.object({
  role: roleSchema.optional(), name: z.string().trim().max(200).nullable().optional(),
}).refine((value) => value.role !== undefined || value.name !== undefined, 'At least one change is required');
export const settingsSchema = z.object({
  allowlistEnabled: z.boolean().optional(),
  allowedDomains: z.array(z.string().trim().toLowerCase().min(1).max(253)
    .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)).max(1000).optional(),
});

export const aclAccessSchema = z.enum(['none', 'read', 'write']);
export const aclPrefixSchema = z.string().min(1).max(4096).refine((prefix) => {
  if (prefix === '/') return true;
  const path = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return repositoryPathSchema.safeParse(path).success;
}, 'Expected /, a repository-relative folder ending in /, or an exact file path');
export const aclCreateSchema = z.discriminatedUnion('subjectType', [
  z.object({ prefix: aclPrefixSchema, subjectType: z.literal('user'), subject: userIdSchema.transform(String), access: aclAccessSchema }).strict(),
  z.object({ prefix: aclPrefixSchema, subjectType: z.literal('role'), subject: roleSchema, access: aclAccessSchema }).strict(),
  z.object({ prefix: aclPrefixSchema, subjectType: z.literal('everyone'), subject: z.literal('').default(''), access: aclAccessSchema }).strict(),
]);
export const aclRuleIdSchema = userIdSchema;
export const aclCheckQuerySchema = z.object({ userId: userIdSchema, path: aclPrefixSchema });

export const dreamsQuerySchema = z.object({ before: idSchema.optional(), limit: limitSchema });
export const activityQuerySchema = z.object({
  before: z.string().min(1).max(2048).optional(), limit: limitSchema, path: repositoryPathSchema.optional(),
  source: z.enum(['git', 'mcp', 'web', 'chat', 'dreaming', 'import', 'revert']).optional(),
  type: z.enum(['commit', 'job', 'dream', 'backup']).optional(),
});
export const reindexSchema = z.object({ full: z.boolean().optional() }).strict();
