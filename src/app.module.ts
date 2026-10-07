import { Module, type BeforeApplicationShutdown, type OnApplicationShutdown } from '@nestjs/common';
import { CommonModule } from './common/common.module.js';
import { KnowledgeModule } from './knowledge/knowledge.module.js';
import { RagModule } from './rag/rag.module.js';
import { LunaModule } from './luna/luna.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { AuthModule } from './auth/auth.module.js';
import { McpModule } from './mcp/mcp.module.js';
import { ApiModule } from './api/api.module.js';
import { DreamingModule } from './dreaming/dreaming.module.js';

@Module({
  imports: [
    CommonModule,
    KnowledgeModule,
    RagModule,
    LunaModule,
    JobsModule,
    AuthModule,
    McpModule,
    ApiModule,
    DreamingModule,
  ],
})
export class AppModule implements BeforeApplicationShutdown, OnApplicationShutdown {
  initialIndex: Promise<unknown> = Promise.resolve();
  closeNext?: () => Promise<void>;

  async beforeApplicationShutdown(): Promise<void> {
    await this.initialIndex;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.closeNext?.();
  }
}
