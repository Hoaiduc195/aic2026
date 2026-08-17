import { timingSafeEqual } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

function tokensMatch(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function createOperatorAuthMiddleware(expectedToken?: string, allowUnauthenticatedLocal = false) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (request.path === '/health') {
      next();
      return;
    }

    if (!expectedToken) {
      if (allowUnauthenticatedLocal) {
        next();
        return;
      }
      response.status(503).json({ message: 'operator authentication is not configured' });
      return;
    }

    const providedToken = request.header('x-operator-token');
    if (!providedToken || !tokensMatch(providedToken, expectedToken)) {
      response.status(401).json({ message: 'operator token is required' });
      return;
    }

    next();
  };
}
