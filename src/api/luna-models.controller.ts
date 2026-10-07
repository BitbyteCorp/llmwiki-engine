import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { CONFIG } from '../common/tokens.js';
import type { Config } from '../config.js';

@Controller('api/luna')
@UseGuards(SessionGuard, RolesGuard)
export class LunaModelsController {
  constructor(@Inject(CONFIG) private readonly config: Config) {}

  @Get('models')
  models() {
    return {
      models: (process.env.LUNA_MODELS ?? this.config.lunaModel).split(',').map(value => value.trim()).filter(Boolean),
      defaultModel: this.config.lunaModel,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: this.config.lunaReasoningEffort,
    };
  }
}
