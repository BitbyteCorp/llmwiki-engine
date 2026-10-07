import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { RagModule } from '../rag/rag.module.js';
import { McpController } from './mcp.controller.js';
import { McpService } from './mcp.service.js';

@Module({
  imports: [AuthModule, JobsModule, KnowledgeModule, RagModule],
  controllers: [McpController],
  providers: [McpService],
})
export class McpModule {}
