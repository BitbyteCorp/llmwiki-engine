import { Controller, Get, Inject, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { LOGGER } from '../common/tokens.js';
import type { Logger } from '../log.js';
import { ExportService, type ExportDownload } from './export.service.js';

export const exportQuerySchema = z.object({ prefix: z.string().default(''), format: z.enum(['zip', 'bundle']).default('zip') });

@Controller('api/export')
@UseGuards(SessionGuard, RolesGuard)
export class ExportController {
  constructor(private readonly exports: ExportService, private readonly audit: AuditService, @Inject(LOGGER) private readonly log: Logger) {}

  @Get()
  async download(@Query(new ZodValidationPipe(exportQuerySchema)) query: z.infer<typeof exportQuerySchema>, @Req() req: Request, @Res() res: Response): Promise<void> {
    let download: ExportDownload | undefined;
    try {
      download = await this.exports.prepare(query, req.user!);
      download.assertAuthorized();
      res.setHeader('Content-Type', download.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${download.filename}"`);
      res.setHeader('X-Export-Head', download.manifest.headSha);
      res.setHeader('X-Export-Manifest', JSON.stringify(download.manifest));
      res.setHeader('Cache-Control', 'private, no-store');
      await pipeline(download.stream, res);
      this.audit.record({ actorId: req.user!.id, action: 'knowledge.export', target: download.manifest.headSha, outcome: 'success', summary: JSON.stringify({ format: query.format, prefix: query.prefix }) });
    } catch (error) {
      try {
        this.audit.record({ actorId: req.user!.id, action: 'knowledge.export', target: download?.manifest.headSha ?? 'main', outcome: 'failure', summary: JSON.stringify({ format: query.format, prefix: query.prefix }) });
      } catch (auditError) { this.log.error({ err: auditError }, 'Failed to audit export failure'); }
      throw error;
    } finally { if (download) { download.stream.destroy(); await download.dispose(); } }
  }
}
