import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { LunaModule } from '../luna/luna.module.js';
import { RagModule } from '../rag/rag.module.js';
import { DreamRunsRepository } from './dream-runs.repository.js';
import { DreamingService } from './dreaming.service.js';

@Module({
  imports: [KnowledgeModule, LunaModule, RagModule],
  providers: [DreamRunsRepository, DreamingService],
  exports: [DreamingService],
})
export class DreamingModule {}
