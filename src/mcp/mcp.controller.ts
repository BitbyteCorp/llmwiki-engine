import { All, Controller, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import type { User } from '../auth/users.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { McpAuthGuard } from '../auth/guards/mcp-auth.guard.js';
import { LOGGER } from '../common/tokens.js';
import type { Logger } from '../log.js';
import { McpService } from './mcp.service.js';

@Controller('mcp')
@UseGuards(McpAuthGuard)
export class McpController {
  constructor(
    private readonly mcp: McpService,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  @Post()
  async post(@Req() req: Request, @Res() res: Response, @CurrentUser() user: User): Promise<void> {
    // A fresh server captures only this request's authenticated identity.
    const clientName = req.auth?.extra?.clientName;
    const server = this.mcp.createServer(user, typeof clientName === 'string' ? clientName : undefined);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.once('close', () => {
      void server.close().catch(error => {
        this.log.error({ err: error }, 'Failed to close MCP request');
      });
    });
    try {
      await server.connect(transport);
      // Nest has already parsed JSON; the SDK must not read the consumed stream.
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      this.log.error({ err: error }, 'MCP request failed');
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0', id: null,
          error: { code: -32603, message: 'Internal server error.' },
        });
      } else {
        res.end();
      }
    }
  }

  // Stateless GET/DELETE (and other non-POST methods) have no session to use.
  @All()
  methodNotAllowed(@Res() res: Response): void {
    res.set('Allow', 'POST').status(405).json({
      jsonrpc: '2.0', id: null,
      error: { code: -32000, message: 'Method not allowed.' },
    });
  }
}
