import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { CONFIG } from '../common/tokens.js';
import type { Config } from '../config.js';

@Controller('api/models')
@UseGuards(SessionGuard, RolesGuard)
export class ModelsController {
  constructor(@Inject(CONFIG) private readonly config: Config) {}

  @Get()
  models() {
    return {
      models: this.config.llmModels,
      defaultModel: this.config.llmModel,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: this.config.llmReasoningEffort,
    };
  }
}
