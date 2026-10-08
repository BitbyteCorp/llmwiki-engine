import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { AgentModule } from '../agent/agent.module.js';
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
import { UploadsModule } from '../uploads/uploads.module.js';
import { UploadsController } from './uploads.controller.js';
import { GenerationsController } from './generations.controller.js';
import { GenerationsService } from './generations.service.js';
import { LinksController, GraphController } from './links.controller.js';
import { TagsController } from './tags.controller.js';
import { ModelsController } from './models.controller.js';

@Module({
  imports: [AuthModule, JobsModule, KnowledgeModule, AgentModule, RagModule, UploadsModule],
  controllers: [
    MeController, NotesController, SearchController, HistoryController,
    JobsController, ConversationsController, AdminController,
    UploadsController, GenerationsController, ModelsController,
    LinksController, GraphController, TagsController,
  ],
  providers: [ConversationsRepository, ConversationsService, GenerationsService, NotesService, HistoryService],
})
export class ApiModule {}
