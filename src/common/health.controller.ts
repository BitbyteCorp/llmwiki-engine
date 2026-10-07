import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ReadinessService, type ReadinessStatus } from '../ops/readiness.service.js';

@Controller()
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get('healthz')
  health(): { ok: true } {
    return { ok: true };
  }

  @Get('readyz')
  async ready(): Promise<ReadinessStatus> {
    const status = await this.readiness.check();
    if (!status.ok) throw new ServiceUnavailableException(status);
    return status;
  }
}
