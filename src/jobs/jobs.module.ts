import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { LunaModule } from '../luna/luna.module.js';
import { RagModule } from '../rag/rag.module.js';
import { NoteWriterService } from './note-writer.service.js';
import { WriteJobsRepository } from './write-jobs.repository.js';
import { WriteJobsService } from './write-jobs.service.js';

@Module({
  imports: [AuthModule, KnowledgeModule, LunaModule, RagModule],
  providers: [WriteJobsRepository, WriteJobsService, NoteWriterService],
  exports: [WriteJobsService, NoteWriterService, WriteJobsRepository],
})
export class JobsModule {}
