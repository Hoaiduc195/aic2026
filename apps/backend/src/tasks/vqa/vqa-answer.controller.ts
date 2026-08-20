import { Body, Controller, Inject, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { parseVqaAnswerRequest } from './vqa-answer.request';
import { VqaAnswerService } from './vqa-answer.service';

export const VQA_ANSWER_RATE_LIMIT = 120;
export const VQA_ANSWER_RATE_WINDOW_MS = 60_000;

@Controller('v1/vqa')
export class VqaAnswerController {
  constructor(@Inject(VqaAnswerService) private readonly service: VqaAnswerService) {}

  @Post('answer')
  @Throttle({ default: { limit: VQA_ANSWER_RATE_LIMIT, ttl: VQA_ANSWER_RATE_WINDOW_MS } })
  answer(@Body() body: unknown) {
    return this.service.answer(parseVqaAnswerRequest(body));
  }
}
