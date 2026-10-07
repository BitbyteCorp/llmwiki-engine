import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';

/** Origin takes precedence: a conflicting Origin cannot be rescued by Fetch Metadata. */
export function assertSameOrigin(req: Request, publicUrl: string): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase())) return;
  const origin = req.get('origin');
  if (origin !== undefined) {
    if (origin === new URL(publicUrl).origin) return;
  } else if (req.get('sec-fetch-site') === 'same-origin') return;
  throw new ForbiddenException({ code: 'csrf_rejected', message: 'Same-origin request required' });
}
