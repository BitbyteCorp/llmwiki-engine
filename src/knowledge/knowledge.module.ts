import { Module } from '@nestjs/common';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import { CONFIG, LOGGER } from '../common/tokens.js';
import { KnowledgeRepo } from './repo.js';
import { WikiCatalog } from './wiki-catalog.js';

@Module({
  providers: [{
    provide: KnowledgeRepo,
    inject: [CONFIG, LOGGER],
    useFactory: (config: Config, logger: Logger): Promise<KnowledgeRepo> => KnowledgeRepo.open(config, logger),
  }, WikiCatalog],
  exports: [KnowledgeRepo, WikiCatalog],
})
export class KnowledgeModule {}
