import { Controller, Get, Header, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { SkillDistributionService } from './skill-distribution.service.js';

@Controller('skills')
export class SkillController {
  constructor(private readonly distribution: SkillDistributionService) {}

  @Get('install.sh')
  @Header('Cache-Control', 'public, max-age=60')
  script(@Res() response: Response): void {
    response.set('Content-Type', 'text/x-shellscript; charset=utf-8').send(this.distribution.script);
  }

  @Get('manifest/:client')
  @Header('Cache-Control', 'public, max-age=60')
  manifest(@Param('client') client: string, @Res() response: Response): void {
    response.type('application/json').send(this.distribution.manifest(client));
  }

  @Get('version.json')
  @Header('Cache-Control', 'public, max-age=60')
  version(@Res() response: Response): void {
    response.type('application/json').send(this.distribution.version);
  }

  @Get('files/:digest')
  @Header('Cache-Control', 'public, max-age=60')
  file(@Param('digest') digest: string, @Res() response: Response): void {
    response.type('application/octet-stream').send(this.distribution.file(digest));
  }
}
