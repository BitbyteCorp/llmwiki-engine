import { Injectable } from '@nestjs/common';
import type { EventAudience, WikiEvent } from './events.types.js';

@Injectable()
export class EventsService {
  private readonly listeners = new Set<(event: WikiEvent, audience: EventAudience) => void>();
  private currentSequence = 0;
  private frameEvent: WikiEvent | undefined;
  private frameSequence = -1;
  private frameText = '';
  get sequence(): number { return this.currentSequence; }
  publish(event: WikiEvent, audience: EventAudience): void {
    this.currentSequence += 1;
    for (const listener of this.listeners) listener(event, audience);
  }
  format(event: WikiEvent): string {
    if (this.frameEvent !== event || this.frameSequence !== this.currentSequence) {
      this.frameEvent = event;
      this.frameSequence = this.currentSequence;
      this.frameText = `id: ${this.currentSequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    }
    return this.frameText;
  }
  subscribe(listener: (event: WikiEvent, audience: EventAudience) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
