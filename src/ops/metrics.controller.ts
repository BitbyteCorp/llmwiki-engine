import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { MetricsAuthGuard } from './metrics-auth.guard.js';
import { MetricsService } from './metrics.service.js';

@Controller('metrics')
@UseGuards(MetricsAuthGuard)
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  async scrape(@Res() response: Response): Promise<void> {
    const text = await this.metrics.scrape();
    response.setHeader('Content-Type', this.metrics.contentType);
    response.setHeader('Cache-Control', 'no-store');
    response.send(text);
  }
}
