import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { UsageController } from './usage.controller.js';
import { UsageRepository } from './usage.repository.js';
import { UsageService } from './usage.service.js';

@Module({
  imports: [AuthModule],
  controllers: [UsageController],
  providers: [UsageRepository, UsageService],
  exports: [UsageService],
})
export class UsageModule {}
