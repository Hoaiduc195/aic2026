import { Body, Controller, Inject, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { parseVqaAnswerRequest } from './vqa-answer.request';
import { VqaAnswerService } from './vqa-answer.service';

@Controller('v1/vqa')
export class VqaAnswerController {
  constructor(@Inject(VqaAnswerService) private readonly service: VqaAnswerService) {}

  @Post('answer')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  answer(@Body() body: unknown) {
    return this.service.answer(parseVqaAnswerRequest(body));
  }
}
