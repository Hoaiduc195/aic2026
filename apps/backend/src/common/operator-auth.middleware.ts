import { timingSafeEqual } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

function tokensMatch(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function createOperatorAuthMiddleware(expectedToken?: string) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!expectedToken || request.path === '/health') {
      next();
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
