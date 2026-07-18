import { Controller, Get } from '@nestjs/common';
@Controller()
export class HealthController {
  @Get('healthz') health() { return { status: 'ok' }; }
  @Get('readyz') ready() { return { status: 'ready', dependencies: { retrieval: 'degraded' } }; }
}
