import 'reflect-metadata';
import 'dotenv/config';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { createOperatorAuthMiddleware } from './common/operator-auth.middleware';
import { APP_CONFIG } from './common/tokens';
import type { BackendConfig } from './common/config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get<BackendConfig>(APP_CONFIG);

  app.enableCors({
    origin: config.corsOrigins,
    credentials: false,
  });
  app.use(createOperatorAuthMiddleware(config.operatorToken));
  await app.listen(config.port, '0.0.0.0');
}

void bootstrap();
