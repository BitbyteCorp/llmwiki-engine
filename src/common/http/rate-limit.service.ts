import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { Response } from 'express';
import type { Config } from '../../config.js';
import { CONFIG } from '../tokens.js';

@Injectable()
export class RateLimitService {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage,
  ) {}

  async consume(kind: 'auth' | 'user', identity: string, response: Response): Promise<void> {
    const windowMs = this.config.rateLimitWindowMs ?? 60_000;
    const limit = kind === 'auth' ? this.config.rateLimitAuth ?? 30 : this.config.rateLimitUser ?? 60;
    // Zero block duration uses the rolling window and never extends it on rejected requests.
    const result = await this.storage.increment(`${kind}:${identity}`, windowMs, limit, 0, kind);
    if (result.isBlocked) {
      response.setHeader('Retry-After', String(Math.max(1, result.timeToBlockExpire)));
      throw new HttpException({ code: 'rate_limited', message: 'Too many requests' }, HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}
