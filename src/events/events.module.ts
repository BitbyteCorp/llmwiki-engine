import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { EventsService } from './events.service.js';
import { EventsController } from './events.controller.js';

@Global()
@Module({ imports: [AuthModule], controllers: [EventsController], providers: [EventsService], exports: [EventsService] })
export class EventsModule {}
