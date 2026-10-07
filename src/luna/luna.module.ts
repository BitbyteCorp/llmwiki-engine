import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { RagModule } from '../rag/rag.module.js';
import { LunaService } from './luna.service.js';

@Module({
  imports: [KnowledgeModule, RagModule],
  providers: [LunaService],
  exports: [LunaService],
})
export class LunaModule {}
