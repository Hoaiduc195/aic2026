import { Body, Controller, Inject, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { parseQueryImprovementRequest } from './query-improver.request';
import { QueryImproverService } from './query-improver.service';

@Controller('v1/query')
export class QueryImproverController {
  constructor(@Inject(QueryImproverService) private readonly service: QueryImproverService) {}

  @Post('improve')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  improve(@Body() body: unknown) {
    return this.service.improve(parseQueryImprovementRequest(body));
  }
}
