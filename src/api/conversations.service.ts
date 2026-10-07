import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { LOGGER } from '../common/tokens.js';
import { LunaService } from '../luna/luna.service.js';
import { notFound } from './api-error.js';
import { ConversationsRepository } from './conversations.repository.js';
import type { Conversation, Message } from './conversations.types.js';

@Injectable()
export class ConversationsService {
  constructor(
    private readonly repository: ConversationsRepository,
    private readonly luna: LunaService,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  list(userId: number): Conversation[] {
    return this.repository.list(userId);
  }

  create(userId: number, title?: string): Conversation {
    return this.repository.create(userId, title);
  }

  get(id: string, userId: number): { conversation: Conversation; messages: Message[] } {
    const conversation = this.repository.get(id, userId);
    if (!conversation) notFound('Conversation not found');
    return { conversation, messages: this.repository.messages(id, userId) };
  }

  delete(id: string, userId: number): void {
    if (!this.repository.delete(id, userId)) notFound('Conversation not found');
  }

  submitMessage(id: string, userId: number, content: string): Array<Pick<Message, 'role' | 'content'>> {
    if (!this.repository.addMessage(id, userId, 'user', content)) notFound('Conversation not found');
    return this.repository.messages(id, userId).map(({ role, content }) => ({ role, content }));
  }

  async answer(
    id: string,
    userId: number,
    messages: Array<Pick<Message, 'role' | 'content'>>,
    onTextDelta: (text: string) => void,
    signal: AbortSignal,
  ): Promise<Message | null> {
    try {
      const answer = await this.luna.answer(messages, onTextDelta, signal);
      if (signal.aborted) return null;
      const message = this.repository.addMessage(id, userId, 'assistant', answer.text, answer.citations);
      if (!message) notFound('Conversation not found');
      return message;
    } catch (error) {
      if (!signal.aborted) this.log.error({ err: error, conversationId: id }, 'Chat answer failed');
      throw error;
    }
  }
}
