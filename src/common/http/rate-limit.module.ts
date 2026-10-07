import { Global, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthRateLimitGuard } from './rate-limit.guard.js';
import { UserRateLimitInterceptor } from './rate-limit.interceptor.js';
import { RateLimitService } from './rate-limit.service.js';

@Global()
@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }])],
  providers: [
    RateLimitService,
    { provide: APP_GUARD, useClass: AuthRateLimitGuard },
    { provide: APP_INTERCEPTOR, useClass: UserRateLimitInterceptor },
  ],
  exports: [RateLimitService],
})
export class HttpRateLimitModule {}
