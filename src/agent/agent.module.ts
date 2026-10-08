import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { RagModule } from '../rag/rag.module.js';
import { AgentService } from './agent.service.js';

@Module({
  imports: [KnowledgeModule, RagModule],
  providers: [AgentService],
  exports: [AgentService],
})
export class AgentModule {}
