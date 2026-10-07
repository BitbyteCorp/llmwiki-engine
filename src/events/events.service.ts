import { Injectable } from '@nestjs/common';
import type { EventAudience, WikiEvent } from './events.types.js';

@Injectable()
export class EventsService {
  private readonly listeners = new Set<(event: WikiEvent, audience: EventAudience) => void>();
  private currentSequence = 0;
  get sequence(): number { return this.currentSequence; }
  publish(event: WikiEvent, audience: EventAudience): void {
    this.currentSequence += 1;
    for (const listener of this.listeners) listener(event, audience);
  }
  subscribe(listener: (event: WikiEvent, audience: EventAudience) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
