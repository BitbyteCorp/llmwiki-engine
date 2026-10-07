import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { UploadsModule } from '../uploads/uploads.module.js';
import { ImportsController } from './imports.controller.js';
import { ImportsRepository } from './imports.repository.js';
import { IngestService } from './ingest.service.js';
@Module({
  imports: [AuthModule, JobsModule, KnowledgeModule, UploadsModule],
  controllers: [ImportsController],
  providers: [ImportsRepository, IngestService],
  exports: [IngestService],
})
export class IngestModule {}
