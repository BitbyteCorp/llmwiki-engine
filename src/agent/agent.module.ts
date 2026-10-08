import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { RagModule } from '../rag/rag.module.js';
import { AgentService } from './agent.service.js';
import { AgentCheckpointsRepository } from './checkpoints.repository.js';

@Module({
  imports: [KnowledgeModule, RagModule],
  providers: [AgentService, AgentCheckpointsRepository],
  exports: [AgentService, AgentCheckpointsRepository],
})
export class AgentModule {}
