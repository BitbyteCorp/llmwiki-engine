import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { UsageModule } from '../usage/usage.module.js';
import { IndexerService } from './indexer.service.js';
import { SearchService } from './search.service.js';
import { CatalogService } from './catalog.service.js';
import { ComparisonService } from './comparison.service.js';
import { CodexModule } from '../codex/codex.module.js';

@Module({
  imports: [KnowledgeModule, UsageModule, CodexModule],
  providers: [IndexerService, SearchService, CatalogService, ComparisonService],
  exports: [IndexerService, SearchService, CatalogService, ComparisonService],
})
export class RagModule {}
