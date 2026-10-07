import { Body, Controller, Get, Param, Post, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import type { User } from '../auth/users.types.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { IMPORT_UPLOAD_LIMIT, UploadsService } from '../uploads/uploads.service.js';
import { ApiError } from './api-error.js';

const purposeSchema = z.object({ purpose: z.enum(['chat', 'import']).default('chat') });
const saveSchema = z.object({ path: z.string().min(1), baseSha: z.string().regex(/^[a-f0-9]{40}$/i) });
interface MultipartFile { originalname: string; mimetype: string; buffer: Buffer }

function disposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

@Controller('api/uploads')
@UseGuards(SessionGuard, RolesGuard)
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: IMPORT_UPLOAD_LIMIT, files: 1, fields: 1, fieldSize: 32 } }))
  upload(
    @CurrentUser() user: User,
    @UploadedFile() file: MultipartFile | undefined,
    @Body(new ZodValidationPipe(purposeSchema)) body: z.infer<typeof purposeSchema>,
  ) {
    if (!file) throw new ApiError(400, 'invalid_input', 'Multipart field file is required');
    if (body.purpose === 'import' && user.role === 'viewer') throw new ApiError(403, 'forbidden', 'editor role required for import uploads');
    return this.uploads.save(user.id, { name: file.originalname, mediaType: file.mimetype, buffer: file.buffer, purpose: body.purpose });
  }

  @Get(':id')
  download(@CurrentUser() user: User, @Param('id') id: string, @Res() response: Response): void {
    const { upload, path } = this.uploads.get(user.id, id);
    response.setHeader('Content-Type', upload.mediaType);
    response.setHeader('Content-Disposition', disposition(upload.name));
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    response.setHeader('Cache-Control', 'private, no-store');
    response.sendFile(path);
  }

  @Post(':id/save')
  @Roles('editor')
  save(@CurrentUser() user: User, @Param('id') id: string, @Body(new ZodValidationPipe(saveSchema)) body: z.infer<typeof saveSchema>) {
    return this.uploads.saveAsset(user.id, id, body.path, body.baseSha);
  }
}
