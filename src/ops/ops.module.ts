import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DreamingModule } from '../dreaming/dreaming.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { RagModule } from '../rag/rag.module.js';
import { ActivityService } from './activity.service.js';
import { MetricsController } from './metrics.controller.js';
import { MetricsAuthGuard } from './metrics-auth.guard.js';
import { MetricsService } from './metrics.service.js';
import { OpsController } from './ops.controller.js';
import { ReadinessService } from './readiness.service.js';

@Global()
@Module({
  imports: [AuthModule, DreamingModule, JobsModule, KnowledgeModule, RagModule],
  controllers: [OpsController, MetricsController],
  providers: [ActivityService, ReadinessService, MetricsService, MetricsAuthGuard],
  exports: [ReadinessService, MetricsService],
})
export class OpsModule {}
