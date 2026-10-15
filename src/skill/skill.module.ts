import { Module } from '@nestjs/common';
import { fileURLToPath } from 'node:url';
import { SkillController } from './skill.controller.js';
import { SKILL_ASSETS, SkillDistributionService } from './skill-distribution.service.js';

@Module({
  controllers: [SkillController],
  providers: [SkillDistributionService, { provide: SKILL_ASSETS, useValue: fileURLToPath(new URL('../../skills/', import.meta.url)) }],
})
export class SkillModule {}
