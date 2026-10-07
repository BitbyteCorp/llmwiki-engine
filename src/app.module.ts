import { Module, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { CommonModule } from './common/common.module.js';
import { KnowledgeModule } from './knowledge/knowledge.module.js';
import { RagModule } from './rag/rag.module.js';
import { LunaModule } from './luna/luna.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { AuthModule } from './auth/auth.module.js';
import { McpModule } from './mcp/mcp.module.js';
import { ApiModule } from './api/api.module.js';
import { DreamingModule } from './dreaming/dreaming.module.js';
import { EventsModule } from './events/events.module.js';
import { AuditModule } from './audit/audit.module.js';
import { HttpRateLimitModule } from './common/http/rate-limit.module.js';
import { IngestModule } from './ingest/ingest.module.js';
import { ExportModule } from './export/export.module.js';

import { OpsModule } from './ops/ops.module.js';
@Module({
  imports: [
    CommonModule,
    EventsModule,
    KnowledgeModule,
    RagModule,
    LunaModule,
    JobsModule,
    AuthModule,
    AuditModule,
    HttpRateLimitModule,
    McpModule,
    ApiModule,
    DreamingModule,
    IngestModule,
    ExportModule,
    OpsModule,
  ],
})
export class AppModule implements OnApplicationBootstrap, BeforeApplicationShutdown {
  initialIndex: Promise<unknown> = Promise.resolve();
  closeNext?: () => Promise<void>;
  private httpServer?: Server;
  private readonly upgradedSockets = new Set<Duplex>();
  private readonly trackUpgrade = (_request: IncomingMessage, socket: Duplex): void => {
    this.upgradedSockets.add(socket);
    socket.once('close', () => this.upgradedSockets.delete(socket));
  };

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  onApplicationBootstrap(): void {
    this.httpServer = this.adapterHost.httpAdapter?.getHttpServer() as Server | undefined;
    this.httpServer?.on('upgrade', this.trackUpgrade);
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.initialIndex;
    await this.closeNext?.();
    // Node's HTTP close waits for upgraded sockets; Next custom close leaves HMR open.
    this.httpServer?.off('upgrade', this.trackUpgrade);
    for (const socket of this.upgradedSockets) socket.destroy();
    this.upgradedSockets.clear();
  }
}
