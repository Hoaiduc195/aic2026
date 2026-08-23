import { Body, Controller, Inject, Post } from '@nestjs/common';

import { parseExactFrameSearchRequest, parseSearchRequest } from '../common/request-validation';
import { RetrievalService } from '../retrieval/retrieval.service';

@Controller('v1')
export class SearchController {
  constructor(@Inject(RetrievalService) private readonly retrieval: RetrievalService) {}

  @Post('search')
  search(@Body() body: unknown) {
    return this.retrieval.search(parseSearchRequest(body));
  }

  @Post('search/exact-frames')
  exactFrames(@Body() body: unknown) {
    return this.retrieval.searchExactFrames(parseExactFrameSearchRequest(body));
  }

  @Post('search/plan')
  plan(@Body() body: unknown) {
    return this.retrieval.createPlan(parseSearchRequest(body));
  }
}
