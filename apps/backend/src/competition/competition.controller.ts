import { Body, Controller, Post } from '@nestjs/common';
import { SubmissionPreviewDto } from './competition.dto';
import { DisabledCompetitionService } from './competition.service';

@Controller('v1/submissions')
export class CompetitionController {
  constructor(private readonly competition: DisabledCompetitionService) {}
  @Post('preview') preview(@Body() dto: SubmissionPreviewDto) {
    return this.competition.preview({ segmentId: dto.segment_id, videoId: dto.video_id, startMs: dto.start_ms, endMs: dto.end_ms });
  }
  @Post() submit() { return this.competition.submit(); }
}
