import { Controller, Get, Res, UseGuards, type OnModuleDestroy } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import type { User } from '../auth/users.types.js';
import { EventsService } from './events.service.js';

@Controller('api/events')
@UseGuards(SessionGuard)
export class EventsController implements OnModuleDestroy {
  private readonly connections = new Set<Response>();
  constructor(private readonly events: EventsService) {}

  onModuleDestroy(): void {
    for (const response of this.connections) response.end();
    this.connections.clear();
  }

  @Get()
  stream(@CurrentUser() user: User, @Res() response: Response): void {
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    response.write(': connected\n\n');
    this.connections.add(response);
    const unsubscribe = this.events.subscribe((event, audience) => {
      if (audience !== 'all' && !audience.userIds.includes(user.id) && !(audience.admins && user.role === 'admin')) return;
      response.write(`id: ${this.events.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => response.write(': ping\n\n'), 25_000);
    heartbeat.unref();
    response.once('close', () => { clearInterval(heartbeat); unsubscribe(); this.connections.delete(response); });
  }
}
