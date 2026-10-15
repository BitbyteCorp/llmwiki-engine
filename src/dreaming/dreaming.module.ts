import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { AgentModule } from '../agent/agent.module.js';
import { RagModule } from '../rag/rag.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { DreamRunsRepository } from './dream-runs.repository.js';
import { DreamingService } from './dreaming.service.js';

@Module({
  imports: [KnowledgeModule, AgentModule, RagModule, JobsModule],
  providers: [DreamRunsRepository, DreamingService],
  exports: [DreamingService, DreamRunsRepository],
})
export class DreamingModule {}
