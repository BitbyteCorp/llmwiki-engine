import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { OAuthService } from './oauth.service.js';
import { OAuthFailure } from './oauth.types.js';

@Controller()
export class OAuthController {
  constructor(private readonly oauth: OAuthService) {}

  @Get(['.well-known/oauth-protected-resource', '.well-known/oauth-protected-resource/mcp'])
  protectedMetadata(@Res() res: Response): void {
    res.json(this.oauth.protectedResourceMetadata());
  }

  @Get('.well-known/oauth-authorization-server')
  authorizationMetadata(@Res() res: Response): void {
    res.json(this.oauth.authorizationServerMetadata());
  }

  @Post('oauth/register')
  register(@Body() body: unknown, @Res() res: Response): Promise<void> {
    return this.respond(res, () => { res.status(201).json(this.oauth.register(body)); });
  }

  @Get('oauth/authorize')
  authorize(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.respond(res, () => this.oauth.authorize(req, res));
  }

  @Post('oauth/token')
  token(@Body() body: unknown, @Res() res: Response): Promise<void> {
    return this.respond(res, async () => { res.status(200).json(await this.oauth.token(body)); });
  }

  @Post('oauth/revoke')
  revoke(@Body() body: unknown, @Res() res: Response): Promise<void> {
    return this.respond(res, async () => {
      await this.oauth.revoke(body);
      res.status(200).end();
    });
  }

  private async respond(res: Response, handler: () => void | Promise<void>): Promise<void> {
    res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
    try {
      await handler();
    } catch (error) {
      if (error instanceof OAuthFailure) {
        res.status(error.status).json({ error: error.code, error_description: error.message });
      } else {
        const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : 500;
        res.status(status).json({ error: status >= 500 ? 'server_error' : 'access_denied',
          error_description: status >= 500 ? 'Authorization failed' : error instanceof Error ? error.message : 'Authorization failed' });
      }
    }
  }
}
