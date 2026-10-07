import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { IndexerService } from './indexer.service.js';
import { SearchService } from './search.service.js';

@Module({
  imports: [KnowledgeModule],
  providers: [IndexerService, SearchService],
  exports: [IndexerService, SearchService],
})
export class RagModule {}
