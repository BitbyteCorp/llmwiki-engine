import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { LunaModule } from '../luna/luna.module.js';
import { RagModule } from '../rag/rag.module.js';
import { AdminController } from './admin.controller.js';
import { ConversationsController } from './conversations.controller.js';
import { ConversationsRepository } from './conversations.repository.js';
import { ConversationsService } from './conversations.service.js';
import { HistoryController } from './history.controller.js';
import { HistoryService } from './history.service.js';
import { JobsController } from './jobs.controller.js';
import { MeController } from './me.controller.js';
import { NotesController } from './notes.controller.js';
import { NotesService } from './notes.service.js';
import { SearchController } from './search.controller.js';

@Module({
  imports: [AuthModule, JobsModule, KnowledgeModule, LunaModule, RagModule],
  controllers: [
    MeController, NotesController, SearchController, HistoryController,
    JobsController, ConversationsController, AdminController,
  ],
  providers: [ConversationsRepository, ConversationsService, NotesService, HistoryService],
})
export class ApiModule {}
