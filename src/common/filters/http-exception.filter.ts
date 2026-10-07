import { Catch, HttpException, HttpStatus, Inject, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import type { Logger } from '../../log.js';
import { LOGGER } from '../tokens.js';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();
    let status = 500;
    let code = 'internal_error';
    let message = 'Internal server error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = status === 500 ? 'internal_error' : HttpStatus[status]?.toLowerCase() ?? 'request_failed';
      const payload = exception.getResponse();
      if (typeof payload === 'string') {
        message = payload;
      } else {
        const details = payload as { code?: unknown; message?: unknown };
        if (typeof details.code === 'string') code = details.code;
        if (typeof details.message === 'string') message = details.message;
        else if (Array.isArray(details.message)) message = details.message.join('; ');
        else message = exception.message;
      }
    } else if (exception instanceof ZodError) {
      status = 400;
      code = 'invalid_input';
      message = exception.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ');
    } else if (typeof exception === 'object' && exception !== null) {
      const details = exception as { status?: unknown; code?: unknown; message?: unknown };
      if (typeof details.status === 'number' && Number.isInteger(details.status)
        && details.status >= 400 && details.status <= 599) {
        status = details.status;
        code = typeof details.code === 'string' ? details.code : status === 500 ? 'internal_error' : 'bad_request';
        message = typeof details.message === 'string' ? details.message : 'Request failed';
      }
    }

    if (status >= 500) {
      message = 'Internal server error';
      this.logger.error({ err: exception, path: request.path }, 'HTTP request failed');
    }
    if (response.headersSent) return;
    response.status(status).json({ error: { code, message } });
  }
}
