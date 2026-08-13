import { Body, Controller, Post } from '@nestjs/common';

import { buildSubmissionPreview } from './submission-preview';

@Controller('v1/submissions')
export class SubmissionController {
  @Post('preview')
  preview(@Body() body: unknown) {
    return buildSubmissionPreview(body);
  }
}
